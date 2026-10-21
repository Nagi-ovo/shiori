import type { ExportedSnapshot } from "../editor/export/exportStatus";
import { CAPABILITIES } from "../platform";
import {
  patchWorkspaceTextView,
  type WorkspaceTabMeta,
  type WorkspaceTextViewState,
} from "../storage/workspace";
import { loadSavedWorkspace } from "./savedWorkspace";
import type {
  PendingRestore,
  RestoredDraftNotice,
  WorkspaceRuntimeTab,
} from "./types";
import { createWorkspaceStore, type WorkspaceStore } from "./workspaceStore";

let workspaceSingleton: WorkspaceStore | null = null;

/**
 * The app's workspace store (docs/PLAN-APP-ARCHITECTURE-2026-09.md).
 * Module-level so async callbacks read the latest state without a hook
 * dependency; created on first use because the saved workspace is read from
 * storage.
 */
export function workspaceStore(): WorkspaceStore {
  if (!workspaceSingleton) {
    const saved = loadSavedWorkspace();
    workspaceSingleton = createWorkspaceStore({
      tabs: saved.tabs.map(runtimeTabFromMeta),
      activeTabId: saved.activeTabId,
      folderPaths: CAPABILITIES.nativePaths ? saved.folderPaths ?? [] : [],
    });
  }
  return workspaceSingleton;
}

/** Subscribes a component to one slice of the workspace store. */
export function useWorkspace<T>(
  selector: (state: ReturnType<WorkspaceStore["getState"]>) => T,
): T {
  return workspaceStore()(selector);
}

/** The tab on screen, or null between documents. */
export function useActiveWorkspaceTab(): WorkspaceRuntimeTab | null {
  return useWorkspace(
    (state) => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
  );
}

export function setActiveHash(next: string | null): void {
  workspaceStore().getState().setSession({ activeHash: next });
}
export function setExportBaselineSnapshot(next: string | null): void {
  workspaceStore().getState().setSession({ exportBaselineSnapshot: next });
}
export function setLastExport(next: ExportedSnapshot | null): void {
  workspaceStore().getState().setSession({ lastExport: next });
}
export function setPendingRestore(next: PendingRestore | null): void {
  workspaceStore().getState().setSession({ pendingRestore: next });
}
export function setDeferredDraft(next: PendingRestore | null): void {
  workspaceStore().getState().setSession({ deferredDraft: next });
}
export function setRestoredDraft(next: RestoredDraftNotice | null): void {
  workspaceStore().getState().setSession({ restoredDraft: next });
}

export function setActiveWorkspaceTabId(tabId: string | null): void {
  workspaceStore().getState().setActiveTab(tabId);
}
export function updateTab(
  tabId: string,
  updater: (tab: WorkspaceRuntimeTab) => WorkspaceRuntimeTab,
): void {
  workspaceStore().getState().updateTab(tabId, updater);
}
export function currentWorkspaceTabs(): WorkspaceRuntimeTab[] {
  return workspaceStore().getState().tabs;
}

function runtimeTabFromMeta(meta: WorkspaceTabMeta): WorkspaceRuntimeTab {
  return { ...meta, status: "unloaded" };
}

/** The part of a tab that is saved with the workspace. */
export function metaFromRuntimeTab(tab: WorkspaceRuntimeTab): WorkspaceTabMeta {
  return {
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    size: tab.size,
    source: tab.source,
    workingCopyCacheId: tab.workingCopyCacheId,
    // Same reason as the export fields below: an unsaved text edit must still
    // look unsaved after a restart, not silently clean.
    textDirty: tab.textDirty,
    hash: tab.hash,
    // What the file held, so restored edits can tell whether it changed since.
    sourceHash: tab.sourceHash,
    pinned: tab.pinned,
    pdfView: tab.pdfView,
    textView: tab.textView,
    // Persisted so the tab strip's unexported marker and the close warning
    // survive a restart; without these a restored tab always looked
    // unexported, then warned once on close.
    exportBaselineSnapshot: tab.exportBaselineSnapshot,
    lastExport: tab.lastExport,
    updatedAt: tab.updatedAt,
  };
}

/**
 * Updates a text or Word tab's view state (zoom, scroll, Markdown mode).
 * `unchanged` answers whether the tab already shows this, so a no-op scroll
 * report does not bump `updatedAt` and re-save the workspace.
 */
export function patchTabTextView(
  tabId: string,
  patch: Partial<WorkspaceTextViewState>,
  unchanged: (tab: WorkspaceRuntimeTab) => boolean,
): void {
  updateTab(tabId, (tab) =>
    unchanged(tab)
      ? tab
      : {
          ...tab,
          textView: patchWorkspaceTextView(tab.textView, patch),
          updatedAt: Date.now(),
        },
  );
}

export function setTabTextZoom(tabId: string, zoom: number): void {
  patchTabTextView(tabId, { zoom }, (tab) => (tab.textView?.zoom ?? 1) === zoom);
}

export function setTabTextScrollTop(tabId: string, scrollTop: number): void {
  const next = Math.max(0, Math.round(scrollTop));
  patchTabTextView(
    tabId,
    { scrollTop: next },
    (tab) => (tab.textView?.scrollTop ?? 0) === next,
  );
}
