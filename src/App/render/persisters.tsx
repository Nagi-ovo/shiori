import { useEffect, useRef } from "react";
import type { DocumentSource } from "../../documents/types";
import { updateRecentLastPage } from "../../editor/recentDocs";
import { useAppStore, useEditorStore } from "../../editor/store/store";
import { updateTab } from "../../workspace/appWorkspace";
import type { DocumentModel } from "../../pdf/model/types";
import type { PendingRestore, WorkspaceRuntimeTab } from "../../workspace/types";

const VIEW_STATE_PERSIST_DEBOUNCE_MS = 250;

// Debounced sync of the live PDF view state onto the workspace tab. A
// null-rendering component rather than an effect in App so that `scale` and
// `fitMode` — which change on every zoom tick — re-render only this stub
// instead of the whole App tree. That render-level subscription was why
// zooming made the right rail flicker.
export function PdfViewStatePersister({
  activeHash,
  activeTabId,
  activeTabKind,
}: {
  activeHash: string | null;
  activeTabId: string | null;
  activeTabKind: WorkspaceRuntimeTab["kind"] | undefined;
}) {
  const opened = useEditorStore((s) => s.opened);
  const pages = useEditorStore((s) => s.model.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const collapsedNoteIds = useEditorStore((s) => s.collapsedNoteIds);
  const collapsedCalloutIds = useEditorStore((s) => s.collapsedCalloutIds);
  const scale = useEditorStore((s) => s.scale);
  const fitMode = useEditorStore((s) => s.fitMode);
  const railTab = useAppStore((s) => s.railTab);
  const readerMode = useEditorStore((s) => s.readerMode);
  const showRail = useAppStore((s) => s.showRail);
  const showThumbs = useEditorStore((s) => s.showThumbs);

  useEffect(() => {
    if (!activeTabId || activeTabKind !== "pdf" || !opened) return;
    const pageIndex = Math.max(
      0,
      pages.findIndex((page) => page.id === activePageId),
    );
    const handle = window.setTimeout(() => {
      updateTab(activeTabId, (tab) => ({
        ...tab,
        hash: activeHash ?? tab.hash,
        pdfView: {
          pageIndex,
          scale,
          fitMode,
          showThumbs,
          showRail,
          railTab,
          readerMode,
          collapsedNoteIds,
          collapsedCalloutIds,
        },
        updatedAt: Date.now(),
      }));
    }, VIEW_STATE_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    activeHash,
    activePageId,
    activeTabKind,
    activeTabId,
    opened,
    pages,
    collapsedNoteIds,
    collapsedCalloutIds,
    scale,
    fitMode,
    railTab,
    readerMode,
    showRail,
    showThumbs,
  ]);

  return null;
}

// Keep the rapid page-navigation subscription out of App. Reading position
// persistence has no visual output, so a page turn should re-render only this
// debounced side-effect boundary rather than the full application shell.
export function RecentPdfPagePersister({
  activeSource,
}: {
  activeSource: DocumentSource | null;
}) {
  const opened = useEditorStore((s) => s.opened);
  const pages = useEditorStore((s) => s.model.pages);
  const activePageId = useEditorStore((s) => s.activePageId);

  useEffect(() => {
    if (!opened || !activePageId) return;
    const idx = pages.findIndex((page) => page.id === activePageId);
    if (idx < 0) return;
    const cacheKey =
      activeSource?.type === "cache" ? activeSource.id : opened.cacheId;
    const key =
      opened.path ?? opened.webFileHandleId ?? cacheKey ?? opened.fileName;
    const handle = window.setTimeout(() => {
      updateRecentLastPage(key, idx);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [activePageId, activeSource, opened, pages]);

  return null;
}

export function DeferredDraftEditWatcher({
  deferredDraft,
  onEdit,
}: {
  deferredDraft: PendingRestore | null;
  onEdit: (draft: PendingRestore) => void;
}) {
  const model = useEditorStore((state) => state.model);
  // The document as it was when the draft was set aside. Only a change from
  // it is a new edit: dismissing the conflict sets the draft aside again with
  // the edit that raised it already applied, and counting that edit reopened
  // the dialog at once.
  const setAsideRef = useRef<{ draft: PendingRestore; model: DocumentModel } | null>(null);
  useEffect(() => {
    if (!deferredDraft) {
      setAsideRef.current = null;
      return;
    }
    const setAside = setAsideRef.current;
    if (setAside?.draft !== deferredDraft) {
      setAsideRef.current = { draft: deferredDraft, model };
      return;
    }
    if (model !== setAside.model) onEdit(deferredDraft);
  }, [deferredDraft, model, onEdit]);
  return null;
}
