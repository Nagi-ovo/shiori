// Android shell ↔ page sync.
//
// The Activity lays the WebView out edge to edge, under transparent system
// bars, and the page reserves the room itself through the `--shiori-safe-*`
// CSS variables — the same variables iOS fills from env(safe-area-inset-*).
// Android WebView never reports the system bars through env() (only display
// cutouts), so the shell publishes them: a pull through the bridge at boot,
// then a push on every change (rotation, immersive reader mode, keyboard).
//
// Padding the native view instead — the previous approach — showed the
// Activity window background (white, or the night default) as a band under
// Shiori's own status bar: the "misaligned bottom" readers saw on Android.
//
// The same module mirrors the page's colour scheme into the system bar icon
// polarity: enableEdgeToEdge() follows the OS setting, so Shiori dark under
// a light OS kept dark status icons on a dark top bar.

import { IS_ANDROID } from "./index";

export type SafeAreaInsets = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export const ANDROID_SAFE_AREA_EVENT = "shiori-android-safe-area";

const SAFE_AREA_VARS = {
  top: "--shiori-safe-top",
  bottom: "--shiori-safe-bottom",
  left: "--shiori-safe-left",
  right: "--shiori-safe-right",
} as const;

/** Bridge JSON (a string) or an event detail (an object) → insets, or null. */
export function parseSafeAreaInsets(value: unknown): SafeAreaInsets | null {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const read = (key: keyof SafeAreaInsets): number | null => {
    const entry = record[key];
    return typeof entry === "number" && Number.isFinite(entry) && entry >= 0
      ? entry
      : null;
  };
  const top = read("top");
  const bottom = read("bottom");
  const left = read("left");
  const right = read("right");
  if (top === null || bottom === null || left === null || right === null) {
    return null;
  }
  return { top, bottom, left, right };
}

export function safeAreaCssVars(insets: SafeAreaInsets): Record<string, string> {
  const px = (value: number) => `${Math.round(value * 100) / 100}px`;
  return {
    [SAFE_AREA_VARS.top]: px(insets.top),
    [SAFE_AREA_VARS.bottom]: px(insets.bottom),
    [SAFE_AREA_VARS.left]: px(insets.left),
    [SAFE_AREA_VARS.right]: px(insets.right),
  };
}

export function applySafeAreaInsets(
  root: HTMLElement,
  insets: SafeAreaInsets,
): void {
  for (const [name, value] of Object.entries(safeAreaCssVars(insets))) {
    root.style.setProperty(name, value);
  }
}

export function installAndroidShellSync(
  options: { enabled?: boolean } = {},
): () => void {
  const enabled = options.enabled ?? IS_ANDROID;
  if (!enabled || typeof window === "undefined") return () => undefined;
  const root = document.documentElement;
  const bridge = window.ShioriAndroid;

  // Bind before calling: a detached bridge method reference loses its Java
  // receiver (same pitfall as installDirectApk in updater.ts).
  const readInsets = bridge?.safeAreaInsets?.bind(bridge);
  if (readInsets) {
    try {
      const insets = parseSafeAreaInsets(readInsets());
      if (insets) applySafeAreaInsets(root, insets);
    } catch {
      // Older shells without the method: the CSS fallbacks stay at 0.
    }
  }
  const onSafeArea = (event: Event) => {
    const insets = parseSafeAreaInsets((event as CustomEvent).detail);
    if (insets) applySafeAreaInsets(root, insets);
  };
  window.addEventListener(ANDROID_SAFE_AREA_EVENT, onSafeArea);

  // applyTheme writes `color-scheme` on the root whenever the effective
  // theme changes; the style attribute is the one signal to follow.
  const setAppearance = bridge?.setSystemBarsAppearance?.bind(bridge);
  let lastScheme: string | null = null;
  const syncSystemBars = () => {
    if (!setAppearance) return;
    const scheme = root.style.getPropertyValue("color-scheme").trim();
    if (!scheme || scheme === lastScheme) return;
    lastScheme = scheme;
    try {
      setAppearance(scheme === "dark");
    } catch {
      // Older shells: the bars keep following the OS.
    }
  };
  syncSystemBars();
  const observer =
    typeof MutationObserver === "function"
      ? new MutationObserver(syncSystemBars)
      : null;
  observer?.observe(root, { attributes: true, attributeFilter: ["style"] });

  return () => {
    window.removeEventListener(ANDROID_SAFE_AREA_EVENT, onSafeArea);
    observer?.disconnect();
  };
}
