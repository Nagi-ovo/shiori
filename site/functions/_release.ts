// Shared helper for the /download/* and /api/release Pages Functions.
//
// Both routes need the same thing: the latest release from
// Nagi-ovo/shiori, with its asset list. Hitting the GitHub API
// per request would burn through the 60 req/hr/IP anonymous limit on
// any traffic spike, so the response gets cached at the edge for 5
// minutes. New releases become discoverable within that TTL without
// manual cache invalidation.

import { parseGithubSha256 } from "./_cliRelease";

// `/releases/latest` returns 404 when every release is marked as
// prerelease — which is the case for the beta cohort. Listing
// `/releases` covers prerelease and stable releases uniformly. We keep
// several releases because mobile and desktop artifacts can be published
// from separate CI runs; a single latest release may not contain every
// platform's asset.
//
// Releases live in Nagi-ovo/shiori, which used to be Nagi-ovo/shiori-releases;
// the old name still redirects, but naming the repo directly saves the 301.
const RELEASES_API =
  "https://api.github.com/repos/Nagi-ovo/shiori/releases?per_page=10";

// Every release ever published, for the lifetime download total. GitHub
// caps a page at 100, which still covers every release. Revisit once it
// stops being true.
const ALL_RELEASES_API =
  "https://api.github.com/repos/Nagi-ovo/shiori/releases?per_page=100";

export const CACHE_TTL_SECONDS = 300;

export const DOWNLOAD_CACHE_TTL_SECONDS = 1800;

// Own cache entry for /api/cli over the same upstream as the download
// totals; see getAllReleasesForCli.
const CLI_RELEASES_CACHE_KEY = "https://shiori.internal/api/cli/all-releases";

// How long a handler keeps its last successful payload around to serve
// when the upstream is unreachable. See `upstreamFailureResponse`.
export const LAST_GOOD_TTL_SECONDS = 604800;

// Bindings a Pages Function may find on `ctx.env`. `GITHUB_TOKEN` is a
// fine-grained PAT with read-only access to public repositories, set as
// a secret on the Pages project (`wrangler pages secret put GITHUB_TOKEN
// --project-name shiori-promotion`). Without it every request from a
// colo shares that colo's anonymous 60 req/hr quota with every other
// Worker egressing from the same IP; on busy colos that quota is gone
// before we ever get a turn, so a cold cache there fails on every
// request — which is how the Android updater 502'd for a whole cohort
// while desktop, which reads a static manifest, never noticed.
export interface ReleaseEnv {
  GITHUB_TOKEN?: string;
}

export type ReleaseContext = EventContext<ReleaseEnv, string, unknown>;

