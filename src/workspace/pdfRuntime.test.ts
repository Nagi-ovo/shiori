import { afterEach, describe, expect, test } from "bun:test";
import {
  createPdfEditorStore,
  type OpenedPdf,
  type PdfEditorStoreApi,
} from "../editor/store/store";
import {
  clearTabEditorStores,
  getTabEditorStore,
  registerTabEditorStore,
} from "../editor/store/tabStoreRegistry";
import type { PdfDocument } from "../pdf/engine/types";
import { fakeEngine } from "./intake/testing";
import { createPdfRuntime, type PdfRuntimePorts } from "./pdfRuntime";
import type { WorkspaceRuntimeTab } from "./types";
import { createWorkspaceStore } from "./workspaceStore";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pdfTab = (id: string): WorkspaceRuntimeTab =>
  ({ id, kind: "pdf", title: `${id}.pdf`, status: "loaded", updatedAt: 1 }) as WorkspaceRuntimeTab;

const docOf = (tabId: string) => ({ id: `doc-${tabId}` }) as unknown as PdfDocument;

/** Registers a resident editor holding its tab's document; oldest first. */
function resident(tabId: string): PdfEditorStoreApi {
  const editor = createPdfEditorStore();
  editor.setState({
    opened: {
      fileName: `${tabId}.pdf`,
      fileSize: 3,
      doc: docOf(tabId),
      bytes: new Uint8Array([1, 2, 3]),
      sourcePages: [],
    } as unknown as OpenedPdf,
  });
  registerTabEditorStore(tabId, editor);
  return editor;
}

function setup(
  tabIds: string[],
  activeTabId: string | null,
  overrides: Partial<PdfRuntimePorts> = {},
) {
  const store = createWorkspaceStore({
    tabs: tabIds.map(pdfTab),
    activeTabId,
    folderPaths: [],
  });
  const log: string[] = [];
  const { engine } = fakeEngine({
    destroy: async (doc) => {
      if (doc) log.push(`release:${(doc as unknown as { id: string }).id}`);
    },
  });
  const rows = new Set<string>();
  let onScreen: PdfEditorStoreApi = createPdfEditorStore();
  const ports: PdfRuntimePorts = {
    store,
    engine,
    sessions: {
      put: async ({ tabId }) => {
        rows.add(tabId);
        log.push(`row:${tabId}`);
      },
      remove: async (tabId) => {
        rows.delete(tabId);
      },
      rememberCredential: () => {},
    },
    previews: { capture: () => null, put: async () => {}, remove: async () => {} },
    activeEditor: () => onScreen,
    flushDraft: async () => {},
    onFlushFailed: () => {},
    ...overrides,
  };
  return {
    runtime: createPdfRuntime(ports),
    store,
    log,
    rows,
    show: (editor: PdfEditorStoreApi) => {
      onScreen = editor;
    },
  };
}

const released = (log: string[]) => log.filter((entry) => entry.startsWith("release:"));
const tabOf = (store: ReturnType<typeof setup>["store"], id: string) =>
  store.getState().tabs.find((tab) => tab.id === id);

afterEach(() => clearTabEditorStores());

describe("PDF documents held by tabs", () => {
  test("at the limit, the least recent tab is parked before its document is let go", async () => {
    const { runtime, store, log } = setup(["a", "b", "c", "d"], "a");
    resident("b");
    resident("c");
    resident("a");

    const admitted = await runtime.reserve("d", () => {});

    expect(admitted).toBe(true);
    expect(log).toEqual(["row:b", "release:doc-b"]);
    expect(getTabEditorStore("b")).toBeUndefined();
    expect(tabOf(store, "b")?.status).toBe("suspended");
  });

  test("a row that cannot be written keeps the document", async () => {
    let refused = 0;
    const { runtime, store, log } = setup(["a", "b", "c", "d"], "a", {
      sessions: {
        put: async () => {
          throw new Error("quota");
        },
        remove: async () => {},
        rememberCredential: () => {},
      },
    });
    resident("b");
    resident("c");
    resident("a");

    const admitted = await runtime.reserve("d", () => refused++);

    expect(admitted).toBe(false);
    expect(refused).toBe(1);
    expect(released(log)).toEqual([]);
    expect(getTabEditorStore("b")).toBeDefined();
    expect(tabOf(store, "b")?.status).toBe("loaded");
  });

  test("a tab closed while it was being parked leaves no row and no tab", async () => {
    const write = deferred();
    const rows = new Set<string>();
    const { runtime, store, log } = setup(["a", "b", "c", "d"], "a", {
      sessions: {
        put: async ({ tabId }) => {
          rows.add(tabId);
          await write.promise;
        },
        remove: async (tabId) => {
          rows.delete(tabId);
        },
        rememberCredential: () => {},
      },
    });
    resident("b");
    resident("c");
    resident("a");

    const admission = runtime.reserve("d", () => {});
    await Bun.sleep(0);
    store.setState({ tabs: store.getState().tabs.filter((tab) => tab.id !== "b") });
    write.resolve();
    await admission;

    expect(rows.has("b")).toBe(false);
    expect(released(log)).toEqual(["release:doc-b"]);
    expect(tabOf(store, "b")).toBeUndefined();
  });

  test("closing the tab on screen releases its document once", async () => {
    const { runtime, store, log } = setup(["a", "b"], "a");
    const onScreen = resident("a").getState().opened?.doc;

    await runtime.release(tabOf(store, "a")!, onScreen);

    expect(released(log)).toEqual(["release:doc-a"]);
    expect(getTabEditorStore("a")).toBeUndefined();
  });

  test("a document on screen outside the closed tab's store is released too", async () => {
    const { runtime, store, log } = setup(["a", "b"], "a");
    resident("a");

    await runtime.release(tabOf(store, "a")!, docOf("elsewhere"));

    expect(released(log).sort()).toEqual(["release:doc-a", "release:doc-elsewhere"]);
  });
});

describe("leaving a PDF for another document", () => {
  test("its view and export markers are recorded into its tab", async () => {
    const { runtime, store, show } = setup(["a", "b"], "a");
    const editor = resident("a");
    show(editor);
    store.getState().setSession({ activeHash: "hash-a", exportBaselineSnapshot: "base-a" });

    expect(await runtime.persistLeaving()).toBe(true);

    const tab = tabOf(store, "a");
    expect(tab?.hash).toBe("hash-a");
    expect(tab?.exportBaselineSnapshot).toBe("base-a");
    expect(tab?.pdfView).toBeDefined();
  });

  test("a draft that cannot be saved keeps the reader where they are", async () => {
    const failed: string[] = [];
    const { runtime, store, show } = setup(["a", "b"], "a", {
      flushDraft: async () => {
        throw new Error("disk full");
      },
      onFlushFailed: (tab) => failed.push(tab.id),
    });
    show(resident("a"));

    expect(await runtime.persistLeaving()).toBe(false);
    expect(failed).toEqual(["a"]);
    expect(tabOf(store, "a")?.pdfView).toBeUndefined();
  });

  // Rapid tab clicks join the same save; the first may already have switched.
  test("a switch that happened during the save is not recorded into the tab left", async () => {
    const flush = deferred();
    const { runtime, store, show } = setup(["a", "b"], "a", {
      flushDraft: () => flush.promise,
    });
    show(resident("a"));

    const leaving = runtime.persistLeaving();
    store.setState({ activeTabId: "b" });
    show(resident("b"));
    flush.resolve();

    expect(await leaving).toBe(true);
    expect(tabOf(store, "a")?.pdfView).toBeUndefined();
    expect(tabOf(store, "b")?.pdfView).toBeUndefined();
  });
});
