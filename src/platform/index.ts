// Platform detection and capability surface.
//
// The rest of the app should never branch on `isTauri` directly — it should
// call through the helpers here (saveBytes, openFilePicker, etc.) so that
// swapping the desktop backend later doesn't touch component code.

import { detectFormFactor } from "./formFactor";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    ShioriAndroid?: {
      drainPendingDocumentOpens?: () => string;
      documentInfo?: (uri: string) => string;
      installDirectApk?: (requestJson: string) => string;
      shareExport?: (requestJson: string) => string;
      setImmersive?: (enabled: boolean) => string;
      safeAreaInsets?: () => string;
      setSystemBarsAppearance?: (dark: boolean) => string;
    };
  }
}

declare const __TAURI_ENV_PLATFORM__: string | undefined;
declare const __TAURI_ENV_FAMILY__: string | undefined;
declare const __TAURI_ENV_TARGET_TRIPLE__: string | undefined;
declare const __SHIORI_ANDROID_DISTRIBUTION__: string | undefined;

export const IS_TAURI =
  typeof window !== "undefined" &&
  (Boolean(window.__TAURI_INTERNALS__) || Boolean(window.__TAURI__));

const buildPlatform =
  typeof __TAURI_ENV_PLATFORM__ === "string"
    ? __TAURI_ENV_PLATFORM__.toLowerCase()
    : "";
const buildFamily =
  typeof __TAURI_ENV_FAMILY__ === "string"
    ? __TAURI_ENV_FAMILY__.toLowerCase()
    : "";
const buildTargetTriple =
  typeof __TAURI_ENV_TARGET_TRIPLE__ === "string"
    ? __TAURI_ENV_TARGET_TRIPLE__.toLowerCase()
    : "";
const androidDistributionRaw =
  typeof __SHIORI_ANDROID_DISTRIBUTION__ === "string"
    ? __SHIORI_ANDROID_DISTRIBUTION__.toLowerCase()
    : "";
const userAgent =
  typeof navigator === "undefined" ? "" : navigator.userAgent || "";
const platform =
  typeof navigator === "undefined" ? "" : navigator.platform || "";
const maxTouchPoints =
  typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints || 0;

const buildTargetsAndroid =
  buildPlatform.includes("android") ||
  buildTargetTriple.includes("android") ||
  buildTargetTriple.includes("androideabi");
const buildTargetsIos =
  buildPlatform.includes("ios") ||
  buildTargetTriple.includes("apple-ios");
const buildTargetsMobile =
  buildFamily === "unix" && (buildTargetsAndroid || buildTargetsIos);

export const IS_ANDROID = buildTargetsAndroid || /Android/i.test(userAgent);
export const IS_WINDOWS =
  buildPlatform.includes("windows") ||
  buildTargetTriple.includes("windows") ||
  buildTargetTriple.includes("pc-windows") ||
  /Win/i.test(platform || userAgent);
export const IS_IOS =
  buildTargetsIos ||
  /iPhone|iPad|iPod/i.test(platform || userAgent) ||
  (platform === "MacIntel" && maxTouchPoints > 1 && /Mobile|Safari/i.test(userAgent));
export const IS_TAURI_MOBILE =
  IS_TAURI && (buildTargetsMobile || IS_ANDROID || IS_IOS);
export const IS_TAURI_DESKTOP = IS_TAURI && !IS_TAURI_MOBILE;

// Tablet/phone detection lives in a pure, unit-tested module (formFactor.ts)
// because the heuristics are brittle — iPadOS spoofs desktop Safari.
const screenMinSide =
  typeof screen === "undefined"
    ? 0
    : Math.min(screen.width || 0, screen.height || 0);
const formFactor = detectFormFactor({
  userAgent,
  platform,
  maxTouchPoints,
  screenMinSide,
  isAndroid: IS_ANDROID,
  isIos: IS_IOS,
});
// Device facts, distinct from useIsMobile's viewport axis. Only meaningful
// inside a Tauri mobile build (web/desktop are neither). IS_TABLET gates the
// tablet-only embedded browser; the terminal is never enabled on either.
export const IS_TABLET = IS_TAURI_MOBILE && formFactor.isTablet;
export const IS_PHONE = IS_TAURI_MOBILE && formFactor.isPhone;

export type AndroidDistribution = "google-play" | "direct-apk" | "unknown";

export const ANDROID_DISTRIBUTION: AndroidDistribution =
  androidDistributionRaw === "google-play" ||
  androidDistributionRaw === "direct-apk"
    ? androidDistributionRaw
    : "unknown";

