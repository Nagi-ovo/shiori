// The Windows shell turns native decorations off (tauri.windows.conf.json) and
// the app draws the caption buttons itself (WindowCaption.tsx). These are the
// window actions behind them. Tauri desktop only; callers gate on
// CAPABILITIES.customWindowCaption.

export type WindowCaptionPorts = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  /** The guarded close: fires onCloseRequested, which asks about unsaved work. */
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  /** Maximizing, restoring and snapping all arrive as resizes. */
  onResized: (run: () => void) => Promise<() => void>;
};

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export const windowCaptionPorts: WindowCaptionPorts = {
  minimize: async () => (await currentWindow()).minimize(),
  toggleMaximize: async () => (await currentWindow()).toggleMaximize(),
  close: async () => (await currentWindow()).close(),
  isMaximized: async () => (await currentWindow()).isMaximized(),
  onResized: async (run) => (await currentWindow()).onResized(() => run()),
};

/** Width the caption buttons take at the top-right; layouts keep it clear. */
export const WINDOW_CAPTION_WIDTH = 3 * 46;
/** Matches the top bar, so the buttons fill its height like native ones. */
export const WINDOW_CAPTION_HEIGHT = 48;
