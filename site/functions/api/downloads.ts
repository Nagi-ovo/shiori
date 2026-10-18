// Cloudflare Pages Function: /api/downloads
//
// Lifetime installer downloads across every published release, so the
// download card can show a real number instead of a claim. Same edge
// cache as /api/release, on its own key and a longer TTL — the total
// moves slowly.

import {
  countInstallerDownloads,
  DOWNLOAD_CACHE_TTL_SECONDS,
  getAllReleasesWithStatus,
  readLastGood,
  rememberLastGood,
  upstreamFailureResponse,
  type DownloadTotals,
  type ReleaseEnv,
} from "../_release";

interface DownloadsInfo extends DownloadTotals {
  releases: number;
  generatedAt: string;
}

// The last successful total is kept for a week and served when the
// upstream is unreachable (see `upstreamFailureResponse`); the count
// moves slowly enough that a week-old figure is a better answer than
// none. An empty list means the upstream fetch failed: reporting it as
// a total of 0 would render "0 downloads to date" on the homepage,
// which is worse than rendering nothing at all.
const LAST_GOOD_KEY = "https://shiori.internal/api/downloads/last-good";

export const onRequestGet: PagesFunction<ReleaseEnv> = async (ctx) => {
  const { releases, upstreamStatus } = await getAllReleasesWithStatus(ctx);
  if (releases.length === 0) {
    return upstreamFailureResponse(await readLastGood(LAST_GOOD_KEY), upstreamStatus, {
      maxAgeSeconds: DOWNLOAD_CACHE_TTL_SECONDS,
      staleHeader: "X-Downloads-Stale",
      cors: corsHeaders,
    });
  }

  const payload: DownloadsInfo = {
    ...countInstallerDownloads(releases),
    releases: releases.length,
    generatedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  rememberLastGood(ctx, LAST_GOOD_KEY, body);

  return new Response(body, {
    headers: {
      ...corsHeaders("application/json"),
      "Cache-Control": `public, max-age=${DOWNLOAD_CACHE_TTL_SECONDS}`,
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
    Vary: "Origin",
  };
}
