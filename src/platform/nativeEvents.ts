import { safeUnlisten } from "./ipc";

const NATIVE_DOCUMENT_DROP_EVENT = "tauri://drag-drop";

type NativeDropPayload = {
  paths?: unknown;
};

type NativeDropTarget = {
  listen: (
    event: string,
    handler: (event: { payload: NativeDropPayload }) => void,
  ) => Promise<() => unknown>;
};

/**
 * Subscribe to the one native drag/drop event Shiori consumes.
 *
 * Tauri's `onDragDropEvent()` convenience API installs four listeners and
 * returns a synchronous composite disposer. That disposer discards the four
 * async unlisten promises, so a webview reload or HMR teardown can turn an
 * already-cleared listener into an unhandled rejection. Keeping the raw
 * `listen()` disposer visible lets `safeUnlisten` observe that promise.
 *
 * The returned disposer is idempotent because React cleanup may race with an
 * async listener installation during hot updates.
 */
export async function subscribeNativeDocumentDrops(
  target: NativeDropTarget,
  onDrop: (paths: string[]) => void,
): Promise<() => void> {
  const unlisten = await target.listen(NATIVE_DOCUMENT_DROP_EVENT, (event) => {
    const paths = Array.isArray(event.payload?.paths)
      ? event.payload.paths.filter(
          (path): path is string => typeof path === "string",
        )
      : [];
    onDrop(paths);
  });
  let listening = true;
  return () => {
    if (!listening) return;
    listening = false;
    safeUnlisten(unlisten);
  };
}

/** Desktop-only entry point. Callers must gate this with platform capability. */
export async function listenNativeDocumentDrops(
  onDrop: (paths: string[]) => void,
): Promise<() => void> {
  const { getCurrentWebviewWindow } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  const webviewWindow = getCurrentWebviewWindow();
  return subscribeNativeDocumentDrops(
    {
      listen: (event, handler) => webviewWindow.listen(event, handler),
    },
    onDrop,
  );
}

/**
 * Listen for an event the Rust side emits (menus, file-open handoffs).
 * Tauri only; callers gate with platform capability. The returned disposer
 * is Tauri's raw unlisten, so pass it to `safeUnlisten` on teardown.
 */
export async function listenNativeEvent<T>(
  channel: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(channel, (event) => handler(event.payload));
}

/**
 * Take over the current window's close button. The native close is always
 * prevented; `onClose` decides what happens and can call `destroyWindow` to
 * finish closing. Desktop only; callers gate with platform capability.
 */
export async function interceptNativeWindowClose(
  onClose: (destroyWindow: () => Promise<void>) => Promise<void>,
): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();
  return appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await onClose(() => appWindow.destroy());
  });
}
