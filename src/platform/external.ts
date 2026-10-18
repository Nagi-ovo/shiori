import { IS_TAURI_DESKTOP, IS_TAURI_MOBILE } from "./index";

const EXTERNAL_URL_PATTERN = /^(https?:|mailto:)/i;

export async function openExternalUrl(url: string): Promise<void> {
  if (!EXTERNAL_URL_PATTERN.test(url)) {
    throw new Error("unsupported-external-url");
  }
  if (IS_TAURI_DESKTOP) {
    const { commands, unwrapCommand } = await import("./ipc");
    unwrapCommand(await commands.openExternalUrl(url));
    return;
  }
  if (IS_TAURI_MOBILE) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}
