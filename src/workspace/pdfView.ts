import {
  useAppStore,
  type PdfEditorStoreApi,
} from "../editor/store/store";
import type { WorkspacePdfViewState } from "../storage/workspace";

export function pdfViewFromStore(store: PdfEditorStoreApi): WorkspacePdfViewState {
  const state = store.getState();
  const appState = useAppStore.getState();
  const pageIndex = Math.max(
    0,
    state.model.pages.findIndex((page) => page.id === state.activePageId),
  );
  return {
    pageIndex,
    scale: state.scale,
    fitMode: state.fitMode,
    showThumbs: state.showThumbs,
    showRail: appState.showRail,
    railTab: appState.railTab,
    readerMode: state.readerMode,
    collapsedNoteIds: [...state.collapsedNoteIds],
    collapsedCalloutIds: [...state.collapsedCalloutIds],
  };
}

export function defaultPdfView(compactLayout: boolean = false): WorkspacePdfViewState {
  return {
    pageIndex: 0,
    scale: 1,
    fitMode: "width",
    showThumbs: !compactLayout,
    showRail: false,
    railTab: "outline",
    readerMode: false,
    collapsedNoteIds: [],
    collapsedCalloutIds: [],
  };
}

export function pdfViewForLayout(
  view: WorkspacePdfViewState | undefined,
  compactLayout: boolean,
): WorkspacePdfViewState {
  const next = view ?? defaultPdfView(compactLayout);
  if (!compactLayout) return next;
  return { ...next, showThumbs: false, showRail: false };
}
