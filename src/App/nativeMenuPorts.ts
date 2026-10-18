import { useAppStore, type PdfEditorStoreApi } from "../editor/store/store";
import { toast } from "../editor/toast";
import i18n from "../i18n";
import { setNativeAppExitGuardReady } from "../platform/appExit";
import { listenNativeEvent } from "../platform/nativeEvents";
import { createNativeMenu } from "./nativeMenu";
import { requestPrint } from "../editor/viewport/requestPrint";

type Live = {
  checkForUpdates: () => void;
  completeExitRequest: () => void;
};

/**
 * The native menu on the real platform. Created once; App connects the update
 * check and the exit completion from an effect, so re-renders, tab switches
 * and language changes never re-wire the menu or drop the exit guard.
 */
export function createAppNativeMenu(activeEditor: () => PdfEditorStoreApi) {
  const live: Live = { checkForUpdates: () => {}, completeExitRequest: () => {} };
  const menu = createNativeMenu({
    listen: (channel, run) => listenNativeEvent(channel, () => run()),
    setExitGuardReady: setNativeAppExitGuardReady,
    activeEditor,
    completeExitRequest: () => live.completeExitRequest(),
    checkForUpdates: () => live.checkForUpdates(),
    openSettings: () => useAppStore.getState().setShowSettings(true),
    print: () => void requestPrint(activeEditor()),
    copiedAnnotations: (count) =>
      toast.show(i18n.t("toast.copiedAnnotations", { count })),
    // Every item is wired in one sequence. A rejection partway through leaves
    // the rest unwired: the menu bar is there but some entries are dead, which
    // reads as the app ignoring you rather than as a failure.
    installFailed: (error) =>
      console.error("[shiori] native menu listeners failed to install", error),
  });
  return {
    ...menu,
    connect(next: Partial<Live>): void {
      Object.assign(live, next);
    },
  };
}
