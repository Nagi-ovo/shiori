export const CLI_INSTALL_CURL = "curl -fsSL https://shiori.nagi.fun/cli | sh";
export const CLI_INSTALL_POWERSHELL = "irm https://shiori.nagi.fun/cli.ps1 | iex";
export const CLI_INSTALL_NPM = "npm install -g @nagi-ovo/shiori";
export const CLI_NPM_PACKAGE = "@nagi-ovo/shiori";
export const CLI_RELEASE_API = "https://shiori.nagi.fun/api/cli";
export const CLI_RELEASE_SCHEMA = "shiori.cli-release/v1" as const;

export const SUPPORTED_CLI_INSTALL_TARGETS = [
  "darwin-arm64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-arm64",
  "win32-x64",
] as const;

export type CliInstallTarget = (typeof SUPPORTED_CLI_INSTALL_TARGETS)[number];

const TARGETS = new Set<string>(SUPPORTED_CLI_INSTALL_TARGETS);
const CLI_ASSET_RE =
  /^shiori-cli-(\d+\.\d+\.\d+)-(darwin-arm64|linux-arm64-gnu|linux-x64-gnu|win32-arm64|win32-x64)\.tar\.gz$/;

export function isCliInstallTarget(value: string): value is CliInstallTarget {
  return TARGETS.has(value);
}

export function parseCliAssetName(
  name: string,
): { version: string; target: CliInstallTarget } | null {
  const match = CLI_ASSET_RE.exec(name);
  if (!match) return null;
  return { version: match[1], target: match[2] as CliInstallTarget };
}

export function cliArchiveName(version: string, target: CliInstallTarget): string {
  return `shiori-cli-${version}-${target}.tar.gz`;
}

export function compareCliVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function detectCliInstallTarget(
  operatingSystem: string,
  architecture: string,
): CliInstallTarget | null {
  const os = operatingSystem.toLowerCase();
  const arch = architecture.toLowerCase();
  if (os === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : null;
  }
  if (os === "linux") {
    if (arch === "x64" || arch === "x86_64" || arch === "amd64") {
      return "linux-x64-gnu";
    }
    if (arch === "arm64" || arch === "aarch64") return "linux-arm64-gnu";
    return null;
  }
  if (os === "win32" || os.startsWith("mingw") || os.startsWith("msys") || os.startsWith("cygwin")) {
    if (arch === "arm64" || arch === "aarch64") return "win32-arm64";
    if (arch === "x64" || arch === "x86_64" || arch === "amd64") return "win32-x64";
  }
  return null;
}

export function parseGithubSha256(digest: string | undefined): string | null {
  if (!digest) return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match ? match[1].toLowerCase() : null;
}
