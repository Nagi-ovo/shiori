// Platform abstraction over `@tauri-apps/plugin-updater`. Web build
// returns null / no-ops; only Tauri actually pings the update endpoint.
//
// Components import the helpers below — they should never reach for
// `@tauri-apps/plugin-updater` directly, both to keep the web build
// working and to give us one place to retune backoff, logging, etc.

import { CAPABILITIES } from "./index";
import { appVersion, compareSemver } from "../runtime/version";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  requireDirectAndroidSha256,
  requireOfficialDirectAndroidUpdateUrl,
} from "./androidUpdatePolicy";
import { WEBSITE_URL } from "../shared/links";

type DesktopUpdate = {
  kind: "desktop";
  version: string;
  currentVersion: string;
  body: string | null;
  date: string | null;
  // Opaque handle to the underlying Tauri update; callers pass it back
  // to `applyUpdateAndRelaunch` instead of touching plugin internals.
  _native: Update;
};

type AndroidDirectUpdate = {
  kind: "android-direct";
  version: string;
  currentVersion: string;
  body: string | null;
  date: string | null;
  url: string;
  filename: string;
  size: number;
  sha256: string | null;
};

export type ShioriUpdate = DesktopUpdate | AndroidDirectUpdate;

export type DownloadProgress = {
  // Bytes downloaded so far.
  downloaded: number;
  // Total bytes if the manifest carried Content-Length, otherwise null
  // (some CDNs don't send it; we still finish the download, just can't
  // show a determinate progress bar).
  total: number | null;
};

type DirectReleaseInfo = {
  version?: string;
  publishedAt?: string;
  platforms?: {
    android?: {
      filename?: string;
      version?: string;
      publishedAt?: string;
      size?: number;
      url?: string;
      sha256?: string;
    };
  };
};

const DIRECT_ANDROID_RELEASE_URL = `${WEBSITE_URL}/api/release`;

export async function checkForUpdate(): Promise<ShioriUpdate | null> {
  if (CAPABILITIES.androidDirectUpdater) {
    return checkForDirectAndroidUpdate();
  }
  if (!CAPABILITIES.nativeUpdater) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    kind: "desktop",
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body ?? null,
    date: update.date ?? null,
    _native: update,
  };
}

export async function applyUpdateAndRelaunch(
  update: ShioriUpdate,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  if (update.kind === "android-direct") {
    return installDirectAndroidUpdate(update, onProgress);
  }
  if (!CAPABILITIES.nativeUpdater) return;
  let downloaded = 0;
  let total: number | null = null;
  await update._native.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      onProgress?.({ downloaded: 0, total });
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress?.({ downloaded, total });
    } else if (event.event === "Finished") {
      onProgress?.({ downloaded: total ?? downloaded, total });
    }
  });
  // Once the new bundle is installed, relaunch into it. On Windows the
  // installer takes over the relaunch step itself (passive install
  // mode), but calling this is still the documented pattern and is a
  // no-op there.
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

async function checkForDirectAndroidUpdate(): Promise<AndroidDirectUpdate | null> {
  const response = await fetch(DIRECT_ANDROID_RELEASE_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`release-check-failed-${response.status}`);
  }
  const data = (await response.json()) as DirectReleaseInfo;
  const asset = data.platforms?.android;
  const version =
    typeof asset?.version === "string"
      ? asset.version
      : typeof data.version === "string"
        ? data.version
        : null;
  const url = typeof asset?.url === "string" ? asset.url : null;
  if (!version || !url) {
    throw new Error("android-release-asset-missing");
  }
  if (compareSemver(version, appVersion) <= 0) return null;
  return {
    kind: "android-direct",
    version,
    currentVersion: appVersion,
    body: null,
    date:
      typeof asset?.publishedAt === "string"
        ? asset.publishedAt
        : typeof data.publishedAt === "string"
          ? data.publishedAt
          : null,
    url,
    filename:
      typeof asset?.filename === "string" ? asset.filename : "Shiori.apk",
    size: typeof asset?.size === "number" ? asset.size : 0,
    sha256: typeof asset?.sha256 === "string" ? asset.sha256 : null,
  };
}

type AndroidBridgeResult = {
  ok?: boolean;
  message?: string;
};

type AndroidUpdateBridgeDetail = {
  id?: string;
  status?: "progress" | "complete" | "error";
  downloaded?: number;
  total?: number;
  message?: string;
};

async function installDirectAndroidUpdate(
  update: AndroidDirectUpdate,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  // Validate before either install route. The native bridge repeats these
  // checks as defense in depth; the external-opener fallback must not become a
  // weaker path that trusts an arbitrary manifest URL or unsigned APK.
  const url = requireOfficialDirectAndroidUpdateUrl(update.url);
  const sha256 = requireDirectAndroidSha256(update.sha256);
  const bridge =
    typeof window === "undefined" ? undefined : window.ShioriAndroid;
  // Bind to `bridge`: Android's @JavascriptInterface dispatch checks the call
  // receiver, and invoking a detached method reference (`installDirectApk(...)`)
  // throws "Java bridge method can't be invoked on a non-injected object".
  // The sibling bridge calls (documentInfo/shareExport/drainPendingDocumentOpens)
  // work precisely because they call `bridge.method(...)` with the receiver intact.
  const installDirectApk = bridge?.installDirectApk?.bind(bridge);
  if (!installDirectApk) {
    onProgress?.({ downloaded: 0, total: update.size || null });
    const { openExternalUrl } = await import("./external");
    await openExternalUrl(url);
    return;
  }

  const id = `shiori-apk-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const request = {
    id,
    url,
    filename: update.filename,
    size: update.size,
    sha256,
    version: update.version,
  };

  onProgress?.({ downloaded: 0, total: update.size || null });

  await new Promise<void>((resolve, reject) => {
    function cleanup() {
      window.removeEventListener("shiori-android-update", onBridgeEvent);
    }

    function onBridgeEvent(event: Event) {
      const detail = (event as CustomEvent<AndroidUpdateBridgeDetail>).detail;
      if (!detail || detail.id !== id) return;
      if (detail.status === "progress") {
        onProgress?.({
          downloaded: typeof detail.downloaded === "number" ? detail.downloaded : 0,
          total:
            typeof detail.total === "number" && detail.total > 0
              ? detail.total
              : update.size || null,
        });
        return;
      }
      cleanup();
      if (detail.status === "complete") {
        resolve();
      } else {
        reject(new Error(detail.message || "android-update-failed"));
      }
    }

    window.addEventListener("shiori-android-update", onBridgeEvent);
    try {
      const rawResult = installDirectApk(JSON.stringify(request));
      const result = JSON.parse(rawResult) as AndroidBridgeResult;
      if (!result.ok) {
        cleanup();
        reject(new Error(result.message || "android-update-request-failed"));
      }
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
