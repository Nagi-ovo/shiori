import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, rm } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUPPORTED_CLI_TARGETS,
  AUDITED_BUN_VERSION,
  AUDITED_FONTKIT_SHA256,
  AUDITED_LICENSE_TREE_SHA256,
  AUDITED_NOTO_JP_SHA256,
  AUDITED_NOTO_SC_SHA256,
  assertSeaBuildNodeVersion,
  cliTargetName,
  distributionFiles,
  type DistributionFile,
} from "./build";
import { regularFileModeIfExists } from "./src/atomicOutput";
import packageJson from "./package.json" with { type: "json" };

type DistributionManifest = {
  schema: "shiori.cli-distribution/v2";
  name: string;
  version: string;
  target: string;
  runtime: string;
  bundler: string;
  executable: string;
  assets: "assets/";
  audits: {
    fontkitSha256: string;
    notoSansScSha256: string;
    notoSansJpSha256: string;
    licenseTreeSha256: string;
  };
  files: DistributionFile[];
};

const CLI_ROOT = dirname(fileURLToPath(import.meta.url));
const supportedTargets = new Set<string>(SUPPORTED_CLI_TARGETS);

/**
 * Recompute only an existing package's file inventory. This is deliberately
 * separate from the build command so platform signing can modify binaries and
 * then refresh hashes without rebuilding or deleting any signed artifact.
 */
export async function refreshDistributionManifest(
  outputDir: string,
  expectedTarget?: string,
): Promise<string> {
  const manifestPath = join(outputDir, "manifest.json");
  const existing = parseManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    expectedTarget,
  );
  await assertNoStaleManifestTemps(outputDir, basename(manifestPath));
  // Inventory first: the same-directory temporary manifest must never list
  // itself, and distributionFiles deliberately excludes manifest.json.
  const tempPrefix = `.${basename(manifestPath)}.shiori-tmp-`;
  const files = await distributionFiles(outputDir, {
    // A concurrent refresh may create its temp after our stale check. Never
    // hash another refresh's partial/ephemeral manifest into the package.
    exclude: (path) => !path.includes("/") && path.startsWith(tempPrefix),
  });
  const next: DistributionManifest = { ...existing, files };
  const tempPath = join(
    outputDir,
    `.${basename(manifestPath)}.shiori-tmp-${process.pid}-${randomUUID()}`,
  );
  const mode = await regularFileModeIfExists(manifestPath);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", mode ?? 0o666);
    if (mode != null && process.platform !== "win32") {
      await handle.chmod(mode);
    }
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, manifestPath);
    await syncDirectoryEntry(outputDir);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  return manifestPath;
}

function parseManifest(
  value: unknown,
  expectedTarget?: string,
): DistributionManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Existing CLI distribution manifest is not an object");
  }
  const manifest = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "schema",
    "name",
    "version",
    "target",
    "runtime",
    "bundler",
    "executable",
    "assets",
    "audits",
    "files",
  ]);
  if (Object.keys(manifest).some((key) => !allowedKeys.has(key))) {
    throw new Error("Existing CLI distribution manifest has unknown fields");
  }
  if (manifest.schema !== "shiori.cli-distribution/v2") {
    throw new Error("Existing CLI distribution manifest has an invalid schema");
  }
  if (manifest.name !== packageJson.name) {
    throw new Error("Existing CLI distribution manifest has an invalid name");
  }
  if (manifest.version !== packageJson.version) {
    throw new Error("Existing CLI distribution manifest has an invalid version");
  }
  if (
    typeof manifest.target !== "string" ||
    !supportedTargets.has(manifest.target) ||
    (expectedTarget != null && manifest.target !== expectedTarget)
  ) {
    throw new Error("Existing CLI distribution manifest has an invalid target");
  }
  const runtimeMatch =
    typeof manifest.runtime === "string"
      ? manifest.runtime.match(/^node v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)
      : null;
  if (!runtimeMatch) {
    throw new Error("Existing CLI distribution manifest has an invalid runtime");
  }
  assertSeaBuildNodeVersion(runtimeMatch[1]!);
  if (manifest.bundler !== `bun ${AUDITED_BUN_VERSION}`) {
    throw new Error("Existing CLI distribution manifest has an invalid bundler");
  }
  const expectedExecutable = manifest.target.startsWith("win32-")
    ? "shiori.exe"
    : "shiori";
  if (manifest.executable !== expectedExecutable) {
    throw new Error("Existing CLI distribution manifest has an invalid executable");
  }
  if (manifest.assets !== "assets/") {
    throw new Error("Existing CLI distribution manifest has an invalid assets path");
  }
  if (!isObject(manifest.audits)) {
    throw new Error("Existing CLI distribution manifest has invalid audits");
  }
  const expectedAudits: DistributionManifest["audits"] = {
    fontkitSha256: AUDITED_FONTKIT_SHA256,
    notoSansScSha256: AUDITED_NOTO_SC_SHA256,
    notoSansJpSha256: AUDITED_NOTO_JP_SHA256,
    licenseTreeSha256: AUDITED_LICENSE_TREE_SHA256,
  };
  if (
    Object.keys(manifest.audits).length !== Object.keys(expectedAudits).length ||
    Object.entries(expectedAudits).some(
      ([key, expected]) => manifest.audits[key] !== expected,
    )
  ) {
    throw new Error("Existing CLI distribution manifest has invalid audits");
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("Existing CLI distribution manifest has no file inventory");
  }
  return manifest as DistributionManifest;
}

async function assertNoStaleManifestTemps(
  outputDir: string,
  manifestName: string,
): Promise<void> {
  const prefix = `.${manifestName}.shiori-tmp-`;
  const stale = (await readdir(outputDir)).filter((name) =>
    name.startsWith(prefix),
  );
  if (stale.length > 0) {
    throw new Error(
      `CLI distribution contains a stale manifest temp; verify and remove it before refreshing: ${stale.join(", ")}`,
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function syncDirectoryEntry(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The manifest contents were already fsynced; directory fsync is advisory.
  }
}

function requestedTarget(args: string[]): string {
  if (args.length === 0) return cliTargetName(platform(), arch());
  if (args.length !== 2 || args[0] !== "--target" || !args[1]) {
    throw new Error("Usage: bun run cli:manifest [--target current|<target>]");
  }
  return args[1] === "current"
    ? cliTargetName(platform(), arch())
    : args[1];
}

async function main(): Promise<void> {
  const target = requestedTarget(process.argv.slice(2));
  if (!supportedTargets.has(target)) {
    throw new Error(`Unsupported CLI target: ${target}`);
  }
  const outputDir = join(CLI_ROOT, "dist", target);
  console.log(await refreshDistributionManifest(outputDir, target));
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
