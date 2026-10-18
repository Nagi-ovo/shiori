import {
  createPdfEditorStore,
  type PdfEditorStoreApi,
} from "./store";
import { recordTabPerfGauge } from "../../perf/tabPerf";

const stores = new Map<string, PdfEditorStoreApi>();
const lastTouched = new Map<string, number>();
let touchClock = 0;

function publishResidentCount(): void {
  recordTabPerfGauge("residentPdfStores", stores.size);
}

export function getTabEditorStore(tabId: string): PdfEditorStoreApi | undefined {
  return stores.get(tabId);
}

export function ensureTabEditorStore(tabId: string): PdfEditorStoreApi {
  const existing = stores.get(tabId);
  if (existing) {
    touchTabEditorStore(tabId);
    return existing;
  }
  const created = createPdfEditorStore();
  stores.set(tabId, created);
  publishResidentCount();
  touchTabEditorStore(tabId);
  return created;
}

export function registerTabEditorStore(
  tabId: string,
  store: PdfEditorStoreApi,
): void {
  stores.set(tabId, store);
  publishResidentCount();
  touchTabEditorStore(tabId);
}

export function removeTabEditorStore(
  tabId: string,
): PdfEditorStoreApi | undefined {
  const store = stores.get(tabId);
  stores.delete(tabId);
  lastTouched.delete(tabId);
  publishResidentCount();
  return store;
}

export function tabEditorStoreEntries(): IterableIterator<
  [string, PdfEditorStoreApi]
> {
  return stores.entries();
}

export function clearTabEditorStores(): void {
  stores.clear();
  lastTouched.clear();
  touchClock = 0;
  publishResidentCount();
}

export function touchTabEditorStore(tabId: string, at = Date.now()): void {
  if (!stores.has(tabId)) return;
  touchClock = Math.max(at, touchClock + 1);
  lastTouched.set(tabId, touchClock);
}

export function residentTabEditorStoreCount(): number {
  return stores.size;
}

export function leastRecentlyUsedTabEditorStore(
  excludedTabIds: ReadonlySet<string> = new Set(),
): { tabId: string; store: PdfEditorStoreApi; lastTouched: number } | null {
  let selected:
    | { tabId: string; store: PdfEditorStoreApi; lastTouched: number }
    | undefined;
  for (const [tabId, store] of stores) {
    if (excludedTabIds.has(tabId)) continue;
    const touched = lastTouched.get(tabId) ?? 0;
    if (!selected || touched < selected.lastTouched) {
      selected = { tabId, store, lastTouched: touched };
    }
  }
  return selected ?? null;
}
