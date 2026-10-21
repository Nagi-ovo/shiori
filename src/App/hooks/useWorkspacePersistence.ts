import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { getRecent } from "../../editor/recentDocs";
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
  releaseWorkspaceSource,
  reservedWorkspaceSourceIds,
} from "../../storage/workspaceSourceReservations";

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
      protectOpenDrafts(() =>
        getTabs().flatMap((tab) => toMeta(tab).hash ?? []),
      ),
    [getTabs, toMeta],
  );
  // The provider is read lazily here, but other windows see only what was
  // last published: republish when the set changes, not on the next beat.
  const openDraftKey = useMemo(
    () => tabs.flatMap((tab) => toMeta(tab).hash ?? []).sort().join("\0"),
    [tabs, toMeta],
  );
  useLayoutEffect(() => republishOpenDrafts(), [openDraftKey]);

  const protectedWorkspaceCacheKey = useMemo(
    () => tabs.flatMap(cacheIdsForTab).sort().join("\0"),
    [tabs, cacheIdsForTab],
  );

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
      void cleanupWorkspaceSources(protectedCacheIds);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [protectedWorkspaceCacheKey, cacheIdsForTab, getTabs]);
}
