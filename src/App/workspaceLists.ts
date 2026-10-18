import type { DocumentTreeItem } from "../editor/components/DocumentTree";
import type {
  TabStripItem,
  TabStripPreview,
} from "../editor/components/TabStrip";
import type { WorkspaceSwitcherItem } from "../editor/components/WorkspaceSwitcher";
import {
  exportSnapshotKey,
  resolveExportStatus,
} from "../editor/export/exportStatus";
import { getRecent, recentMatchesFile } from "../editor/recentDocs";
import type { PdfEditorStoreApi } from "../editor/store/store";
import { getTabEditorStore } from "../editor/store/tabStoreRegistry";
import { readTabPreview } from "../storage/tabPreviews";
import { workspaceStore } from "../workspace/appWorkspace";
import type { WorkspaceRuntimeTab } from "../workspace/types";
import { appPdfRuntime } from "./pdfRuntimePorts";
import { documentTextPreview, recentPreviewFields } from "./textRecents";

// Export status for a tab that is NOT the active one, computed from its
// resident store or suspended snapshot marker. The active tab keeps using the
// live `exportStatus` memo.
export function inactiveTabNeedsExport(
  tab: WorkspaceRuntimeTab,
  store: PdfEditorStoreApi | undefined = getTabEditorStore(tab.id),
): boolean {
  if (tab.kind !== "pdf") return false;
  const model = store?.getState().model;
  const baseline = tab.exportBaselineSnapshot;
  const snapshotKey = model
    ? exportSnapshotKey(model)
    : tab.suspendedSnapshotKey;
  if (!snapshotKey || !baseline) return false;
  return (
    resolveExportStatus({
      documentHash: tab.hash ?? null,
      snapshotKey,
      hasChanges: snapshotKey !== baseline,
      lastExport: tab.lastExport ?? null,
    }).kind === "needsExport"
  );
}

/** The tab strip's rows, in the reader's order. */
export function tabStripItems(
  tabs: WorkspaceRuntimeTab[],
  activeTabId: string | null,
  needsExport: (tab: WorkspaceRuntimeTab) => boolean = inactiveTabNeedsExport,
): TabStripItem[] {
  return tabs.map((tab) => ({
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    // Same marker, two meanings by kind: a PDF is dirty when it has edits not
    // yet exported, a text document when it has edits not yet written back to
    // its file. Both answer the reader's question "is what I see in the file?".
    // The PDF on screen reads its status live (PdfExportAwareTabStrip); every
    // other PDF keeps its marker, or switching away from unexported edits
    // made the dot vanish and closing it warned about nothing.
    dirty:
      tab.kind === "pdf"
        ? tab.id !== activeTabId && needsExport(tab)
        : tab.textDirty === true,
    unavailable: tab.status === "unavailable",
    // Overflow order: when the strip cannot hold every tab at a readable
    // width, the least recently used ones fold into the ⋯ +N chip first.
    updatedAt: tab.updatedAt,
  }));
}

/**
 * The navigator's documents view. Flat and ordered by recency — it is a
 * reading history, not a directory listing; folder nesting is a separate view
 * (P1c) that needs directory IPC we do not have yet.
 */
export function documentTreeItems(tabs: WorkspaceRuntimeTab[]): DocumentTreeItem[] {
  return [...tabs]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
      ...(tab.source.type === "path" ? { path: tab.source.path } : {}),
      pinned: tab.pinned === true,
      unavailable: tab.status === "unavailable",
    }));
}

/**
 * Ctrl+Tab quick switcher: the document on screen first, then the most
 * recently touched — comparative reading flips between two documents most of
 * the time, so one tap must return to the previous one.
 */
export function switcherItems(
  tabs: WorkspaceRuntimeTab[],
  activeTabId: string | null,
): WorkspaceSwitcherItem[] {
  return [
    ...tabs.filter((tab) => tab.id === activeTabId),
    ...tabs
      .filter((tab) => tab.id !== activeTabId)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  ].map((tab) => ({
    id: tab.id,
    title: tab.title,
    kind: tab.kind,
    thumbKey:
      tab.source.type === "path"
        ? tab.source.path
        : tab.source.type === "webFileHandle" || tab.source.type === "cache"
          ? tab.source.id
          : tab.title,
    pageNumber:
      tab.kind === "pdf" && tab.pdfView ? tab.pdfView.pageIndex + 1 : undefined,
  }));
}

/** What hovering a tab previews: a PDF's stored page, a text excerpt. */
export async function requestTabPreview(
  tabId: string,
): Promise<TabStripPreview | null> {
  await appPdfRuntime().previewWritten(tabId);
  const tab = workspaceStore().getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return null;
  if (tab.kind === "pdf") {
    const stored = await readTabPreview(tabId);
    return {
      ...(stored?.imageUrl ? { imageUrl: stored.imageUrl } : {}),
      pageNumber: stored?.pageNumber ?? (tab.pdfView?.pageIndex ?? 0) + 1,
      scale: stored?.scale ?? tab.pdfView?.scale ?? 1,
    };
  }
  const recent = getRecent().find((entry) =>
    recentMatchesFile(entry, { name: tab.title, size: tab.size, hash: tab.hash }),
  );
  if (tab.kind === "markdown") {
    return {
      textPreview: tab.text ? documentTextPreview(tab.text) : recent?.textPreview,
      scale: tab.textView?.zoom ?? 1,
    };
  }
  if (tab.kind === "html") {
    return {
      htmlPreview: tab.text
        ? recentPreviewFields(tab.text, "html").htmlPreview
        : recent?.htmlPreview,
      scale: tab.textView?.zoom ?? 1,
    };
  }
  return { scale: tab.textView?.zoom ?? 1 };
}
