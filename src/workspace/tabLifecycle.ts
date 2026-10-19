import type { WorkspaceRuntimeTab } from "./types";
import type { WorkspaceStore } from "./workspaceStore";

/**
 * Switching to and closing workspace tabs.
 *
 * Both flows await persistence (text write-back, the PDF draft) before they
 * change what is on screen, and anything can happen during those awaits: the
 * reader clicks another tab, a queued close runs, an open lands. So both
 * re-read the store after every await and never publish a snapshot taken
 * before it. Side effects outside the workspace go through ports so the flows
 * can be tested with fakes. See docs/PLAN-APP-ARCHITECTURE-2026-09.md.
 */

type Tab = WorkspaceRuntimeTab;

export type ActivateTabPorts = {
  store: WorkspaceStore;
  flushTextSources: (tabId: string | undefined) => Promise<void>;
  /** Persists the visible PDF; false means it could not, so stay put. */
  persistActivePdf: () => Promise<boolean>;
  /** Clears per-document UI state (password prompt, errors) before the swap. */
  beforeActivate: () => void;
  applyActivation: (target: Tab | null) => void;
  setTransitioning: (transitioning: boolean) => void;
};

export async function activateTab(
  tabId: string,
  ports: ActivateTabPorts,
): Promise<void> {
  const { store } = ports;
  // Claimed even for a no-op click: the click still supersedes in-flight
  // opens, which then finish in the background.
  const claim = store.getState().claimNavigation();
  const target = store.getState().tabs.find((tab) => tab.id === tabId);
  if (!target || tabId === store.getState().activeTabId) return;
  ports.setTransitioning(true);
  try {
    await ports.flushTextSources(store.getState().activeTabId ?? undefined);
    if (!(await ports.persistActivePdf())) return;
    // The reader's latest choice wins, not whichever flow finishes last.
    if (!claim.isCurrent()) return;
    // The tab may have been closed or rewritten while the flushes ran.
    const freshTarget = store.getState().tabs.find((tab) => tab.id === tabId);
    if (!freshTarget) return;
    ports.beforeActivate();
    ports.applyActivation(freshTarget);
  } finally {
    ports.setTransitioning(false);
  }
}

export type GoHomePorts = {
  store: WorkspaceStore;
  /**
   * Persists the document on screen (PDF draft or text write-back) and
   * reports its own failure; false means stay on it.
   */
  persistActive: () => Promise<boolean>;
  /** See CloseTabPorts.recordTextRecent. */
  recordTextRecent: (tab: Tab) => boolean;
  reportTextSaveFailed: () => void;
  clearPasswordPrompt: () => void;
  applyActivation: (target: Tab | null) => void;
};

/**
 * Leaves the documents for the home screen. Tabs stay open and resident; only
 * the screen changes.
 */
export async function goHome(ports: GoHomePorts): Promise<void> {
  const { store } = ports;
  const claim = store.getState().claimNavigation();
  if (store.getState().activeTabId) {
    if (!(await ports.persistActive())) return;
    if (!claim.isCurrent()) return;
    // The landing lists recents, so every open text tab must be reachable
    // from there. PDFs record on open with their real page count.
    let recorded = true;
    for (const tab of store.getState().tabs) {
      if (!ports.recordTextRecent(tab)) recorded = false;
    }
    if (!recorded) {
      ports.reportTextSaveFailed();
      return;
    }
    ports.clearPasswordPrompt();
  }
  ports.applyActivation(null);
}

export type CloseTabPorts = {
  store: WorkspaceStore;
  flushTextSources: (tabId: string) => Promise<void>;
  /**
   * Records a text document in recents; true for anything that needs no
   * record. False means there is no way back to its unsaved text, so the
   * close must stop.
   */
  recordTextRecent: (tab: Tab) => boolean;
  /** Cancels pending text write-back timers and bookkeeping for the tab. */
  discardTextSourceState: (tabId: string) => void;
  flushActiveDraft: () => Promise<void>;
  activeNeedsExport: () => boolean;
  inactiveNeedsExport: (tab: Tab) => boolean;
  /** The engine's document on screen, captured before the tab list changes. */
  captureActiveDocument: (tabId: string) => unknown;
  releaseCaches: (tab: Tab, remaining: Tab[]) => void;
  releaseRuntime: (tab: Tab, activeDocument: unknown) => Promise<void>;
  reportTextSaveFailed: (tab: Tab, error?: unknown) => void;
  reportDraftSaveFailed: (tab: Tab, error: unknown) => void;
  reportClosedUnexported: (tab: Tab) => void;
  clearPasswordPrompt: () => void;
  applyActivation: (target: Tab | null) => void;
};

type Snapshot = {
  tabs: Tab[];
  activeTabId: string | null;
  index: number;
  closing: Tab | undefined;
};

function snapshot(store: WorkspaceStore, tabId: string): Snapshot {
  const { tabs, activeTabId } = store.getState();
  const index = tabs.findIndex((tab) => tab.id === tabId);
  return { tabs, activeTabId, index, closing: tabs[index] };
}

/** Closes one tab. Callers serialize calls (App queues them). */
export async function closeTab(
  tabId: string,
  ports: CloseTabPorts,
): Promise<void> {
  const { store } = ports;
  let current = snapshot(store, tabId);
  if (!current.closing) return;

  if (current.closing.kind === "markdown" || current.closing.kind === "html") {
    try {
      await ports.flushTextSources(tabId);
    } catch (error) {
      ports.reportTextSaveFailed(current.closing, error);
      return;
    }
    // The flush may replace a browser/file-handle source with the freshly
    // written cache entry. Re-read before recording recents or deciding which
    // cache is still referenced.
    current = snapshot(store, tabId);
    if (!current.closing) return;
    if (!ports.recordTextRecent(current.closing)) {
      ports.reportTextSaveFailed(current.closing);
      return;
    }
  }

  ports.discardTextSourceState(tabId);
  if (tabId === current.activeTabId && current.closing.kind === "pdf") {
    try {
      await ports.flushActiveDraft();
    } catch (error) {
      ports.reportDraftSaveFailed(current.closing, error);
      return;
    }
    // The flush yields to tab activation and queued close clicks. Never
    // publish the pre-flush snapshot after another transition changed it.
    current = snapshot(store, tabId);
    if (!current.closing) return;
    // A draft is not an exported PDF. Closing with unexported changes is
    // allowed; the cue says reopening restores the draft and exporting is what
    // produces a shareable file.
    if (ports.activeNeedsExport()) ports.reportClosedUnexported(current.closing);
  } else if (
    current.closing.kind === "pdf" &&
    ports.inactiveNeedsExport(current.closing)
  ) {
    ports.reportClosedUnexported(current.closing);
  }

  const { closing, activeTabId, index } = current;
  const wasActive = tabId === activeTabId;
  const activeDocument =
    wasActive && closing.kind === "pdf"
      ? ports.captureActiveDocument(tabId)
      : null;
  const remaining = current.tabs.filter((tab) => tab.id !== tabId);
  ports.releaseCaches(closing, remaining);
  store.setState({ tabs: remaining });
  if (wasActive) {
    // The neighbour goes on screen in the same tick the tab leaves the list.
    // Releasing the runtime waits on IndexedDB for several frames; until then
    // the screen would point at a tab that no longer exists and show home.
    const next = remaining[Math.min(index, remaining.length - 1)] ?? null;
    ports.clearPasswordPrompt();
    // A suspended next tab gets the same empty loading boundary as an explicit
    // tab click, and loads the same way (planTabActivation's last step).
    ports.applyActivation(next);
  }
  await ports.releaseRuntime(closing, activeDocument);
}
