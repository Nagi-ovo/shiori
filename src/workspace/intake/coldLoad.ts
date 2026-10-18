import type { RuntimeSessionRecord } from "../../storage/runtimeSessions";
import { documentSourcePayloadFields } from "../tabSources";
import type { WorkspaceRuntimeTab } from "../types";
import { openDocument } from "./openDocument";
import type { TabSourceRead } from "./readTabSource";
import type { IntakePorts } from "./types";

export type ColdLoadPorts = IntakePorts & {
  readTabSource: (tab: WorkspaceRuntimeTab) => Promise<TabSourceRead>;
  readRuntimeSession: (tabId: string) => Promise<RuntimeSessionRecord | null>;
  /**
   * Startup repair recalculates refcounts and removes orphan rows. A cold
   * restore must never race it and misclassify a protected blob as missing.
   */
  storageRepaired: () => Promise<void>;
  /** The password a suspended encrypted tab was unlocked with, if any. */
  credential: (tabId: string) => string | undefined;
  /** Tells the reader the restore failed, with a way to pick the file again. */
  reportRestoreFailed: (tab: WorkspaceRuntimeTab, detail: string) => void;
};

/**
 * Tabs whose restore gave up because a newer open claimed the screen. Only
 * such a tab may be reset from "loading": a password-protected one also
 * returns while still loading, with its dialog up, and resetting that would
 * re-prompt in a loop.
 */
const supersededLoads = new Set<string>();

export function markSupersededLoad(tabId: string): void {
  supersededLoads.add(tabId);
}

const needsLoad = (tab: WorkspaceRuntimeTab | undefined) =>
  tab?.status === "unloaded" || tab?.status === "suspended";

/**
 * Loads the tab on screen if it holds no document yet: a saved workspace's
 * active tab on launch, a tab switched to after it was suspended or never
 * opened, a retry. Every path that can put such a tab on screen calls this.
 */
export function loadActiveTab(ports: ColdLoadPorts): void {
  const { tabs, activeTabId } = ports.store.getState();
  const tab = tabs.find((candidate) => candidate.id === activeTabId);
  if (tab && needsLoad(tab)) void coldLoadTab(tab.id, ports);
}

/**
 * Settles a restore that gave up. A tab left saying "loading" is one this
 * module refuses to re-enter, so it goes back to "unloaded" — and if it is
 * still the one on screen, it loads again.
 */
export function settleSupersededLoad(
  tabId: string | undefined,
  ports: ColdLoadPorts,
): void {
  if (!tabId || !supersededLoads.delete(tabId)) return;
  ports.store
    .getState()
    .updateTab(tabId, (tab) =>
      tab.status === "loading" ? { ...tab, status: "unloaded" } : tab,
    );
  loadActiveTab(ports);
}

/** Reads a tab's bytes back (suspended session first, then its source) and opens them. */
export async function coldLoadTab(
  tabId: string,
  ports: ColdLoadPorts,
): Promise<void> {
  const { store } = ports;
  const tab = store.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !needsLoad(tab)) return;
  store.getState().updateTab(tabId, (current) => ({ ...current, status: "loading" }));
  const isOnScreen = () =>
    store.getState().activeTabId === tabId &&
    store.getState().tabs.some((candidate) => candidate.id === tabId);
  try {
    await ports.storageRepaired();
    const suspended =
      tab.kind === "pdf" ? await ports.readRuntimeSession(tabId) : null;
    const loaded: TabSourceRead = suspended
      ? {
          payload: {
            kind: "pdf",
            name: tab.title,
            size: suspended.bytes.byteLength,
            bytes: suspended.bytes,
            ...documentSourcePayloadFields(tab.source),
          },
        }
      : await ports.readTabSource(tab);
    await openDocument(
      loaded.payload,
      {
        tabId,
        pdfView: tab.pdfView,
        runtimeSnapshot: suspended?.snapshot,
        pdfPassword: ports.credential(tabId),
        textView: tab.textView,
        workingCopyCacheId: loaded.workingCopyCacheId,
        skipDuplicateCheck: true,
        shouldActivate: isOnScreen,
      },
      ports,
    );
    if (supersededLoads.has(tabId)) {
      settleSupersededLoad(tabId, ports);
    } else if (!isOnScreen()) {
      // The reader left before it finished; it loads again when they return.
      store
        .getState()
        .updateTab(tabId, (current) =>
          current.status === "loading" ? { ...current, status: "unloaded" } : current,
        );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (store.getState().tabs.some((candidate) => candidate.id === tabId)) {
      store.getState().updateTab(tabId, (current) => ({
        ...current,
        status: "unavailable",
        unavailableDetail: detail,
        updatedAt: Date.now(),
      }));
    }
    if (store.getState().activeTabId === tabId) {
      ports.editors.detach();
      store.getState().setSession({
        activeHash: null,
        exportBaselineSnapshot: null,
        lastExport: null,
      });
      ports.reportRestoreFailed(tab, detail);
    }
  }
}
