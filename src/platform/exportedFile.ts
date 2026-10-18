import { CAPABILITIES } from "./index";

export async function openExportedFile(path: string): Promise<void> {
  if (!CAPABILITIES.nativePaths) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.openExportedPdf(path));
}

export async function revealExportedFile(path: string): Promise<void> {
  if (!CAPABILITIES.nativePaths) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.revealExportedPdf(path));
}
