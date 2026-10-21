import type { StoreApi } from "zustand";
import type { DocumentModel } from "../../pdf/model/types";
import type { Store } from "./store";

/** The editor store's action that puts a parsed PDF into it. */
export function openDocumentActions(
  set: StoreApi<Store>["setState"],
  get: StoreApi<Store>["getState"],
  cloneModel: (m: DocumentModel) => DocumentModel,
): Pick<Store, "setOpened"> {
  return {
    setOpened: (opened, pages, initialModel, options) => {
      const current = get();
      if (options?.preserveHistory) {
        if (!current.opened || initialModel !== current.model) {
          throw new Error(
            "preserveHistory requires the live model from the currently opened PDF",
          );
        }
        if (pages.length < current.opened.sourcePages.length) {
          throw new Error(
            "preserveHistory cannot remove physical pages reachable from history",
          );
        }
      }
      const model = initialModel
        ? cloneModel(initialModel)
        : { pages: pages.map((page) => ({ ...page })), overlays: [] };
      const initialPageIndex =
        options?.initialPageIndex !== undefined
          ? Math.max(
              0,
              Math.min(options.initialPageIndex, Math.max(0, model.pages.length - 1)),
            )
          : 0;
      const pendingOverlayReveals = new Map(
        options?.initialOverlayReveal?.itemsById ?? [],
      );
      set({
        opened: { ...opened, sourcePages: pages.map((page) => ({ ...page })) },
        model,
        ...(options?.preserveHistory
          ? {}
          : {
              undoStack: [],
              redoStack: [],
            }),
        ...(options?.preserveHistory && options.completedLiveOperationIds === undefined
          ? {}
          : {
              completedLiveOperationIds: new Set(
                options?.completedLiveOperationIds ?? [],
              ),
            }),
        selectedIds: [],
        liveOverlayReveals: [],
        pendingOverlayReveals,
        editingOverlayId: null,
        collapsedNoteIds: [],
        collapsedCalloutIds: [],
        collapsedThreadIds: [],
        activePageId: model.pages[initialPageIndex]?.id ?? model.pages[0]?.id ?? null,
        pageJump: null,
        outlineSelection: null,
        searchMatchHighlight: null,
        ...(options?.showThumbs === undefined
          ? {}
          : { showThumbs: options.showThumbs }),
        ...(options?.readerMode === undefined
          ? {}
          : { readerMode: options.readerMode }),
      });
    },
  };
}
