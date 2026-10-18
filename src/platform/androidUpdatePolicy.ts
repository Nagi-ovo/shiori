// The public release repo was renamed from shiori-releases to shiori.
// GitHub redirects the old download path, and /api/release keeps serving
// it (site/functions/_release.ts) until builds accepting both are
// everywhere. Spelled out rather than derived from RELEASES_URL so that
// updating the link cannot drop the old path. MainActivity.kt mirrors this.
const OFFICIAL_APK_PATH_PREFIXES = [
  "/Nagi-ovo/shiori-releases/releases/download/",
  "/Nagi-ovo/shiori/releases/download/",
];
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export function requireDirectAndroidSha256(value: string | null): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!SHA256_HEX.test(normalized)) {
    throw new Error("android-update-sha256-missing");
  }
  return normalized;
}

export function requireOfficialDirectAndroidUpdateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("android-update-url-not-allowed");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !OFFICIAL_APK_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ||
    !url.pathname.endsWith(".apk")
  ) {
    throw new Error("android-update-url-not-allowed");
  }
  return url.href;
}
