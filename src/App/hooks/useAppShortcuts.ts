import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { toast } from "../../editor/toast";
import { imageBytesToPdf } from "../../pdf/image/imagePdf";
import {
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
} from "../../editor/store/store";

/**
 * Phase 1: called synchronously while the reader's action is still on the
 * stack, binding the document they were looking at. Phase 2 does the merge.
 */
type IncomingPdfAppender = () => (
  incomingBytes: Uint8Array,
  incomingName: string,
) => Promise<boolean>;

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable),
  );
}

/**
 * Global keyboard and clipboard shortcuts: the
 * window-level keydown bindings (⌘/Ctrl+S → export, ⌘/Ctrl+\ → reader mode,
 * Esc → exit reader mode) and image-paste → append-as-page. Both are genuine
 * global listeners with cleanup, moved verbatim from the App God-component.
 *
 * The page appender and the text save are created once by App, so the
 * listeners install once per open document. NB: the modal ⇄ find
 * mutual-exclusion effect stays in App — it is reactive state coordination
 * over nine overlay flags, not an input listener, so it does not belong here.
 */
export function useAppShortcuts({
  beginPageMerge,
  saveActiveTextDocument,
}: {
  beginPageMerge: IncomingPdfAppender;
  /** Saves the text document on screen; false when none is. */
  saveActiveTextDocument?: () => boolean;
}): void {
  const { t } = useTranslation();
  const editorStore = useEditorStoreApi();
  const setShowExport = useAppStore((s) => s.setShowExport);
  const setReaderMode = useEditorStore((s) => s.setReaderMode);
  const toggleReaderMode = useEditorStore((s) => s.toggleReaderMode);
  const opened = useEditorStore((s) => s.opened);

  // Reader-mode global hotkeys: Cmd/Ctrl + \ toggles, Esc exits when
  // active. Listens at the window level so the binding works whether
  // the keyboard focus is on the canvas, a thumbnail, or a toolbar
  // button. Inputs / textareas / contenteditable still get to handle
  // the key first (Esc inside the find panel, for example) — the
  // editable check is the same one the rest of the editor uses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      // ⌘S is checked BEFORE the editable guard, unlike every other binding
      // here: saving while the caret sits in the Markdown editor is the single
      // most common way to press it, and an editor that ignores ⌘S mid-typing
      // is broken. Everything below still defers to the focused field.
      if (mod && (e.key === "s" || e.key === "S")) {
        // Text documents save back over the file they were opened from. PDFs
        // have no separate save step (edits autosave to the draft), so there
        // "save" means export — map the reflex to the export dialog.
        if (saveActiveTextDocument?.()) {
          e.preventDefault();
          return;
        }
        if (editorStore.getState().opened) {
          e.preventDefault();
          setShowExport(true);
        }
        return;
      }
      if (editable) return;
      if (mod && e.key === "\\") {
        e.preventDefault();
        toggleReaderMode();
        return;
      }
      if (e.key === "Escape" && editorStore.getState().readerMode) {
        e.preventDefault();
        setReaderMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    saveActiveTextDocument,
    editorStore,
    setReaderMode,
    setShowExport,
    toggleReaderMode,
  ]);

  // macOS predefined Paste owns ⌘V before WKWebView can emit keydown, but it
  // still dispatches a DOM paste event. Handle the in-app annotation clipboard
  // here first, while leaving editable targets to native text paste and using
  // the same event for image-paste-as-page when no annotations are pending.
  useEffect(() => {
    if (!opened) return;
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.defaultPrevented) return;
      const state = editorStore.getState();
      const { overlayClipboard } = useAppStore.getState();
      if (overlayClipboard.length > 0 && state.activePageId) {
        e.preventDefault();
        const count = overlayClipboard.length;
        const pageId = state.activePageId;
        state.pasteClipboard(pageId);
        const page = state.model.pages.findIndex((item) => item.id === pageId) + 1;
        toast.showAction(t("toast.pastedAnnotations", { count, page }), {
          label: t("toast.undo"),
          onClick: () => editorStore.getState().undo(),
        });
        return;
      }
      const item = Array.from(e.clipboardData?.items ?? []).find((entry) =>
        entry.type === "image/png" ||
        entry.type === "image/jpeg" ||
        entry.type === "image/jpg"
      );
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      // Bind the target document NOW, before decoding the image and before
      // the merge queue drains. Both take long enough for the reader to
      // switch tabs, and resolving the target afterwards dropped the page
      // into whichever document they had moved to — reporting success.
      const appendToRequestedDocument = beginPageMerge();
      void (async () => {
        const imageBytes = new Uint8Array(await file.arrayBuffer());
        const pdfBytes = await imageBytesToPdf(imageBytes, file.type);
        const ok = await appendToRequestedDocument(
          pdfBytes,
          file.name || "pasted-image.pdf",
        );
        if (ok) toast.show(t("toast.imagePageAdded"));
      })().catch((err) => {
        toast.error(t("error.unknown.title"), (err as Error).message);
      });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [beginPageMerge, editorStore, opened, t]);
}
