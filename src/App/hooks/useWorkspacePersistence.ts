import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { getRecent } from "../../editor/recentDocs";
import { draftIdFor } from "../../storage/draftIdentity";
import {
  protectOpenDrafts,
  republishOpenDrafts,
} from "../../storage/draftProtection";
import {
  cleanupWorkspaceSources,
  saveWorkspaceState,
  type WorkspaceTabMeta,
} from "../../storage/workspace";
import {
  protectWorkspaceSources,
  releaseWorkspaceSource,
  republishWorkspaceSources,
  reservedWorkspaceSourceIds,
  workspaceSourcesOfOtherWindows,
} from "../../storage/workspaceSourceReservations";

/** The draft a tab reads and writes: its bytes, from its source (fact 4). */
function draftIdOf(meta: WorkspaceTabMeta): string[] {
  return meta.hash ? [draftIdFor(meta.hash, meta.source)] : [];
}

interface WorkspacePersistenceParams<T> {
  tabs: T[];
  activeTabId: string | null;
  /** Latest tabs, read inside the debounced cleanup timer. */
  getTabs: () => T[];
  toMeta: (tab: T) => WorkspaceTabMeta;
  cacheIdsForTab: (tab: T) => string[];
  /** Mounted folder roots, persisted alongside the tabs. */
  folderPaths: readonly string[];
  onSaveError?: () => void;
}

/**
 * Workspace tab persistence lifecycle: persist the
 * tab set + active tab on every change, and debounce-sweep orphaned workspace
 * cache sources whenever the set of protected cache ids changes.
 *
 * Deliberately generic over the runtime tab type `T`, with the two tab->data
 * mappers injected as parameters. That keeps the App-local `WorkspaceRuntimeTab`
 * type (used in ~50 sites) in App rather than cascading it into a shared module
 * just to move ~30 lines of effects — the render-coupled tab STATE and its
 * manipulation callbacks stay in App by design; only this persistence lifecycle
 * moves out. Moved verbatim from the App God-component.
 */
export function useWorkspacePersistence<T>({
  tabs,
  activeTabId,
  getTabs,
  toMeta,
  cacheIdsForTab,
  folderPaths,
  onSaveError,
}: WorkspacePersistenceParams<T>): void {
  const saveFailureReportedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const saveLatestRef = useRef<() => void>(() => undefined);
  const saveCurrent = useCallback(() => {
    const saved = saveWorkspaceState({
      version: 1,
      activeTabId,
      tabs: tabs.map(toMeta),
      ...(folderPaths.length > 0 ? { folderPaths: [...folderPaths] } : {}),
    });
    if (saved) {
      saveFailureReportedRef.current = false;
    } else if (!saveFailureReportedRef.current) {
      saveFailureReportedRef.current = true;
      onSaveError?.();
    }
  }, [activeTabId, folderPaths, onSaveError, tabs, toMeta]);

  useEffect(() => {
    saveLatestRef.current = saveCurrent;
  }, [saveCurrent]);

  useEffect(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveLatestRef.current();
    }, 250);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [saveCurrent]);

  useEffect(() => {
    const flush = () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      saveLatestRef.current();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // Draft LRU eviction keeps the drafts of every open tab. A layout effect,
  // so the provider is in place before App's startup draft cleanup runs.
  useLayoutEffect(
    () =>
      protectOpenDrafts(() => getTabs().flatMap((tab) => draftIdOf(toMeta(tab)))),
    [getTabs, toMeta],
  );
  // The provider is read lazily here, but other windows see only what was
  // last published: republish when the set changes, not on the next beat.
  const openDraftKey = useMemo(
    () => tabs.flatMap((tab) => draftIdOf(toMeta(tab))).sort().join("\0"),
    [tabs, toMeta],
  );
  useLayoutEffect(() => republishOpenDrafts(), [openDraftKey]);

  const protectedWorkspaceCacheKey = useMemo(
    () => tabs.flatMap(cacheIdsForTab).sort().join("\0"),
    [tabs, cacheIdsForTab],
  );
  // Other windows sweep the same cache rows; they keep what this one holds.
  useLayoutEffect(
    () => protectWorkspaceSources(() => getTabs().flatMap(cacheIdsForTab)),
    [getTabs, cacheIdsForTab],
  );
  useLayoutEffect(() => republishWorkspaceSources(), [protectedWorkspaceCacheKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const currentTabs = getTabs();
      const protectedCacheIds = new Set(currentTabs.flatMap(cacheIdsForTab));
      for (const entry of getRecent()) {
        if (entry.cacheId) protectedCacheIds.add(entry.cacheId);
      }
      // A still-opening document's row is protected by its reservation until
      // a tab or recent references it; from then on those protect it.
      for (const id of reservedWorkspaceSourceIds()) {
        if (protectedCacheIds.has(id)) releaseWorkspaceSource(id);
        else protectedCacheIds.add(id);
      }
      // Another window may reserve a row while the sweep runs: ask again.
      void cleanupWorkspaceSources({
        has: (id) =>
          protectedCacheIds.has(id) ||
          reservedWorkspaceSourceIds().includes(id) ||
          workspaceSourcesOfOtherWindows().includes(id),
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [protectedWorkspaceCacheKey, cacheIdsForTab, getTabs]);
}
