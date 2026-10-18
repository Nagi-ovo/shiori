import { getRecentLastPage, recordMergedPdfRecent } from "../editor/recentDocs";
import type { PdfEditorStoreApi } from "../editor/store/store";
import { getTabEditorStore } from "../editor/store/tabStoreRegistry";
import { appPdfEngine } from "../pdf/engine/appEngine";
import { putWorkspaceSource } from "../storage/workspace";
import { workspaceStore } from "../workspace/appWorkspace";
import { createPageMerges } from "../workspace/merge/pageMerge";
import { animateOverlays } from "./intakePorts";
import { translate } from "./translate";
import { showPageMergeNotice } from "./workspaceNotices";
import {
  protectedWorkspaceCacheIds,
  removeWorkspaceSourceIfUnreferenced,
} from "./workspaceStorage";

/**
 * Page merges (pasted images, inserted PDFs) on the real engine and cache.
 * App connects the draft flush from an effect.
 */
export function createAppPageMerges(activeEditor: () => PdfEditorStoreApi) {
  const live = { flushActiveDraft: async () => {} };
  const merges = createPageMerges({
    store: workspaceStore(),
    engine: appPdfEngine,
    activeEditor,
    tabEditor: getTabEditorStore,
    flushActiveDraft: () => live.flushActiveDraft(),
    // pdf-lib and the export integrity guard load on the first insert, out
    // of the Landing startup graph (scripts/build/startupBundleGuard.ts).
    insertPages: async (base, incoming, basePageCount, incomingName) => {
      const { insertPdfPages } = await import("../pdf/merge/insertPdf");
      return insertPdfPages(base, incoming, basePageCount, incomingName);
    },
    cache: {
      put: (entry) =>
        putWorkspaceSource({ kind: "pdf", ...entry }, protectedWorkspaceCacheIds()),
      removeIfUnreferenced: (cacheId) =>
        removeWorkspaceSourceIfUnreferenced(cacheId),
    },
    recordMergedRecent: recordMergedPdfRecent,
    lastPage: getRecentLastPage,
    settings: () => ({
      animateOverlays: animateOverlays(),
    }),
    notify: (notice) => showPageMergeNotice(notice, translate),
  });
  return {
    ...merges,
    connect(next: Partial<typeof live>): void {
      Object.assign(live, next);
    },
  };
}
