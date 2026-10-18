import { sourceKey } from "../documents/types";
import type { WorkspaceTabMeta } from "../storage/workspace";

function isSameLogicalDocument(
  previous: WorkspaceTabMeta,
  next: WorkspaceTabMeta,
): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.hash && next.hash && previous.hash === next.hash) return true;
  const previousSource = sourceKey(previous.source);
  return Boolean(previousSource && previousSource === sourceKey(next.source));
}
/**
 * Reconstructing an unloaded tab replaces runtime payload, not user metadata.
 * Keep durable state for the same document; a true replacement resets the
 * document-specific export/dirty bookkeeping while preserving the user's pin.
 */
export function mergeReconstructedWorkspaceTab<T extends WorkspaceTabMeta>(
  previous: T,
  next: T,
): T {
  const merged = { ...next, pinned: previous.pinned } as T;
  if (!isSameLogicalDocument(previous, next)) return merged;

  if (next.kind === "pdf") {
    return {
      ...merged,
      exportBaselineSnapshot:
        previous.exportBaselineSnapshot ?? next.exportBaselineSnapshot,
      lastExport: previous.lastExport ?? next.lastExport,
    };
  }

  return {
    ...merged,
    workingCopyCacheId:
      next.workingCopyCacheId ?? previous.workingCopyCacheId,
    textDirty: previous.textDirty,
  };
}

export function replaceOrAppendWorkspaceTab<T extends WorkspaceTabMeta>(
  tabs: T[],
  nextTab: T,
): T[] {
  const index = tabs.findIndex((tab) => tab.id === nextTab.id);
  if (index === -1) return [...tabs, nextTab];
  return tabs.map((tab, candidateIndex) =>
    candidateIndex === index
      ? mergeReconstructedWorkspaceTab(tab, nextTab)
      : tab,
  );
}

/**
 * Apply a completed write-back only while the editor still shows the exact
 * text that reached the source file. A slower, older write must never clear a
 * dirty flag or replace the hash of text typed while it was in flight.
 */
export function applyTextSourceWriteCompletion<
  T extends WorkspaceTabMeta & { text?: string },
>(tab: T, writtenText: string, writtenHash: string): T {
  if (
    (tab.kind !== "markdown" && tab.kind !== "html") ||
    tab.text !== writtenText
  ) {
    return tab;
  }
  if (tab.textDirty !== true && tab.hash === writtenHash) return tab;
  return { ...tab, textDirty: false, hash: writtenHash };
}

/**
 * Commit a freshly (re)built tab and say what the editor's export state must
 * become.
 *
 * finalizeOpen clears lastExport on the way in — correct for a genuinely new
 * document, wrong for a reopen, where the record lives on the tab and has just
 * been carried across by mergeReconstructedWorkspaceTab. Deriving the value
 * here rather than at the call site keeps it on one code path for every route
 * into handleBytes: plain restore, fresh open, and the password retry that
 * re-enters long after loadWorkspaceTab has returned.
 */
export function applyReopenedWorkspaceTab<T extends WorkspaceTabMeta>(
  tabs: T[],
  nextTab: T,
): {
  nextTabs: T[];
  activeTabId: string;
  /** Push back into editor state; null means leave it cleared. */
  restoredLastExport: NonNullable<WorkspaceTabMeta["lastExport"]> | null;
} {
  const nextTabs = replaceOrAppendWorkspaceTab(tabs, nextTab);
  const rebuilt = nextTabs.find((tab) => tab.id === nextTab.id);
  return {
    nextTabs,
    activeTabId: nextTab.id,
    restoredLastExport:
      rebuilt && rebuilt.kind === "pdf" ? (rebuilt.lastExport ?? null) : null,
  };
}
