import type { PdfEditorStoreApi } from "../editor/store/store";
import i18n from "../i18n";
import { CAPABILITIES, IS_TAURI, openPdfFromPlatform } from "../platform";
import {
  canUseWebFileHandles,
  openPdfWithWebFileHandlePicker,
} from "../storage/recentFileHandles";
import {
  createMergePicker,
  type MergePickerNotice,
} from "../workspace/merge/mergePicker";
import type { PageMerges } from "../workspace/merge/pageMerge";

type Live = {
  clickInput: () => void;
  notify: (notice: MergePickerNotice) => void;
};

/**
 * The page-insert picker on the real platform. Created once; App connects the
 * hidden input and the notice handler from effects.
 */
export function createAppMergePicker(
  merges: PageMerges,
  activeEditor: () => PdfEditorStoreApi,
  setBusy: (busy: boolean) => void,
) {
  const live: Live = { clickInput: () => {}, notify: () => {} };
  const picker = createMergePicker({
    begin: merges.begin,
    lastPageId: () => activeEditor().getState().model.pages.at(-1)?.id ?? null,
    pickNative:
      CAPABILITIES.nativePaths || CAPABILITIES.mobileDocumentPicker
        ? () => openPdfFromPlatform(i18n.t("thumbs.insertPdfPages"))
        : null,
    pickWeb:
      !IS_TAURI && canUseWebFileHandles()
        ? () => openPdfWithWebFileHandlePicker({ persistHandle: false })
        : null,
    clickInput: () => live.clickInput(),
    timers: {
      set: (run, ms) => window.setTimeout(run, ms),
      clear: (handle) => window.clearTimeout(handle),
    },
    setBusy,
    notify: (notice) => live.notify(notice),
  });
  return {
    ...picker,
    connect(next: Partial<Live>): void {
      Object.assign(live, next);
    },
  };
}

export type AppMergePicker = ReturnType<typeof createAppMergePicker>;
