import {
  buildCliReleaseManifest,
  cliManifestEnv,
  parseCliReleaseManifest,
  type CliReleaseManifest,
} from "../_cliRelease";
import {
  CACHE_TTL_SECONDS,
  getAllReleasesForCli,
  readLastGood,
  rememberLastGood,
  upstreamFailureResponse,
  type ReleaseEnv,
} from "../_release";

const LAST_GOOD_KEY = "https://shiori.internal/api/cli/last-good";

export const onRequestGet: PagesFunction<ReleaseEnv> = async (ctx) => {
  const requestUrl = new URL(ctx.request.url);
  // Read the format up front. The upstream-failure path below used to run
  // before this and always answered in JSON, so a GitHub outage fed `{` to
  // the POSIX installer's descriptor parser and it reported "Unexpected
  // field in release descriptor" — an outage disguised as a corrupt release.
  const wantsEnv = requestUrl.searchParams.get("format") === "env";
  const target = requestUrl.searchParams.get("target") ?? "";

  // Every release, not the recent-ten window /download/* uses: the CLI has
  // its own tag namespace and would age out of that window after ten app
  // releases, turning a published CLI back into available:false. Its own
  // cache entry too, so a fresh publish is installable in minutes rather
  // than inheriting the download totals' half-hour TTL.
  const { releases, upstreamStatus } = await getAllReleasesForCli(ctx);

  if (releases.length === 0) {
    const lastGood = await readLastGood(LAST_GOOD_KEY);
    if (!wantsEnv) {
      return upstreamFailureResponse(lastGood, upstreamStatus, {
        maxAgeSeconds: CACHE_TTL_SECONDS,
        staleHeader: "X-Cli-Release-Stale",
        cors: corsHeaders,
      });
    }
    // An installer mid-run cares about one thing: can it install. A cached
    // manifest still answers that, so serve it rather than failing the run.
    const cached = parseCliReleaseManifest(lastGood);
    if (cached) {
      return envResponse(cliManifestEnv(cached, target), {
        "X-Upstream-Status": String(upstreamStatus ?? "none"),
        "X-Cli-Release-Stale": "1",
      });
    }
    // Deliberately NOT `SHIORI_CLI_AVAILABLE=0` with a 200: that is the
    // wire form of "no archive published yet", and an outage is a different
    // thing the installer should report differently.
    return new Response("Shiori release API is unavailable.\n", {
      status: 503,
      headers: {
        ...corsHeaders("text/plain; charset=utf-8"),
        "X-Upstream-Status": String(upstreamStatus ?? "none"),
      },
    });
  }

  const manifest = buildCliReleaseManifest(releases);
  // Store the last-good manifest whichever format was asked for, so a curl
  // install warms the cache that a later install reads during an outage.
  if (manifest.available) rememberLastGood(ctx, LAST_GOOD_KEY, JSON.stringify(manifest));

  if (wantsEnv) return envResponse(cliManifestEnv(manifest, target));
  return jsonResponse(manifest);
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

function envResponse(body: string, extraHeaders: HeadersInit = {}): Response {
  return new Response(body, {
    headers: {
      ...corsHeaders("text/plain; charset=utf-8"),
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      ...extraHeaders,
    },
  });
}

function jsonResponse(manifest: CliReleaseManifest): Response {
  return new Response(JSON.stringify(manifest), {
    headers: {
      ...corsHeaders("application/json"),
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
}

function corsHeaders(contentType: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    Vary: "Origin",
  };
}