// Headers for one api.github.com request. GitHub returns 403 to
// anonymous requests without a User-Agent, and the bearer token lifts
// the request onto the token's own 5000 req/hr budget instead of the
// shared egress IP's.
export function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "shiori-site-pages-function",
    Accept: "application/vnd.github+json",
  };
  const trimmed = token?.trim();
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`;
  return headers;
}

// Files starting with `_` are never treated as Pages routes by the CF
// build, which is why this helper lives next to (rather than inside)
// the routed handlers.

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string;
  download_count: number;
}

export interface Release {
  tag_name: string;
  published_at: string;
  assets: ReleaseAsset[];
}

export type Platform =
  | "mac-silicon"
  | "mac-intel"
  | "windows"
  | "linux-appimage"
  | "linux-deb"
  | "android";

// Apple Silicon gets the smaller native arm64 dmg; Intel falls back to
// the universal dmg because a pure aarch64 binary won't run on x86_64.
// build-signed.sh produces both side-by-side.
export const ASSET_PATTERNS: Record<Platform, RegExp> = {
  "mac-silicon": /_aarch64\.dmg$/,
  "mac-intel": /_universal\.dmg$/,
  windows: /_x64_en-US\.msi$/,
  "linux-appimage": /_amd64\.AppImage$/,
  "linux-deb": /_amd64\.deb$/,
  android: /\.apk$/i,
};

export async function getLatestRelease(
  ctx: ReleaseContext,
): Promise<Release | null> {
  const releases = await getRecentReleases(ctx);
  return releases[0] ?? null;
}

export async function getRecentReleases(
  ctx: ReleaseContext,
): Promise<Release[]> {
  return fetchReleasesCached(ctx, RELEASES_API, CACHE_TTL_SECONDS);
}

// As getRecentReleases, but reports the upstream status so a handler can
// put it on its failure response instead of needing a local repro.
export async function getRecentReleasesWithStatus(
  ctx: ReleaseContext,
): Promise<{ releases: Release[]; upstreamStatus: number | null }> {
  return fetchReleasesCached(ctx, RELEASES_API, CACHE_TTL_SECONDS, true);
}

// Lifetime download totals have to see every release, not just the
// recent window /download/* resolves assets from. Own URL, so own cache
// key, and a longer TTL: the number moves slowly and no download is
// blocked on it.
export async function getAllReleases(
  ctx: ReleaseContext,
): Promise<Release[]> {
  return (await getAllReleasesWithStatus(ctx)).releases;
}

/**
 * As getAllReleases, but reports what the upstream said. api.github.com
 * rate-limits anonymously per IP, and a Pages Function egresses from an
 * IP it shares with everything else on that edge — so a cold cache can
 * genuinely get a 403 and it is worth being able to see that from the
 * response rather than reproducing it.
 */
export async function getAllReleasesWithStatus(
  ctx: ReleaseContext,
): Promise<{ releases: Release[]; upstreamStatus: number | null }> {
  return fetchReleasesCached(ctx, ALL_RELEASES_API, DOWNLOAD_CACHE_TTL_SECONDS, true);
}

/**
 * Every release, cached for CACHE_TTL_SECONDS rather than the half hour the
 * download totals use. /api/cli needs the wide window — the CLI has its own
 * cli-v tag namespace and would age out of the recent-ten one — but it must
 * not inherit that TTL: a freshly published CLI was invisible to the
 * installers for up to 30 minutes, which reads exactly like a broken
 * release. A download count may be half an hour stale; whether a thing can
 * be installed may not.
 */
export async function getAllReleasesForCli(
  ctx: ReleaseContext,
): Promise<{ releases: Release[]; upstreamStatus: number | null }> {
  return fetchReleasesCached(ctx, ALL_RELEASES_API, CACHE_TTL_SECONDS, true, CLI_RELEASES_CACHE_KEY);
}

async function fetchReleasesCached(
  ctx: ReleaseContext,
  api: string,
  ttlSeconds: number,
  withStatus: true,
  cacheKeyUrl?: string,
): Promise<{ releases: Release[]; upstreamStatus: number | null }>;
async function fetchReleasesCached(
  ctx: ReleaseContext,
  api: string,
  ttlSeconds: number,
): Promise<Release[]>;
async function fetchReleasesCached(
  ctx: ReleaseContext,
  api: string,
  ttlSeconds: number,
  withStatus = false,
  cacheKeyUrl?: string,
): Promise<Release[] | { releases: Release[]; upstreamStatus: number | null }> {
  const wrap = (releases: Release[], upstreamStatus: number | null) =>
    withStatus ? { releases, upstreamStatus } : releases;
  // The cache key is normally the upstream URL. Callers that want the same
  // upstream on a different TTL pass their own key instead of sharing one.
  const cacheKey = new Request(cacheKeyUrl ?? api, { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedValue = (await cached.json()) as Release[] | Release | null;
    return wrap(
      Array.isArray(cachedValue)
        ? cachedValue
        : cachedValue
          ? [cachedValue]
          : [],
      null,
    );
  }

  const upstream = await fetch(api, {
    headers: githubHeaders(ctx.env?.GITHUB_TOKEN),
  });
  if (!upstream.ok) {
    return wrap([], upstream.status);
  }
  const list = (await upstream.json()) as Release[];

  // waitUntil persists the cache entry in the background so the user
  // gets their response immediately.
  const cacheable = new Response(JSON.stringify(list), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttlSeconds}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheable));

  return wrap(list, upstream.status);
}

// A download only counts when a person installed something. Tauri's
// updater pulls the macOS .app.tar.gz on every accepted update and every
// client fetches the .sig on every check, so counting those roughly
// doubles the headline with machine traffic — 307 of the 678 raw asset
// downloads at the time of writing. Match .sig first: .AppImage.sig
// would otherwise fall through to the Linux installer pattern.
const UPDATER_ASSET = /(\.sig|\.app\.tar\.gz)$/;

const INSTALLER_PLATFORMS: ReadonlyArray<
  readonly [RegExp, DownloadPlatform]
> = [
  [/\.dmg$/, "macos"],
  [/\.msi$/, "windows"],
  [/\.(AppImage|deb)$/, "linux"],
  [/\.apk$/i, "android"],
];

export type DownloadPlatform = "macos" | "windows" | "linux" | "android";

export interface DownloadTotals {
  total: number;
  byPlatform: Record<DownloadPlatform, number>;
}

// macOS reads low here by design: a Mac user downloads the .dmg once and
// every later version arrives through the updater tarball, which this
// deliberately does not count.
export function countInstallerDownloads(releases: Release[]): DownloadTotals {
  const byPlatform: Record<DownloadPlatform, number> = {
    macos: 0,
    windows: 0,
    linux: 0,
    android: 0,
  };
  let total = 0;

  for (const release of releases) {
    for (const asset of release.assets) {
      if (UPDATER_ASSET.test(asset.name)) continue;
      const match = INSTALLER_PLATFORMS.find(([pattern]) =>
        pattern.test(asset.name),
      );
      if (!match) continue;
      byPlatform[match[1]] += asset.download_count;
      total += asset.download_count;
    }
  }

  return { total, byPlatform };
}

export function findAsset(
  release: Release,
  platform: Platform,
): ReleaseAsset | undefined {
  return release.assets.find((a) => ASSET_PATTERNS[platform].test(a.name));
}

export async function findLatestAssetForPlatform(
  ctx: ReleaseContext,
  platform: Platform,
): Promise<{ release: Release; asset: ReleaseAsset } | null> {
  const releases = await getRecentReleases(ctx);
  for (const release of releases) {
    const asset = findAsset(release, platform);
    if (asset) return { release, asset };
  }
  return null;
}

// --- Upstream-failure fallback -------------------------------------------
//
// A Pages Function egresses from an IP it shares with the rest of that
// edge, and api.github.com rate-limits anonymous requests per IP — so a
// cold cache really does get a 403 sometimes, and on busy colos every
// time. Each handler keeps its last successful payload for a week under
// its own key and serves it when the upstream is unreachable. Only when
// there is no last-good value either does it 502; the caller decides
// what that means (no number on the homepage, "check failed" in the
// Android updater), but never a made-up payload.

export async function readLastGood(key: string): Promise<string | null> {
  const hit = await caches.default.match(new Request(key));
  return hit ? hit.text() : null;
}

export function rememberLastGood(
  ctx: ReleaseContext,
  key: string,
  body: string,
): void {
  ctx.waitUntil(
    caches.default.put(
      new Request(key),
      new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${LAST_GOOD_TTL_SECONDS}`,
        },
      }),
    ),
  );
}