// Rough platform sniff — good enough for window chrome quirks (traffic
// light padding, Cmd vs Ctrl accelerators). Falls back to user-agent
// because Tauri's webview sets navigator.platform to the host OS.
export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent || "",
  );

export const PLATFORM_LABEL = IS_TAURI_MOBILE
  ? IS_IOS
    ? "ios"
    : "android"
  : IS_TAURI_DESKTOP
    ? "desktop"
  : "web";

export type SystemFontAccessMode = "native" | "permission" | "unavailable";

export const SYSTEM_FONT_ACCESS_MODE: SystemFontAccessMode = IS_TAURI_DESKTOP
  ? "native"
  : IS_TAURI_MOBILE
    ? "unavailable"
    : "permission";

export const CAPABILITIES = {
  embeddedTerminal: IS_TAURI_DESKTOP,
  externalTerminals: IS_TAURI_DESKTOP,
  liveAnnotationBridge: IS_TAURI_DESKTOP,
  // Desktop (all OSes) renders the Browser panel as a native CHILD WEBVIEW;
  // tablets render it via a native PLUGIN view (Tauri has no multi-webview on
  // mobile — see docs/TABLET-BROWSER-HANDOFF.md). Phones get neither.
  //
  // Windows had TWO regressions here: the per-frame show() freeze (fixed
  // 0.1.22) and then a navigation wedge — the FIRST remote navigation froze
  // the whole main UI thread (page blank + dead buttons + unclosable window +
  // terminal stuck at "starting shell"). Root cause: the embedded panel is
  // created (add_child) and first-navigated together; on Windows add_child
  // runs a nested message pump while creating the WebView2 controller, and the
  // initial navigation's `on_navigation` (a synchronous NavigationStarting COM
  // callback) fired re-entrantly inside it — there `app.emit` -> eval ->
  // wry send_user_message INLINE-EXECUTES on the main thread, re-entering the
  // pump and wedging controller creation. macOS WKWebView dispatches
  // evaluateJavaScript async and never re-enters. Fixed in lib.rs by deferring
  // every create+navigate emit off the COM-callback stack (async_runtime::spawn)
  // and a `creating` gate that stashes geometry commands (set_bounds/hide) that
  // the add_child nested pump would otherwise dispatch onto a half-built
  // controller. IS_WINDOWS stays exported as the one-line escape hatch if a
  // tester still freezes. See POSTMORTEMS 2026-06-15.
  embeddedBrowserPanel: IS_TAURI_DESKTOP || IS_TABLET,
  // Which backend serves the panel — the desktop child webview and the tablet
  // plugin view are NOT interchangeable, so consumers branch on these.
  embeddedBrowserDesktop: IS_TAURI_DESKTOP,
  embeddedBrowserTablet: IS_TABLET,
  nativePaths: IS_TAURI_DESKTOP,
  // One dialog that returns both files and directories. macOS NSOpenPanel can
  // do this (setCanChooseFiles + setCanChooseDirectories); Windows'
  // IFileOpenDialog and the GTK/portal chooser are one or the other, with no
  // supported flag combination for both. So on those platforms the click
  // entry opens documents only, and folders arrive by drag-drop, file
  // association, or argv. Consumers use this to label the control honestly
  // rather than to offer a second, manual "pick a folder" affordance —
  // classifying the target is the app's job, not the reader's.
  mixedFileFolderPicker: IS_TAURI_DESKTOP && IS_MAC,
  nativeUpdater: IS_TAURI_DESKTOP,
  nativeDragDrop: IS_TAURI_DESKTOP,
  nativeWindowChrome: IS_TAURI_DESKTOP,
  // Windows runs undecorated and draws its own caption buttons: the native
  // title bar there is a flat white strip that ignores the app theme. macOS
  // keeps an overlay title bar with its traffic lights; Linux keeps the
  // window manager's decorations.
  customWindowCaption: IS_TAURI_DESKTOP && IS_WINDOWS,
  // Real process CPU/memory on every supported runtime: desktop (sysinfo),
  // iOS (Mach task_info), Android (tauri-plugin-shiori-metrics: Process /
  // ActivityManager). Contract §5: each platform is advertised only once its
  // backend returns real data — and the panel still degrades to "unavailable"
  // (never fake) if a runtime read fails.
  nativeProcessMetrics:
    IS_TAURI_DESKTOP || (IS_TAURI_MOBILE && (IS_IOS || IS_ANDROID)),
  mobileDocumentPicker: IS_TAURI_MOBILE,
  mobileShareExport: IS_TAURI_MOBILE,
  androidDirectUpdater:
    IS_TAURI_MOBILE && IS_ANDROID && ANDROID_DISTRIBUTION === "direct-apk",
  // IndexedDB-backed workspace sources are available in every supported
  // runtime. They are the durable reopen anchor for picker/drop documents and
  // for text working copies that have not been written back to their origin.
  workspaceSourceCache: true,
  textDocuments: true,
  textDocumentRelativeImages: IS_TAURI_DESKTOP,
} as const;

