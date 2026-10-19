// Spelled out rather than derived from RELEASES_URL, so that a change to the
// link cannot widen what the updater installs. MainActivity.kt mirrors this.
// The repo used to be shiori-releases; this build asks /api/release for the
// current path (updater.ts), so only that one is official.
const OFFICIAL_APK_PATH_PREFIXES = ["/Nagi-ovo/shiori/releases/download/"];
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
