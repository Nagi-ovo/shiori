import type { Release } from "./_release";

export const CLI_RELEASE_SCHEMA = "shiori.cli-release/v1" as const;

export const CLI_INSTALL_TARGETS = [
  "darwin-arm64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-arm64",
  "win32-x64",
] as const;

export type CliInstallTarget = (typeof CLI_INSTALL_TARGETS)[number];

const CLI_ASSET_RE =
  /^shiori-cli-(\d+\.\d+\.\d+)-(darwin-arm64|linux-arm64-gnu|linux-x64-gnu|win32-arm64|win32-x64)\.tar\.gz$/;

export type CliTargetRelease = {
  url: string;
  sha256: string;
  size: number;
};

export type CliReleaseManifest =
  | {
      schema: typeof CLI_RELEASE_SCHEMA;
      available: false;
    }
  | {
      schema: typeof CLI_RELEASE_SCHEMA;
      available: true;
      version: string;
      targets: Partial<Record<CliInstallTarget, CliTargetRelease>>;
    };

export function parseCliAssetName(
  name: string,
): { version: string; target: CliInstallTarget } | null {
  const match = CLI_ASSET_RE.exec(name);
  if (!match) return null;
  return { version: match[1], target: match[2] as CliInstallTarget };
}

export function parseGithubSha256(digest: string | undefined): string | null {
  if (!digest) return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match ? match[1].toLowerCase() : null;
}

export function isCliInstallTarget(value: string): value is CliInstallTarget {
  return (CLI_INSTALL_TARGETS as readonly string[]).includes(value);
}

function compareCliVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function buildCliReleaseManifest(
  releases: readonly Release[],
): CliReleaseManifest {
  let version: string | null = null;
  const chosen = new Map<
    CliInstallTarget,
    { asset: CliTargetRelease; publishedAt: number }
  >();

  for (const release of releases) {
    const publishedAt = Date.parse(release.published_at ?? "");
    for (const asset of release.assets) {
      const parsed = parseCliAssetName(asset.name);
      if (!parsed) continue;
      // Checked before it can influence the version choice: an archive whose
      // digest GitHub never recorded is one we cannot verify, so it must not
      // be able to displace a lower version we can.
      const sha256 = parseGithubSha256(asset.digest);
      if (!sha256) continue;

      if (version === null || compareCliVersions(parsed.version, version) > 0) {
        version = parsed.version;
        chosen.clear();
      }
      if (parsed.version !== version) continue;

      // One CLI version can appear on more than one release: a tag that did
      // not bump the CLI uploads an identically-named archive again. Resolve
      // that by publish time rather than by position — the array order of
      // GitHub's response is not a contract, and trusting it made the OLDEST
      // release's URLs win.
      const existing = chosen.get(parsed.target);
      if (existing && !(publishedAt > existing.publishedAt)) continue;
      chosen.set(parsed.target, {
        asset: { url: asset.browser_download_url, sha256, size: asset.size },
        publishedAt,
      });
    }
  }

  if (!version || chosen.size === 0) {
    return { schema: CLI_RELEASE_SCHEMA, available: false };
  }
  const targets: Partial<Record<CliInstallTarget, CliTargetRelease>> = {};
  for (const [target, { asset }] of chosen) targets[target] = asset;
  return { schema: CLI_RELEASE_SCHEMA, available: true, version, targets };
}

export function cliManifestEnv(
  manifest: CliReleaseManifest,
  target: string,
): string {
  if (!isCliInstallTarget(target) || !manifest.available) {
    return "SHIORI_CLI_AVAILABLE=0\n";
  }
  const asset = manifest.targets[target];
  if (!asset) return "SHIORI_CLI_AVAILABLE=0\n";
  return [
    "SHIORI_CLI_AVAILABLE=1",
    `SHIORI_CLI_VERSION=${manifest.version}`,
    `SHIORI_CLI_TARGET=${target}`,
    `SHIORI_CLI_URL=${asset.url}`,
    `SHIORI_CLI_SHA256=${asset.sha256}`,
    `SHIORI_CLI_SIZE=${asset.size}`,
    "",
  ].join("\n");
}

// Rehydrates a manifest previously stored by `rememberLastGood`. The stored
// blob is our own JSON, but it is re-validated anyway: `cliManifestEnv`
// writes its fields straight into a descriptor the installers parse, so a
// truncated or half-written cache entry must fail closed rather than emit a
// descriptor with an empty URL.
export function parseCliReleaseManifest(body: string | null): CliReleaseManifest | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const candidate = parsed as Record<string, unknown>;
  if (candidate.schema !== CLI_RELEASE_SCHEMA) return null;
  if (candidate.available !== true) return null;
  if (typeof candidate.version !== "string" || !/^\d+\.\d+\.\d+$/.test(candidate.version)) {
    return null;
  }
  if (typeof candidate.targets !== "object" || candidate.targets === null) return null;

  const targets: Partial<Record<CliInstallTarget, CliTargetRelease>> = {};
  for (const [key, value] of Object.entries(candidate.targets as Record<string, unknown>)) {
    if (!isCliInstallTarget(key)) continue;
    if (typeof value !== "object" || value === null) continue;
    const asset = value as Record<string, unknown>;
    if (typeof asset.url !== "string" || !asset.url.startsWith("https://")) continue;
    if (typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) continue;
    if (typeof asset.size !== "number" || !Number.isFinite(asset.size)) continue;
    targets[key] = { url: asset.url, sha256: asset.sha256, size: asset.size };
  }
  if (Object.keys(targets).length === 0) return null;

  return {
    schema: CLI_RELEASE_SCHEMA,
    available: true,
    version: candidate.version,
    targets,
  };
}
