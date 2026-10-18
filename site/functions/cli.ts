// Cloudflare Pages Function: /cli
//
// Serves the POSIX installer with an explicit text/plain type so
// `curl -fsSL https://shiori.nagi.fun/cli | sh` does not depend on
// whatever the static-asset probe guessed for an extensionless URL.

interface PagesAssets {
  ASSETS: { fetch: (input: Request | string) => Promise<Response> };
}

export const onRequestGet: PagesFunction<PagesAssets> = async (ctx) => {
  const asset = await ctx.env.ASSETS.fetch(new URL("/cli.sh", ctx.request.url));
  if (!asset.ok) {
    return new Response("Shiori CLI installer is missing from this deploy.\n", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(asset.body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
