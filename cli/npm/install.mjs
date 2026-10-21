import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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

// Written into the staging directory last, so a version directory carrying
// it was extracted whole before it was renamed into place.
const INSTALL_COMPLETE_MARKER = ".shiori-install-complete";

function isCompleteInstall(dir, target) {
  if (!existsSync(join(dir, executableName(target)))) return false;
  if (existsSync(join(dir, INSTALL_COMPLETE_MARKER))) return true;
  // The curl and PowerShell installers extract into the same directory
  // without the marker. Theirs is complete when every file the package's
  // manifest lists is there at its full size: tar stopped part way leaves
  // the file it was writing short and the ones after it missing.
  try {
    const { files } = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    return (
      Array.isArray(files) &&
      files.length > 0 &&
      files.every(
        (file) =>
          typeof file?.path === "string" &&
          statSync(join(dir, file.path)).size === file.size,
      )
    );
  } catch {
    return false;
  }
}

function publishInstall(staging, dest, target) {
  try {
    renameSync(staging, dest);
    return;
  } catch (error) {
    // Another run got there first, or an older runner left a partial tree.
    if (isCompleteInstall(dest, target)) return;
  }
  rmSync(dest, { recursive: true, force: true });
  try {
    renameSync(staging, dest);
  } catch (error) {
    if (!isCompleteInstall(dest, target)) throw error;
  }
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
  const dest = join(home, "cli", manifest.version);
  if (isCompleteInstall(dest, target)) return binary;

  const bytes = Buffer.from(await (await fetch(asset.url)).arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error("Archive digest mismatch");
  }
  // The verified bytes go straight into tar, and tar writes into a private
  // directory beside the destination: nothing passes through a shared temp
  // path, and the version directory only appears once it is whole.
  mkdirSync(join(home, "cli"), { recursive: true });
  const staging = mkdtempSync(join(home, "cli", `.${manifest.version}-staging-`));
  try {
    const extracted = spawnSync("tar", ["-xzf", "-", "-C", staging], {
      encoding: "utf8",
      input: bytes,
    });
    if (extracted.error) throw extracted.error;
    if (extracted.status !== 0) {
      throw new Error(extracted.stderr || "Could not extract Shiori CLI");
    }
    const staged = join(staging, executableName(target));
    if (!existsSync(staged)) {
      throw new Error("Archive did not contain the Shiori CLI executable");
    }
    if (!target.startsWith("win32")) chmodSync(staged, 0o755);
    writeFileSync(join(staging, INSTALL_COMPLETE_MARKER), "");
    publishInstall(staging, dest, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return binary;
}

export async function run(argv, options = {}) {
  const binary = await ensureCliBinary(options);
  const result = spawnSync(binary, argv, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
