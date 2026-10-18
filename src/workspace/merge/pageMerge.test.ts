import { describe, expect, test } from "bun:test";
import { createPdfEditorStore } from "../../editor/store/store";
import type { PdfDocument, PdfEngine } from "../../pdf/engine/types";
import { PdfPageInsertError } from "../../pdf/merge/insertPdf";
import { finalizePdfOpen } from "../intake/finalizePdfOpen";
import type { WorkspaceRuntimeTab } from "../types";
import { createWorkspaceStore } from "../workspaceStore";
import { createPageMerges, type PageMergeNotice, type PageMergePorts } from "./pageMerge";

/** A fake PDF whose every byte is one page. */
const fakeDoc = (bytes: Uint8Array) => ({ pages: bytes.length }) as unknown as PdfDocument;
const pagesOf = (doc: PdfDocument) => (doc as unknown as { pages: number }).pages;

const engine: PdfEngine = {
  load: async (bytes) => ({ doc: fakeDoc(bytes), bytes }),
  pageCount: pagesOf,
  pageGeometry: async (doc) =>
    Array.from({ length: pagesOf(doc) }, () => ({
      rotation: 0 as const,
      originXPt: 0,
      originYPt: 0,
      widthPt: 612,
      heightPt: 792,
    })),
  importAnnotations: async () => [],
  thumbnail: async () => undefined,
  renderRegion: () => ({ cancel: () => {}, done: Promise.resolve() }),
  label: "fake",
  pageText: async () => ({ content: { items: [], styles: {}, lang: null }, glyphs: null, fontNames: new Map() }),
  outline: async () => [],
  pageLinks: async () => [],
  security: () => null,
  openEncryptedSource: async () => { throw new Error("not encrypted"); },
  destroy: async () => {},
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<PageMergePorts> = {}) {
  const tabs = [
    { id: "t", kind: "pdf", title: "paper.pdf", status: "loaded", hash: "h0", source: { type: "path", path: "/paper.pdf" } },
    { id: "other", kind: "pdf", title: "other.pdf", status: "loaded", source: { type: "path", path: "/other.pdf" } },
  ] as WorkspaceRuntimeTab[];
  const store = createWorkspaceStore({ tabs, activeTabId: "t", folderPaths: [] });
  const editor = createPdfEditorStore();
  const base = new Uint8Array([1, 2]);
  finalizePdfOpen({
    store: editor,
    file: { name: "paper.pdf", size: 2 },
    hash: "h0",
    pages: [
      { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
    ],
    doc: fakeDoc(base),
    bytes: base,
    source: {},
    animateImportedCallouts: false,
  });
  const notices: PageMergeNotice[] = [];
  const removed: string[] = [];
  let copies = 0;
  const ports: PageMergePorts = {
    store,
    engine,
    activeEditor: () => editor,
    tabEditor: (id) => (id === "t" ? editor : undefined),
    flushActiveDraft: async () => {},
    insertPages: async (baseBytes, incoming) => ({
      bytes: new Uint8Array([...baseBytes, ...incoming]),
      insertedPageCount: incoming.length,
    }),
    cache: {
      put: async () => `merged-${++copies}`,
      removeIfUnreferenced: async (id) => {
        removed.push(id);
      },
    },
    recordMergedRecent: () => true,
    lastPage: () => undefined,
    settings: () => ({ animateOverlays: false }),
    notify: (notice) => notices.push(notice),
    ...overrides,
  };
  const merges = createPageMerges(ports);
  const pageIds = () => editor.getState().model.pages.map((page) => page.id);
  return { store, editor, merges, notices, removed, pageIds };
}

const announce = { keepBaseFileName: true, announcePdfInsertion: true };

describe("page merge", () => {
  test("inserted pages land after the chosen page, and Undo takes them out", async () => {
    const { store, editor, merges, pageIds, notices } = setup();

    const ok = await merges.begin({ placement: { kind: "after", pageId: "p1" }, ...announce })(
      new Uint8Array([9]),
      "scan.pdf",
    );

    expect(ok).toBe(true);
    const ids = pageIds();
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe("p1");
    expect(ids[2]).toBe("p2");
    expect(editor.getState().activePageId).toBe(ids[1]!);
    expect(store.getState().tabs[0]).toMatchObject({ source: { type: "cache", id: "merged-1" } });
    expect(notices).toEqual([{ kind: "inserted", count: 1, name: "scan.pdf" }]);

    editor.getState().undo();
    expect(pageIds()).toEqual(["p1", "p2"]);
  });

  test("switching tabs while the merge waits leaves the document alone", async () => {
    const { store, merges, pageIds, notices } = setup();
    const insert = merges.begin({ placement: { kind: "append" }, ...announce });

    store.getState().claimNavigation();
    store.getState().setActiveTab("other");
    const ok = await insert(new Uint8Array([9]), "scan.pdf");

    expect(ok).toBe(false);
    expect(pageIds()).toEqual(["p1", "p2"]);
    expect(notices).toEqual([{ kind: "targetChanged" }]);
  });

  test("a document opened while a merge waits keeps the screen", async () => {
    const flush = deferred();
    const { store, merges, pageIds } = setup({ flushActiveDraft: () => flush.promise });

    const merging = merges.begin()(new Uint8Array([9]), "pasted.pdf");
    const open = store.getState().claimOpen(); // the reader opens a file
    flush.resolve();
    const ok = await merging;

    expect(ok).toBe(false);
    expect(open.isCurrent()).toBe(true);
    expect(pageIds()).toEqual(["p1", "p2"]);
  });

  test("two quick pastes both land, the second after the first", async () => {
    const { merges, pageIds } = setup();

    const first = merges.begin()(new Uint8Array([7]), "a.pdf");
    const second = merges.begin()(new Uint8Array([8, 8]), "b.pdf");
    const results = await Promise.all([first, second]);

    expect(results).toEqual([true, true]);
    expect(pageIds()).toHaveLength(5);
    expect(pageIds().slice(0, 2)).toEqual(["p1", "p2"]);
  });

  test("a merged file recents cannot hold is not committed, and its copy is dropped", async () => {
    const { merges, pageIds, removed, notices } = setup({ recordMergedRecent: () => false });

    const ok = await merges.begin()(new Uint8Array([9]), "scan.pdf");

    expect(ok).toBe(false);
    expect(pageIds()).toEqual(["p1", "p2"]);
    expect(removed).toEqual(["merged-1"]);
    expect(notices).toEqual([{ kind: "recentsSaveFailed" }]);
  });

  test("a PDF that cannot be inserted says why", async () => {
    const refusal = new PdfPageInsertError("encryptedIncoming", "The incoming PDF is encrypted.");
    const { merges, notices } = setup({
      insertPages: async () => {
        throw refusal;
      },
    });

    await merges.begin()(new Uint8Array([9]), "locked.pdf");

    expect(notices).toEqual([{ kind: "insertRefused", code: "encryptedIncoming", name: "locked.pdf" }]);
  });
});
