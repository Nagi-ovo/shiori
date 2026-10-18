import type { Dict } from "./i18n/dict";
import type { Platform } from "./platform";
import type { ReleasePlatform } from "./release/context";

export type DownloadKey =
  | "macSilicon"
  | "macIntel"
  | "windows"
  | "linuxAppImage"
  | "linuxDeb"
  | "androidPlay"
  | "androidApk"
  | "ios";

export type DownloadKind = "download" | "store" | "comingSoon";

export type DownloadTarget = {
  key: DownloadKey;
  releaseKey?: ReleasePlatform;
  href?: string;
  ext: string;
  kind: DownloadKind;
};

export const DOWNLOAD_TARGETS: ReadonlyArray<DownloadTarget> = [
  {
    key: "macSilicon",
    releaseKey: "mac-silicon",
    href: "/download/mac-silicon",
    ext: "DMG",
    kind: "download",
  },
  {
    key: "macIntel",
    releaseKey: "mac-intel",
    href: "/download/mac-intel",
    ext: "DMG",
    kind: "download",
  },
  {
    key: "windows",
    releaseKey: "windows",
    href: "/download/windows",
    ext: "MSI",
    kind: "download",
  },
  {
    key: "linuxAppImage",
    releaseKey: "linux-appimage",
    href: "/download/linux-appimage",
    ext: "APPIMAGE",
    kind: "download",
  },
  {
    key: "linuxDeb",
    releaseKey: "linux-deb",
    href: "/download/linux-deb",
    ext: "DEB",
    kind: "download",
  },
  {
    key: "androidPlay",
    ext: "GOOGLE PLAY",
    kind: "comingSoon",
  },
  {
    key: "androidApk",
    releaseKey: "android",
    href: "/download/android",
    ext: "APK",
    kind: "download",
  },
  {
    key: "ios",
    ext: "APP STORE",
    kind: "comingSoon",
  },
];

export const DOWNLOAD_LABEL_KEYS: Record<DownloadKey, keyof Dict> = {
  macSilicon: "dlMacSilicon",
  macIntel: "dlMacIntel",
  windows: "dlWindows",
  linuxAppImage: "dlLinuxAppImage",
  linuxDeb: "dlLinuxDeb",
  androidPlay: "dlAndroidPlay",
  androidApk: "dlAndroidApk",
  ios: "dlIosIpad",
};

// Mac with unknown arch (`"mac"`) defaults to Apple Silicon: this is the
// dominant chip in 2026 and matches the explicit public-site default.
export function recommendDownloadFor(platform: Platform): DownloadKey | null {
  if (platform === "mac" || platform === "mac-arm") return "macSilicon";
  if (platform === "mac-intel") return "macIntel";
  if (platform === "windows") return "windows";
  // Default Linux recommendation: AppImage. It's portable across distros,
  // while .deb only fits Debian/Ubuntu derivatives.
  if (platform === "linux") return "linuxAppImage";
  if (platform === "android") return "androidApk";
  return null;
}

export function getDownloadTarget(
  key: DownloadKey | null,
): DownloadTarget | undefined {
  if (!key) return undefined;
  return DOWNLOAD_TARGETS.find((target) => target.key === key);
}
