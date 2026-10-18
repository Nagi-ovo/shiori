// Syncs the OS-level window chrome theme (titlebar, traffic-light area,
// native scrollbars) with the in-app theme pick. On web this is a no-op —
// the browser already follows the OS. On Tauri 2 we call setTheme on the
// current window so macOS redraws the title-bar background to match.
//
// Note: on macOS, setTheme is app-wide (not per-window), which is what
// we want. On Linux it's also app-wide. Windows applies it per-window.

import { IS_TAURI_DESKTOP } from "./index";

export type NativeTheme = "light" | "dark";

export async function syncNativeTheme(effective: NativeTheme): Promise<void> {
  if (!IS_TAURI_DESKTOP) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(effective);
  } catch (err) {
    // Older macOS (10.13 and earlier) has no theme concept. Don't crash
    // the theme switch over a missing native API.
    console.warn("Failed to sync native window theme", err);
  }
}