export interface UpstreamFailureOptions {
  // Cache-Control max-age for the stale response, so the edge does not
  // re-run the failing upstream fetch on every request.
  maxAgeSeconds: number;
  // Header that marks the payload as stale, e.g. "X-Release-Stale".
  staleHeader: string;
  cors: (contentType: string) => HeadersInit;
}

// Pure: given whatever last-good payload exists and what the upstream
// said, build the response. Both /api/release and /api/downloads route
// their failure path through here so the behaviour cannot drift again.
export function upstreamFailureResponse(
  lastGoodBody: string | null,
  upstreamStatus: number | null,
  opts: UpstreamFailureOptions,
): Response {
  const status = String(upstreamStatus ?? "none");
  if (lastGoodBody !== null) {
    return new Response(lastGoodBody, {
      headers: {
        ...opts.cors("application/json"),
        "Cache-Control": `public, max-age=${opts.maxAgeSeconds}`,
        "X-Upstream-Status": status,
        [opts.staleHeader]: "1",
      },
    });
  }
  return new Response("Upstream unavailable", {
    status: 502,
    headers: {
      ...opts.cors("text/plain; charset=utf-8"),
      "X-Upstream-Status": status,
    },
  });
}

// --- /api/release payload ------------------------------------------------

export interface PlatformInfo {
  filename: string;
  version: string;
  publishedAt: string;
  size: number;
  url: string;
  sha256?: string;
}

