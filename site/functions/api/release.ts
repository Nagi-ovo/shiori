// Cloudflare Pages Function: /api/release
//
// Returns the latest release's per-platform asset metadata as JSON, so
// the homepage download card can render real file sizes (and current
// version) without baking them into the static bundle, and so the
// direct-APK Android build can discover its own update. Same edge cache
// as /download/*.
//
// This route is the Android updater's only source of truth — desktop
// reads a static manifest on updates.shiori.nagi.fun and never touches
// api.github.com — so a failure here surfaces to users as
// "release-check-failed-<status>". Hence the last-good fallback below.

import {
  buildReleaseInfo,
  CACHE_TTL_SECONDS,
  getRecentReleasesWithStatus,
  readLastGood,
  rememberLastGood,
  upstreamFailureResponse,
  wantsLegacyApkPath,
  type ReleaseEnv,
} from "../_release";

const LAST_GOOD_KEY = "https://shiori.internal/api/release/last-good";

export const onRequestGet: PagesFunction<ReleaseEnv> = async (ctx) => {
  // One fetch, reused for both the headline version and per-platform assets,
  // so a cold cache can't double-hit GitHub or return a version whose
  // platforms were resolved from a different fetch.
  const { releases, upstreamStatus } = await getRecentReleasesWithStatus(ctx);
  const legacyApkPath = wantsLegacyApkPath(ctx.request.url);
  const payload = buildReleaseInfo(releases, { legacyApkPath });
  // Each APK path keeps its own fallback, so neither kind of build is handed
  // a URL it refuses.
  const lastGoodKey = legacyApkPath ? LAST_GOOD_KEY : `${LAST_GOOD_KEY}?apkRepo=shiori`;
  if (!payload) {
    return upstreamFailureResponse(await readLastGood(lastGoodKey), upstreamStatus, {
      maxAgeSeconds: CACHE_TTL_SECONDS,
      staleHeader: "X-Release-Stale",
      cors: corsHeaders,
    });
  }

  const body = JSON.stringify(payload);
  rememberLastGood(ctx, lastGoodKey, body);

  return new Response(body, {
    headers: {
      ...corsHeaders("application/json"),
      // Same TTL the upstream cache uses, so the browser respects what
      // the edge already settled on.
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
};

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders("text/plain; charset=utf-8"),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });

function corsHeaders(contentType: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Vary": "Origin",
  };
}
