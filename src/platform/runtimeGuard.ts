import { IS_TAURI_DESKTOP } from "./index";

export type RuntimeGuardStatus = {
  buildTimestamp: number;
  expiryDays: number;
  expiresAt: number | null;
  expired: boolean;
};

export async function getRuntimeGuardStatus(): Promise<RuntimeGuardStatus | null> {
  if (!IS_TAURI_DESKTOP) return null;
  const { commands, unwrapCommand } = await import("./ipc");
  return unwrapCommand(await commands.runtimeGuardStatus());
}
