import type { PdfEditorStoreApi } from "./store";
import {
  getTabEditorStore,
  leastRecentlyUsedTabEditorStore,
  residentTabEditorStoreCount,
} from "./tabStoreRegistry";

export type ResidentAdmissionResult =
  | { admitted: true; evictedTabId: string | null }
  | { admitted: false; reason: "no-victim" | "eviction-failed"; error?: unknown };

export async function reserveResidentPdfSlot(options: {
  targetTabId: string;
  residentLimit: number;
  activeTabId: string | null;
  suspend: (tabId: string, store: PdfEditorStoreApi) => Promise<void>;
}): Promise<ResidentAdmissionResult> {
  if (getTabEditorStore(options.targetTabId)) {
    return { admitted: true, evictedTabId: null };
  }
  if (residentTabEditorStoreCount() < options.residentLimit) {
    return { admitted: true, evictedTabId: null };
  }
  const excluded = new Set([options.targetTabId]);
  // Prefer every inactive resident. With a positive limit there should always
  // be one once more than one tab exists; keeping the visible document alive
  // also ensures a failed admission leaves the screen untouched.
  if (options.activeTabId) excluded.add(options.activeTabId);
  const victim = leastRecentlyUsedTabEditorStore(excluded);
  if (!victim) return { admitted: false, reason: "no-victim" };
  try {
    await options.suspend(victim.tabId, victim.store);
  } catch (error) {
    return { admitted: false, reason: "eviction-failed", error };
  }
  if (getTabEditorStore(victim.tabId)) {
    return {
      admitted: false,
      reason: "eviction-failed",
      error: new Error("Suspended resident still exists in the registry"),
    };
  }
  return { admitted: true, evictedTabId: victim.tabId };
}
