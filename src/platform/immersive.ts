// Reader mode hides all in-app chrome, but the OS status/navigation bars sit
// outside the webview — they only disappear through a native call. Android
// switches the activity to immersive mode via the ShioriAndroid JS bridge;
// iOS/iPadOS toggles the root view controller's status-bar and home-indicator
// preferences through the set_reader_immersive Tauri command. Desktop needs no
// call: macOS keeps its traffic lights by design (layout insets them).

import { IS_ANDROID, IS_IOS, IS_TAURI } from "./index";

export function syncImmersiveMode(enabled: boolean): void {
  if (IS_ANDROID) {
    const bridge =
      typeof window === "undefined" ? undefined : window.ShioriAndroid;
    // Bind before calling: a detached bridge method reference loses its Java
    // receiver (same pitfall as installDirectApk in updater.ts).
    const setImmersive = bridge?.setImmersive?.bind(bridge);
    if (!setImmersive) return;
    try {
      setImmersive(enabled);
    } catch {
      // Older Android shells without the bridge method: reader mode still
      // works, only the system bars stay visible.
    }
    return;
  }
  if (IS_TAURI && IS_IOS) {
    void import("./ipc")
      .then(({ commands, unwrapCommand }) =>
        commands.setReaderImmersive(enabled).then(unwrapCommand),
      )
      .catch(() => {
        // Older iOS shells without the command: reader mode still works,
        // only the status bar stays visible.
      });
  }
}
