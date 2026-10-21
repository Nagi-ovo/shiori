import { createPdfEditorStore, type PdfEditorStoreApi } from "../../editor/store/store";
import type { PdfDocument, PdfEngine } from "../../pdf/engine/types";
import type { WorkspaceRuntimeTab } from "../types";
import { createWorkspaceStore, type WorkspaceStore } from "../workspaceStore";
import type { IntakePorts, PendingPassword } from "./types";

/** Fakes for the intake tests: an in-memory engine and recording ports. */

export const bytes = (...values: number[]) => new Uint8Array(values);

export function workspace(tabs: WorkspaceRuntimeTab[] = [], activeTabId: string | null = null) {
  return createWorkspaceStore({ tabs, activeTabId, folderPaths: [] });
}

export function fakeEngine(overrides: Partial<PdfEngine> = {}) {
  const destroyed: unknown[] = [];
  const engine: PdfEngine = {
    load: async (input) => ({ doc: { id: input[0] } as unknown as PdfDocument, bytes: input }),
    pageCount: () => 2,
    pageGeometry: async () => [
      { rotation: 0, originXPt: 0, originYPt: 0, widthPt: 612, heightPt: 792 },
      { rotation: 0, originXPt: 0, originYPt: 0, widthPt: 612, heightPt: 792 },
    ],
    importAnnotations: async () => [],
    thumbnail: async () => undefined,
    renderRegion: () => ({ cancel: () => {}, done: Promise.resolve() }),
    label: "fake",
    pageText: async () => ({ content: { items: [], styles: {}, lang: null }, glyphs: null, fontNames: new Map(), faceFamilies: new Map() }),
    outline: async () => [],
    pageLinks: async () => [],
    security: () => null,
    openEncryptedSource: async () => {
      throw new Error("fake engine: no encrypted source");
    },
    destroy: async (doc) => {
      if (doc) destroyed.push(doc);
    },
    ...overrides,
  };
  return { engine, destroyed };
}

export function fakePorts(store: WorkspaceStore, overrides: Partial<IntakePorts> = {}) {
  const editors = new Map<string, PdfEditorStoreApi>();
  const log = {
    shown: [] as PdfEditorStoreApi[],
    activated: [] as string[],
    removedCaches: [] as string[],
    passwords: [] as PendingPassword[],
    errors: [] as string[],
    recents: [] as string[],
  };
  const { engine, destroyed } = fakeEngine();
  const ports: IntakePorts = {
    store,
    engine,
    enqueuePdfOpen: (job) => job(),
    settings: () => ({ compactLayout: false, animateOverlays: false }),
    persistActive: async () => true,
    activateLoadedTab: async (tabId) => {
      log.activated.push(tabId);
      store.getState().setActiveTab(tabId);
    },
    markSuperseded: () => {},
    sources: {
      ensure: async (payload) =>
        payload.path || payload.cacheId ? payload : { ...payload, cacheId: `cache-${payload.name}` },
      get: async () => undefined,
      removeIfUnreferenced: (id) => log.removedCaches.push(id),
    },
    drafts: {
      claim: async (_hash, draftId) => draftId,
      get: async () => undefined,
      getLiveOperationReceipts: async () => [],
      mergeLiveOperationReceipts: async () => undefined,
      readOperationLog: () => null,
    },
    editors: {
      get: (id) => editors.get(id),
      ensure: (id) => {
        if (!editors.has(id)) editors.set(id, createPdfEditorStore());
        return editors.get(id)!;
      },
      remove: (id) => void editors.delete(id),
      touch: () => {},
      show: (editor) => log.shown.push(editor),
      detach: () => {},
      hasOpenDocument: () => false,
      reserveResidentSlot: async () => true,
    },
    runtime: { removeSession: async () => {}, rememberCredential: () => {} },
    recents: {
      list: () => [],
      canReopen: () => true,
      record: (entry) => log.recents.push(entry.name),
      replace: () => {},
      forget: () => {},
      forgetWebFileHandle: () => {},
      attachThumb: () => {},
      recordText: (tab) => {
        log.recents.push(tab.title);
        return true;
      },
      lastPage: () => undefined,
    },
    ui: {
      setError: (error) => {
        if (error) log.errors.push(error.message);
      },
      requestPassword: (pending) => log.passwords.push(pending),
      warnAboutCanvas: () => {},
      describeOpenError: (_name, _size, error) => ({
        title: "Could not open",
        file: _name,
        message: String((error as Error).message),
        code: "ERR",
      }),
      toastError: () => {},
      reportDocumentPolicyError: () => false,
      reportWorkingCopyMissing: () => {},
    },
    ...overrides,
  };
  return { ports, log, destroyed, editors };
}

export const pdf = (name: string, first = 1) => ({
  name,
  size: 4,
  bytes: bytes(first, 2, 3, 4),
  path: `/docs/${name}`,
});

export const tabIds = (store: WorkspaceStore) => store.getState().tabs.map((tab) => tab.id);

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

