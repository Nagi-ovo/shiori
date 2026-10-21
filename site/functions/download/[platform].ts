// Cloudflare Pages Function: /download/<platform>
//
// 302s to the right asset on the latest GitHub Release. The indirection
// lets us print stable URLs in the marketing site without baking version
// numbers into the static bundle or republishing on every release.

import {
  ASSET_PATTERNS,
  findLatestAssetForPlatform,
  readLastGood,
  rememberLastGood,
  type Platform,
} from "../_release";

// Like /api/release and /api/downloads, each platform keeps the last
// installer URL it resolved, for when a cold cache meets a GitHub 403/5xx.
// Without it the button silently bounced back to the homepage.
const lastGoodKey = (platform: Platform) =>
  `https://shiori.internal/download/${platform}/last-good`;

export const onRequestGet: PagesFunction<unknown, "platform"> = async (
  ctx,
) => {
  const platform = String(ctx.params.platform) as Platform;
  const fallback = new URL("/#download", ctx.request.url).toString();

  if (!(platform in ASSET_PATTERNS)) {
    return Response.redirect(fallback, 302);
  }

  const match = await findLatestAssetForPlatform(ctx, platform);
  if (!match) {
    const lastGood = await readLastGood(lastGoodKey(platform));
    return Response.redirect(lastGood ?? fallback, 302);
  }

  rememberLastGood(ctx, lastGoodKey(platform), match.asset.browser_download_url);
  return Response.redirect(match.asset.browser_download_url, 302);
};
