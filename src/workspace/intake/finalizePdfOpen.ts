import type { PdfEditorStoreApi } from "../../editor/store/store";
import {
  filterExistingCollapsedCalloutIds,
  filterExistingCollapsedNoteIds,
} from "../../editor/overlays/notePresentation";
import { prepareLiveOverlayRevealBatch } from "../../live/overlayReveal";
import type { PdfDocument } from "../../pdf/engine/types";
import type { DocumentModel, Overlay, PageModel } from "../../pdf/model/types";
import type { WorkspacePdfViewState } from "../../storage/workspace";

export type PdfOpenModel = {
  pages: PageModel[];
  overlays: Overlay[];
  /**
   * When the replacement bytes represent a user edit (page insertion), seed
   * Undo with the pre-edit model remapped onto those new bytes.
   */
  historyBaseline?: DocumentModel;
  /** Existing source indices still address the same physical pages. */
  preserveHistory?: boolean;
};

export type FinalizePdfOpen = {
  /** The tab's editor store; nothing else is written. */
  store: PdfEditorStoreApi;
  file: { readonly name: string; readonly size: number };
  hash: string;
  /** The fresh pages as parsed, with no annotations. */
  pages: PageModel[];
  doc: PdfDocument;
  bytes: Uint8Array;
  source: { path?: string; webFileHandleId?: string; cacheId?: string };
  password?: string;
  encrypted?: boolean;
  draftVersion?: { lastTouched: number; revision: string | null } | null;
  /** Imported annotations, or a replacement's model. */
  model?: PdfOpenModel;
  /**
   * Apply `model` as an undoable edit on top of `historyBaseline` (a page
   * merge) instead of opening with it as the baseline. Imported annotations
   * open as the baseline so Undo cannot erase what the PDF already had.
   */
  modelAsEdit?: boolean;
  /** The last-read page; ignored when it is out of range. */
  resumePageIndex?: number;
  view?: WorkspacePdfViewState;
  /**
   * The Live receipts to open with. Leave undefined when replacing the bytes
   * of the document on screen: the store then keeps its own receipts, and an
   * empty set would let a lost-response retry run a Live edit twice.
   */
  completedLiveOperationIds?: Iterable<string>;
  /**
   * Keep collapsed note/callout ids that match nothing yet: a draft about to
   * be restored owns them. Otherwise they are pruned against the model.
   */
  keepUnmatchedCollapsedIds?: boolean;
  animateImportedCallouts: boolean;
};

/** Puts a parsed PDF into its tab's editor store. */
export function finalizePdfOpen(open: FinalizePdfOpen): void {
  const { store, model } = open;
  const historyBaseline = open.modelAsEdit ? model?.historyBaseline : undefined;
  const baselineModel =
    historyBaseline ??
    (open.modelAsEdit || !model ? { pages: open.pages, overlays: [] } : model);
  // Wired into the initial store state: a goToPage after setOpened flashes
  // page 1 before scrolling on mobile.
  const resume = open.resumePageIndex;
  const initialPageIndex =
    resume !== undefined && resume > 0 && resume < baselineModel.pages.length
      ? resume
      : 0;
  const importedCallouts =
    !open.modelAsEdit && model
      ? model.overlays.filter((overlay) => overlay.type === "callout")
      : [];
  store.getState().setOpened(
    {
      fileName: open.file.name,
      fileSize: open.file.size,
      doc: open.doc,
      bytes: open.bytes,
      path: open.source.path,
      webFileHandleId: open.source.webFileHandleId,
      cacheId: open.source.cacheId,
      password: open.password,
      encrypted: open.encrypted ?? false,
      draftVersion: open.draftVersion ?? null,
    },
    open.pages,
    open.modelAsEdit ? historyBaseline : model,
    {
      initialPageIndex,
      showThumbs: open.view?.showThumbs,
      // The right rail is deliberately NOT restored per document. It holds a
      // terminal and a browser — a working surface, not a property of the
      // paper you happen to be reading. Restoring it meant switching to a PDF
      // last closed with the rail down silently killed a running terminal
      // session mid-thought.
      //
      // `showRail` / `railTab` are still persisted on the tab: dropping them
      // from the stored shape would fail validation on every tab saved by an
      // older build, and a pdfView that fails validation is discarded whole,
      // taking page, scale and reader mode with it.
      readerMode: open.view?.readerMode,
      completedLiveOperationIds: open.completedLiveOperationIds,
      initialOverlayReveal: open.animateImportedCallouts
        ? prepareLiveOverlayRevealBatch(
            `pdf-open-callouts-${open.hash}`,
            importedCallouts,
          )
        : null,
      preserveHistory: model?.preserveHistory,
    },
  );
  if (open.modelAsEdit && model) {
    // A normal edit, so Undo takes it back; imported annotations above went
    // in without history.
    store.getState().commit({ pages: model.pages, overlays: model.overlays });
  }
  const overlays = store.getState().model.overlays;
  const noteIds = open.view?.collapsedNoteIds ?? [];
  const calloutIds = open.view?.collapsedCalloutIds ?? [];
  store
    .getState()
    .setCollapsedNoteIds(
      open.keepUnmatchedCollapsedIds
        ? noteIds
        : filterExistingCollapsedNoteIds(noteIds, overlays),
    );
  store
    .getState()
    .setCollapsedCalloutIds(
      open.keepUnmatchedCollapsedIds
        ? calloutIds
        : filterExistingCollapsedCalloutIds(calloutIds, overlays),
    );
  store.getState().setFitMode("width");
}
