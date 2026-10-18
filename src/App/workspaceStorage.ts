import type { LoadedDocumentPayload } from "../documents/types";
import { getRecent, type RecentEntry } from "../editor/recentDocs";
import { repairRuntimeSessions } from "../storage/runtimeSessions";
import {
  putWorkspaceSource,
  removeWorkspaceSource,
  saveWorkspaceState,
} from "../storage/workspace";
import { metaFromRuntimeTab, workspaceStore } from "../workspace/appWorkspace";
import { workspaceCacheIdsForTab } from "../workspace/tabSources";
import type { WorkspaceRuntimeTab } from "../workspace/types";

export function cacheSourceIsReferenced(
  cacheId: string,
  tabs: WorkspaceRuntimeTab[],
  recentEntries: RecentEntry[] = getRecent(),
): boolean {
  return (
    tabs.some((tab) => workspaceCacheIdsForTab(tab).includes(cacheId)) ||
    recentEntries.some((entry) => entry.cacheId === cacheId)
  );
}

/** Saves the workspace record now; false means it did not persist. */
export function persistWorkspaceMetadataNow(): boolean {
  const { activeTabId, tabs, folderPaths } = workspaceStore().getState();
  return saveWorkspaceState({
    version: 1,
    activeTabId,
    tabs: tabs.map(metaFromRuntimeTab),
    ...(folderPaths.length > 0 ? { folderPaths: [...folderPaths] } : {}),
  });
}

// Returns the real IndexedDB promise so a caller that must know whether the
// row actually went away (the merge abandon path) can await it. The other
// call sites are fire-and-forget and ignore it.
export function removeWorkspaceSourceIfUnreferenced(
  cacheId: string,
  tabsSnapshot: WorkspaceRuntimeTab[] = workspaceStore().getState().tabs,
): Promise<void> {
  if (cacheSourceIsReferenced(cacheId, tabsSnapshot)) return Promise.resolve();
  return removeWorkspaceSource(cacheId);
}

/** Cache rows a tab or a recents entry still points at. */
export function protectedWorkspaceCacheIds(
  tabsSnapshot: WorkspaceRuntimeTab[] = workspaceStore().getState().tabs,
): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabsSnapshot) {
    for (const cacheId of workspaceCacheIdsForTab(tab)) ids.add(cacheId);
  }
  for (const entry of getRecent()) {
    if (entry.cacheId) ids.add(entry.cacheId);
  }
  return ids;
}

/** Gives a document with no origin (a drop, a paste) a cache copy to reopen from. */
export async function ensureWorkspaceSource(
  payload: LoadedDocumentPayload,
): Promise<LoadedDocumentPayload> {
  if (payload.path || payload.webFileHandleId || payload.cacheId) {
    return payload;
  }
  const cacheId = await putWorkspaceSource(
    {
      kind: payload.kind,
      name: payload.name,
      size: payload.size,
      bytes: payload.bytes,
    },
    protectedWorkspaceCacheIds(),
  );
  return { ...payload, cacheId };
}

let runtimeRepair: Promise<void> | null = null;

/**
 * Startup repair of suspended PDF sessions, run once: recounts references
 * and removes orphan rows. Cold restores wait on it.
 */
export function ensureRuntimeStorageRepaired(): Promise<void> {
  runtimeRepair ??= repairRuntimeSessions(
    new Set(workspaceStore().getState().tabs.map((tab) => tab.id)),
  ).catch((error) => {
    console.warn("Failed to repair suspended PDF runtime storage", error);
  });
  return runtimeRepair;
}
