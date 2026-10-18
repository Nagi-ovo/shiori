import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const CLI_RELEASE_API = "https://shiori.nagi.fun/api/cli";
export const CLI_RELEASE_SCHEMA = "shiori.cli-release/v1";

const TARGETS = new Set([
  "darwin-arm64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-arm64",
  "win32-x64",
]);

export function detectCliInstallTarget(operatingSystem, architecture) {
  const os = String(operatingSystem).toLowerCase();
  const arch = String(architecture).toLowerCase();
  if (os === "darwin") return arch === "arm64" ? "darwin-arm64" : null;
  if (os === "linux") {
    if (arch === "x64" || arch === "x86_64" || arch === "amd64") {
      return "linux-x64-gnu";
    }
    if (arch === "arm64" || arch === "aarch64") return "linux-arm64-gnu";
    return null;
  }
  if (
    os === "win32" ||
    os.startsWith("mingw") ||
    os.startsWith("msys") ||
    os.startsWith("cygwin")
  ) {
    if (arch === "arm64" || arch === "aarch64") return "win32-arm64";
    if (arch === "x64" || arch === "x86_64" || arch === "amd64") return "win32-x64";
  }
  return null;
}

export function isAllowedDownloadUrl(url, env = process.env) {
  if (typeof url !== "string") return false;
  if (url.startsWith("https://")) return true;
  return (
    env.SHIORI_CLI_ALLOW_HTTP === "1" &&
    /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)
  );
}

export function resolveInstallHome(env = process.env) {
  return env.SHIORI_CLI_HOME?.trim() || join(homedir(), ".shiori");
}

export function executableName(target) {
  return target.startsWith("win32") ? "shiori.exe" : "shiori";
}

export function cachedBinaryPath(home, version, target) {
  return join(home, "cli", version, executableName(target));
}

export async function fetchCliManifest(api = CLI_RELEASE_API) {
  const response = await fetch(api, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Shiori CLI release API returned ${response.status}`);
  }
  const manifest = await response.json();
  if (manifest?.schema !== CLI_RELEASE_SCHEMA) {
    throw new Error("Shiori CLI release descriptor is malformed");
  }
  return manifest;
}

export async function ensureCliBinary(options = {}) {
  const target =
    options.target ?? detectCliInstallTarget(process.platform, process.arch);
  if (!target || !TARGETS.has(target)) {
    throw new Error(
      "This platform is not a Shiori CLI release target. Apple Silicon macOS, glibc Linux, and 64-bit Windows are supported.",
    );
  }
  const manifest = options.manifest ?? (await fetchCliManifest(options.api));
  if (!manifest.available) {
    throw new Error(
      "Shiori CLI is not on the download channel yet. The installer is ready; no archive has been published.",
    );
  }
  const asset = manifest.targets?.[target];
  if (
    !isAllowedDownloadUrl(asset?.url, options.env) ||
    !/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")
  ) {
    throw new Error(`No Shiori CLI archive is published for ${target}`);
  }
  const home = resolveInstallHome(options.env);
  const binary = cachedBinaryPath(home, manifest.version, target);
  if (existsSync(binary)) return binary;

  const dest = join(home, "cli", manifest.version);
  mkdirSync(dest, { recursive: true });
  const archive = join(
    tmpdir(),
    `shiori-cli-${manifest.version}-${target}.tar.gz`,
  );
  const bytes = Buffer.from(await (await fetch(asset.url)).arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error("Archive digest mismatch");
  }
  writeFileSync(archive, bytes);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", dest], {
    encoding: "utf8",
  });
  rmSync(archive, { force: true });
  if (extracted.status !== 0) {
    throw new Error(extracted.stderr || "Could not extract Shiori CLI");
  }
  if (!existsSync(binary)) {
    throw new Error("Archive did not contain the Shiori CLI executable");
  }
  if (!target.startsWith("win32")) chmodSync(binary, 0o755);
  return binary;
}

export async function run(argv, options = {}) {
  const binary = await ensureCliBinary(options);
  const result = spawnSync(binary, argv, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