export { saveBytes } from "./save";
export { writeBackTarget, writeTextDocumentBack } from "./writeBack";
export type {
  WriteBackResult,
  WriteBackSource,
  WriteBackTarget,
} from "./writeBack";
export { openExportedFile, revealExportedFile } from "./exportedFile";
export { openExternalUrl } from "./external";
export {
  closeWebPanel,
  hideWebPanel,
  isWebPanelUrl,
  listenWebPanelNav,
  listenWebPanelOpenRequest,
  navigateWebPanel,
  openUrlInSystemBrowser,
  openUrlInWebPanel,
  resolveAddressBarInput,
  setWebPanelBounds,
  webPanelBack,
  webPanelForward,
  webPanelReload,
} from "./webPanel";
export type { WebPanelBounds, WebPanelNavState } from "./webPanel";
export {
  getProcessMetrics,
  readBrowserMemoryMetrics,
  readGpuRendererInfo,
  readGpuAdapterInfo,
  readStorageEstimate,
} from "./metrics";
export type {
  BrowserMemoryMetrics,
  GpuRendererInfo,
  ProcessMetrics,
  StorageEstimateResult,
} from "./metrics";
export { listSystemFonts } from "./systemFonts";
export type {
  SystemFontFamily,
  SystemFontListResult,
} from "./systemFonts";
// Desktop PDF file operations go through narrow Rust commands rather than
// exposing broad filesystem scope to frontend JS. Web callers still use the
// browser File / Blob APIs.
export {
  isPlatformPdfOpenError,
  openDocumentsFromPlatform,
  openPdfFromPlatform,
  readDocumentBytesFromPlatformPath,
  readMobileDocumentFromPlatformUrl,
  readPdfAtPath,
  readPdfBytesFromPlatformPath,
} from "./open";
export type { MobileDocumentReference } from "./open";
export {
  classifyOpenTargetFromPlatform,
  listFolderEntriesFromPlatform,
  pickFolderFromPlatform,
} from "./folderMount";
export type {
  FolderEntry,
  FolderListing,
  OpenTargetInfo,
} from "./folderMount";
export {
  LocalDocumentImageResourceError,
  readLocalDocumentImage,
  readTextDocumentRelativeImage,
} from "./imageResources";
export type {
  LocalDocumentImageResource,
  LocalDocumentImageResourceErrorCode,
} from "./imageResources";
export { checkForUpdate, applyUpdateAndRelaunch } from "./updater";
export type { ShioriUpdate, DownloadProgress } from "./updater";
export { getRuntimeGuardStatus } from "./runtimeGuard";
export type { RuntimeGuardStatus } from "./runtimeGuard";
export {
  EmbeddedTerminalError,
  killEmbeddedTerminal,
  listenEmbeddedTerminalExit,
  listenEmbeddedTerminalOutput,
  resizeEmbeddedTerminal,
  spawnEmbeddedTerminal,
  writeEmbeddedTerminal,
  writeEmbeddedTerminalBinary,
} from "./embeddedTerminal";
export type {
  EmbeddedTerminalErrorCode,
  EmbeddedTerminalExit,
  EmbeddedTerminalOutput,
  EmbeddedTerminalSession,
  EmbeddedTerminalSize,
} from "./embeddedTerminal";
export {
  EXTERNAL_TERMINAL_IDS,
  isExternalTerminalId,
  listExternalTerminals,
  normalizeExternalTerminalApps,
  normalizeExternalTerminalIconDataUrl,
  normalizeExternalTerminalWorkingDirectory,
  openExternalTerminal,
} from "./externalTerminal";
export type {
  ExternalTerminalApp,
  ExternalTerminalId,
} from "./externalTerminal";
export {
  LIVE_API_ANNOTATION_REQUEST_EVENT,
  LIVE_API_SCHEMA,
  authorizeLiveApiMutation,
  completeLiveApiRequest,
  listenLiveApiAnnotationRequests,
  updateLiveApiContext,
} from "./liveApi";
export type {
  LiveApiAnnotationRequest,
  LiveApiCompletion,
  LiveApiContext,
  LiveApiError,
  LiveApiSuccessData,
  LiveApiTarget,
} from "./liveApi";
