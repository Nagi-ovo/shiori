import { IS_TAURI_DESKTOP } from "./index";

export const NATIVE_APP_EXIT_REQUEST_EVENT = "app-exit-requested";

/** Tells Rust whether an exit request can currently reach the React guard. */
export async function setNativeAppExitGuardReady(ready: boolean): Promise<void> {
  if (!IS_TAURI_DESKTOP) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.setAppExitGuardReady(ready));
}

/** Completes a Rust-intercepted desktop exit only after frontend persistence. */
export async function resolveNativeAppExit(allow: boolean): Promise<void> {
  if (!IS_TAURI_DESKTOP) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.resolveAppExit(allow));
}