export interface ReleaseInfo {
  version: string;
  publishedAt: string;
  platforms: Partial<Record<Platform, PlatformInfo>>;
}

// Direct-APK builds up to 26.9.27 refuse any APK URL outside the
// shiori-releases download path. The repo is now Nagi-ovo/shiori and GitHub
// returns asset URLs under that name, redirecting the old ones, so for those
// builds the Android URL is written back to the old form. Later builds ask
// with `?apkRepo=shiori` (src/platform/updater.ts) and accept only the
// current path. Delete this rewrite once 26.9.27 and older no longer need to
// self-update; they would then have to be updated by hand.
const RENAMED_DOWNLOAD_PREFIX = "https://github.com/Nagi-ovo/shiori/releases/download/";
const LEGACY_DOWNLOAD_PREFIX = "https://github.com/Nagi-ovo/shiori-releases/releases/download/";

export function wantsLegacyApkPath(requestUrl: string): boolean {
  return new URL(requestUrl).searchParams.get("apkRepo") !== "shiori";
}

function legacyApkDownloadUrl(url: string): string {
  return url.startsWith(RENAMED_DOWNLOAD_PREFIX)
    ? LEGACY_DOWNLOAD_PREFIX + url.slice(RENAMED_DOWNLOAD_PREFIX.length)
    : url;
}

// Pure: the /api/release payload for a recent-releases window, newest
// first. Each platform resolves to its newest release that actually
// carries an asset for it, because mobile and desktop artifacts can be
// published from separate CI runs. Null when the window is empty, which
// only happens when the upstream fetch failed.
export function buildReleaseInfo(
  releases: Release[],
  { legacyApkPath = true }: { legacyApkPath?: boolean } = {},
): ReleaseInfo | null {
  const release = releases[0];
  if (!release) return null;

  const platforms: Partial<Record<Platform, PlatformInfo>> = {};
  for (const platform of Object.keys(ASSET_PATTERNS) as Platform[]) {
    const match = releases
      .map((candidate) => ({
        release: candidate,
        asset: findAsset(candidate, platform),
      }))
      .find((candidate) => candidate.asset);
    if (match?.asset) {
      // The Android updater refuses an APK whose hash it cannot check, so
      // a malformed digest is left out rather than passed along.
      const sha256 = parseGithubSha256(match.asset.digest);
      platforms[platform] = {
        filename: match.asset.name,
        version: match.release.tag_name.replace(/^v/, ""),
        publishedAt: match.release.published_at,
        size: match.asset.size,
        url:
          platform === "android" && legacyApkPath
            ? legacyApkDownloadUrl(match.asset.browser_download_url)
            : match.asset.browser_download_url,
        ...(sha256 ? { sha256 } : {}),
      };
    }
  }

  // Strip leading "v" so the client can render the version without
  // massaging the tag.
  return {
    version: release.tag_name.replace(/^v/, ""),
    publishedAt: release.published_at,
    platforms,
  };
}
