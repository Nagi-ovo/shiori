import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import type { WorkspaceState } from "./workspace";
import { MAX_COLLAPSED_NOTE_IDS } from "../editor/overlays/notePresentation";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class FailingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error("quota exceeded");
  }
}

const globals = globalThis as typeof globalThis & {
  indexedDB: IDBFactory;
  IDBKeyRange: typeof IDBKeyRange;
};
globals.indexedDB = fakeIndexedDB as unknown as IDBFactory;
globals.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

describe("workspace storage", () => {
  let originalStorage: Storage | undefined;

  beforeEach(async () => {
    originalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    const { __workspaceTest } = await import("./workspace");
    await __workspaceTest.reset();
  });

  afterEach(() => {
    if (originalStorage) {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: originalStorage,
      });
    }
  });

  test("a stored null activeTabId means the home screen, not 'unset'", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    // The user clicked Home with tabs still open, then quit. Restoring must
    // land back on the home screen instead of force-opening the first tab —
    // which re-reads its bytes and can raise a draft-recovery prompt.
    saveWorkspaceState({
      version: 1,
      activeTabId: null,
      tabs: [
        {
          id: "tab-a",
          kind: "pdf",
          title: "a.pdf",
          size: 1,
          source: { type: "path", path: "/tmp/a.pdf" },
          updatedAt: 1,
        },
      ],
    });
    expect(loadWorkspaceState().activeTabId).toBeNull();
  });

  test("an unknown activeTabId still falls back to the first tab", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    saveWorkspaceState({
      version: 1,
      activeTabId: "tab-that-went-away",
      tabs: [
        {
          id: "tab-a",
          kind: "pdf",
          title: "a.pdf",
          size: 1,
          source: { type: "path", path: "/tmp/a.pdf" },
          updatedAt: 1,
        },
      ],
    });
    expect(loadWorkspaceState().activeTabId).toBe("tab-a");
  });

  test("keeps a DOCX tab and its active selection across a restart", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    expect(
      saveWorkspaceState({
        version: 1,
        activeTabId: "tab-docx",
        tabs: [
          {
            id: "tab-docx",
            kind: "docx",
            title: "report.docx",
            size: 42,
            source: { type: "cache", id: "docx-source" },
            hash: "docx-hash",
            updatedAt: 1,
          },
        ],
      }),
    ).toBe(true);

    const restored = loadWorkspaceState();
    expect(restored.activeTabId).toBe("tab-docx");
    expect(restored.tabs).toEqual([
      {
        id: "tab-docx",
        kind: "docx",
        title: "report.docx",
        size: 42,
        source: { type: "cache", id: "docx-source" },
        hash: "docx-hash",
        updatedAt: 1,
      },
    ]);
  });

  test("a pinned document stays pinned across a restart", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    // The whole point of an explicit pin is that it outlives the session. If
    // it did not round-trip, "workspace" and "unfiled" would reshuffle on
    // every launch and the reader could not rely on either.
    saveWorkspaceState({
      version: 1,
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          kind: "pdf",
          title: "a.pdf",
          size: 1,
          source: { type: "path", path: "/tmp/a.pdf" },
          pinned: true,
          updatedAt: 1,
        },
        {
          id: "tab-b",
          kind: "pdf",
          title: "b.pdf",
          size: 1,
          source: { type: "path", path: "/tmp/b.pdf" },
          updatedAt: 2,
        },
      ],
    });
    const restored = loadWorkspaceState();
    expect(restored.tabs.map((tab) => tab.pinned)).toEqual([true, undefined]);
  });

  test("round-trips multiple mounted folders", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    saveWorkspaceState({
      version: 1,
      activeTabId: null,
      tabs: [],
      folderPaths: ["/Users/reader/benchmark", "/Users/reader/notes"],
    });

    expect(loadWorkspaceState().folderPaths).toEqual([
      "/Users/reader/benchmark",
      "/Users/reader/notes",
    ]);
  });

  test("migrates the legacy single mounted folder", async () => {
    const { loadWorkspaceState } = await import("./workspace");
    localStorage.setItem(
      "shiori:workspace:v1",
      JSON.stringify({
        version: 1,
        activeTabId: null,
        tabs: [],
        folderPath: "/Users/reader/benchmark",
      }),
    );

    expect(loadWorkspaceState().folderPaths).toEqual([
      "/Users/reader/benchmark",
    ]);
  });

  test("export bookkeeping survives a save/load round trip", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    saveWorkspaceState({
      version: 1,
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          kind: "pdf",
          title: "a.pdf",
          size: 1,
          source: { type: "path", path: "/tmp/a.pdf" },
          exportBaselineSnapshot: "baseline-key",
          lastExport: {
            documentHash: "hash-a",
            snapshotKey: "baseline-key",
            exportedAt: 1700000000000,
            path: "/tmp/a-exported.pdf",
            platform: "desktop",
          },
          updatedAt: 1,
        },
      ],
    });
    const restored = loadWorkspaceState().tabs[0];
    expect(restored?.exportBaselineSnapshot).toBe("baseline-key");
    expect(restored?.lastExport?.snapshotKey).toBe("baseline-key");
    expect(restored?.lastExport?.platform).toBe("desktop");
  });

  test("compacts legacy model JSON before writing workspace metadata", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    const legacySnapshot = JSON.stringify({
      pages: [{ id: "page-a", sourceIndex: 0, padding: "x".repeat(50_000) }],
      overlays: [],
    });

    expect(
      saveWorkspaceState({
        version: 1,
        activeTabId: "tab-a",
        tabs: [
          {
            id: "tab-a",
            kind: "pdf",
            title: "a.pdf",
            size: 1,
            source: { type: "path", path: "/tmp/a.pdf" },
            exportBaselineSnapshot: legacySnapshot,
            lastExport: {
              documentHash: "hash-a",
              snapshotKey: legacySnapshot,
              exportedAt: 1,
              path: "/tmp/a-export.pdf",
              platform: "desktop",
            },
            updatedAt: 1,
          },
        ],
      }),
    ).toBe(true);

    const raw = localStorage.getItem("shiori:workspace:v1")!;
    const restored = loadWorkspaceState().tabs[0]!;
    expect(raw.length).toBeLessThan(1_000);
    expect(raw).not.toContain("x".repeat(100));
    expect(restored.exportBaselineSnapshot).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(restored.lastExport?.snapshotKey).toBe(
      restored.exportBaselineSnapshot,
    );
  });

  test("round-trips tab metadata through JSON", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import("./workspace");
    const state: WorkspaceState = {
      version: 1,
      activeTabId: "tab-pdf",
      tabs: [
        {
          id: "tab-pdf",
          kind: "pdf",
          title: "paper.pdf",
          size: 123,
          source: { type: "path", path: "/tmp/paper.pdf" },
          hash: "hash-a",
          pdfView: {
            pageIndex: 12,
            scale: 1.25,
            fitMode: "none",
            showThumbs: true,
            showRail: false,
            railTab: "outline",
            readerMode: false,
            collapsedNoteIds: ["note-a", "note-b"],
            collapsedCalloutIds: ["callout-a"],
          },
          updatedAt: 2,
        },
        {
          id: "tab-md",
          kind: "markdown",
          title: "notes.md",
          size: 456,
          source: { type: "cache", id: "source-md" },
          workingCopyCacheId: "working-md",
          textDirty: true,
          textView: {
            scrollTop: 18,
            zoom: 1.25,
            mode: "edit",
            appearance: {
              bodyFont: { source: "system", family: "Avenir Next" },
              codeFont: { source: "builtin", family: "JetBrains Mono" },
              headingColor: "#2d5a3d",
              fontSize: 18,
              lineHeight: 1.8,
              contentWidth: 720,
            },
          },
          updatedAt: 3,
        },
      ],
    };

    saveWorkspaceState(state);
    expect(loadWorkspaceState()).toEqual(state);
  });

  test("reports when workspace metadata cannot be persisted", async () => {
    const { saveWorkspaceState } = await import("./workspace");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new FailingStorage(),
    });

    expect(
      saveWorkspaceState({ version: 1, activeTabId: null, tabs: [] }),
    ).toBe(false);
  });

  test("bounds and sanitizes persisted collapsed note ids", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import("./workspace");
    const ids = Array.from(
      { length: MAX_COLLAPSED_NOTE_IDS + 20 },
      (_, index) => `note-${index}`,
    );
    const state: WorkspaceState = {
      version: 1,
      activeTabId: "tab-pdf",
      tabs: [
        {
          id: "tab-pdf",
          kind: "pdf",
          title: "paper.pdf",
          size: 123,
          source: { type: "path", path: "/tmp/paper.pdf" },
          pdfView: {
            pageIndex: 0,
            scale: 1,
            fitMode: "width",
            showThumbs: true,
            showRail: false,
            railTab: "outline",
            readerMode: false,
            collapsedNoteIds: ids,
            collapsedCalloutIds: ids.map((id) => id.replace("note", "callout")),
          },
          updatedAt: 1,
        },
      ],
    };

    expect(saveWorkspaceState(state)).toBe(true);
    const restored = loadWorkspaceState().tabs[0]?.pdfView?.collapsedNoteIds;
    expect(restored).toHaveLength(MAX_COLLAPSED_NOTE_IDS);
    expect(restored?.[0]).toBe("note-0");
    expect(restored?.at(-1)).toBe(`note-${MAX_COLLAPSED_NOTE_IDS - 1}`);

    const raw = JSON.parse(localStorage.getItem("shiori:workspace:v1")!) as {
      tabs: Array<{ pdfView: { collapsedNoteIds: unknown[] } }>;
    };
    raw.tabs[0]!.pdfView.collapsedNoteIds = [
      "note-a",
      "note-a",
      "",
      42,
      "x".repeat(257),
      "note-b",
    ];
    localStorage.setItem("shiori:workspace:v1", JSON.stringify(raw));
    expect(loadWorkspaceState().tabs[0]?.pdfView?.collapsedNoteIds).toEqual([
      "note-a",
      "note-b",
    ]);
  });

  test("bounds and sanitizes collapsed callout IDs the same way", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import("./workspace");
    const ids = Array.from(
      { length: MAX_COLLAPSED_NOTE_IDS + 20 },
      (_, index) => `callout-${index}`,
    );
    const state: WorkspaceState = {
      version: 1,
      activeTabId: "tab-pdf",
      tabs: [
        {
          id: "tab-pdf",
          kind: "pdf",
          title: "paper.pdf",
          size: 123,
          source: { type: "path", path: "/tmp/paper.pdf" },
          pdfView: {
            pageIndex: 0,
            scale: 1,
            fitMode: "width",
            showThumbs: true,
            showRail: false,
            railTab: "outline",
            readerMode: false,
            collapsedNoteIds: [],
            collapsedCalloutIds: ids,
          },
          updatedAt: 1,
        },
      ],
    };

    expect(saveWorkspaceState(state)).toBe(true);
    const restored = loadWorkspaceState().tabs[0]?.pdfView?.collapsedCalloutIds;
    expect(restored).toHaveLength(MAX_COLLAPSED_NOTE_IDS);

    const raw = JSON.parse(localStorage.getItem("shiori:workspace:v1")!) as {
      tabs: Array<{ pdfView: { collapsedCalloutIds: unknown[] } }>;
    };
    raw.tabs[0]!.pdfView.collapsedCalloutIds = [
      "callout-a",
      "callout-a",
      "",
      42,
      "x".repeat(257),
      "callout-b",
    ];
    localStorage.setItem("shiori:workspace:v1", JSON.stringify(raw));
    expect(
      loadWorkspaceState().tabs[0]?.pdfView?.collapsedCalloutIds,
    ).toEqual(["callout-a", "callout-b"]);
  });

  test("preserves appearance while patching scroll, zoom, or mode", async () => {
    const { patchWorkspaceTextView } = await import("./workspace");
    const original = {
      scrollTop: 12,
      zoom: 1.25,
      mode: "edit" as const,
      appearance: {
        bodyFont: { source: "system" as const, family: "Avenir Next" },
        fontSize: 18,
      },
    };

    expect(
      patchWorkspaceTextView(original, { scrollTop: 48 }),
    ).toMatchObject({ ...original, scrollTop: 48 });
    expect(patchWorkspaceTextView(original, { zoom: 2 }).appearance).toEqual(
      original.appearance,
    );
    expect(
      patchWorkspaceTextView(original, { mode: "preview" }).appearance,
    ).toEqual(original.appearance);
    expect(patchWorkspaceTextView(original, { appearance: {} })).not.toHaveProperty(
      "appearance",
    );
  });

  test("sanitizes a corrupted appearance without dropping its tab", async () => {
    const { loadWorkspaceState } = await import("./workspace");
    localStorage.setItem(
      "shiori:workspace:v1",
      JSON.stringify({
        version: 1,
        activeTabId: "tab-md",
        tabs: [
          {
            id: "tab-md",
            kind: "markdown",
            title: "notes.md",
            size: 4,
            source: { type: "cache", id: "source-md" },
            textView: {
              scrollTop: 9,
              appearance: {
                bodyFont: { source: "system", family: "Bad\nFont" },
                codeFont: { source: "builtin", family: "JetBrains Mono" },
                headingColor: "#11223344",
                fontSize: 200,
                lineHeight: 1.75,
              },
            },
            updatedAt: 1,
          },
        ],
      }),
    );

    const loaded = loadWorkspaceState();
    expect(loaded.tabs).toHaveLength(1);
    expect(loaded.tabs[0]?.textView).toEqual({
      scrollTop: 9,
      appearance: {
        codeFont: { source: "builtin", family: "JetBrains Mono" },
        lineHeight: 1.75,
      },
    });
  });

  test("migrates legacy fitWidth boolean to fitMode", async () => {
    const { loadWorkspaceState } = await import("./workspace");
    // A workspace persisted before the tri-state zoom model: pdfView carries
    // `fitWidth: boolean` and no `fitMode`. The tab must survive the upgrade
    // (not be dropped by the stricter guard) with fitWidth mapped forward.
    const legacy = {
      version: 1,
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          kind: "pdf",
          title: "old.pdf",
          size: 1,
          source: { type: "path", path: "/tmp/old.pdf" },
          pdfView: {
            pageIndex: 0,
            scale: 1,
            fitWidth: true,
            showThumbs: true,
            showRail: false,
            railTab: "outline",
            readerMode: false,
          },
          updatedAt: 1,
        },
        {
          id: "t2",
          kind: "pdf",
          title: "old2.pdf",
          size: 1,
          source: { type: "path", path: "/tmp/old2.pdf" },
          pdfView: {
            pageIndex: 0,
            scale: 2,
            fitWidth: false,
            showThumbs: true,
            showRail: false,
            railTab: "outline",
            readerMode: false,
          },
          updatedAt: 1,
        },
      ],
    };
    localStorage.setItem("shiori:workspace:v1", JSON.stringify(legacy));

    const loaded = loadWorkspaceState();
    expect(loaded.tabs).toHaveLength(2);
    expect(loaded.tabs[0]?.pdfView?.fitMode).toBe("width");
    expect(loaded.tabs[1]?.pdfView?.fitMode).toBe("none");
    expect(loaded.tabs[0]?.pdfView?.collapsedNoteIds).toEqual([]);
    // A workspace written before callouts could collapse loads as "none".
    expect(loaded.tabs[0]?.pdfView?.collapsedCalloutIds).toEqual([]);
  });

  test("unsaved text edits survive a save/load round trip", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    saveWorkspaceState({
      version: 1,
      activeTabId: "tab-md",
      tabs: [
        {
          id: "tab-md",
          kind: "markdown",
          title: "note.md",
          size: 4,
          source: { type: "path", path: "/tmp/note.md" },
          workingCopyCacheId: "copy-1",
          textDirty: true,
          updatedAt: 1,
        },
      ],
    });
    expect(loadWorkspaceState().tabs[0]?.textDirty).toBe(true);
  });

  test("a saved text tab stays clean across a reload", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    saveWorkspaceState({
      version: 1,
      activeTabId: "tab-md",
      tabs: [
        {
          id: "tab-md",
          kind: "markdown",
          title: "note.md",
          size: 4,
          source: { type: "path", path: "/tmp/note.md" },
          workingCopyCacheId: "copy-1",
          textDirty: false,
          updatedAt: 1,
        },
      ],
    });
    expect(loadWorkspaceState().tabs[0]?.textDirty).toBe(false);
  });

  // Written before save-back existed: no flag, but a working copy means the
  // document was edited, so the safe reading is "not yet written to the file".
  test("a pre-save-back text tab with a working copy migrates to dirty", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    saveWorkspaceState({
      version: 1,
      activeTabId: "tab-md",
      tabs: [
        {
          id: "tab-md",
          kind: "markdown",
          title: "note.md",
          size: 4,
          source: { type: "path", path: "/tmp/note.md" },
          workingCopyCacheId: "copy-1",
          updatedAt: 1,
        },
      ],
    });
    expect(loadWorkspaceState().tabs[0]?.textDirty).toBe(true);
  });

  test("a text tab that was never edited stays clean", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    saveWorkspaceState({
      version: 1,
      activeTabId: "tab-md",
      tabs: [
        {
          id: "tab-md",
          kind: "markdown",
          title: "note.md",
          size: 4,
          source: { type: "path", path: "/tmp/note.md" },
          updatedAt: 1,
        },
      ],
    });
    expect(loadWorkspaceState().tabs[0]?.textDirty).toBeUndefined();
  });

  // PDFs use exportBaselineSnapshot for the same idea; a PDF with a working
  // copy must not be reinterpreted as an unsaved text document.
  test("a PDF tab is never migrated to textDirty", async () => {
    const { loadWorkspaceState, saveWorkspaceState } = await import(
      "./workspace"
    );
    saveWorkspaceState({
      version: 1,
      activeTabId: "tab-pdf",
      tabs: [
        {
          id: "tab-pdf",
          kind: "pdf",
          title: "a.pdf",
          size: 4,
          source: { type: "path", path: "/tmp/a.pdf" },
          workingCopyCacheId: "copy-1",
          updatedAt: 1,
        },
      ],
    });
    expect(loadWorkspaceState().tabs[0]?.textDirty).toBeUndefined();
  });

  test("cached source bytes survive localStorage-only tab metadata", async () => {
    const {
      getWorkspaceSource,
      putWorkspaceSource,
      removeWorkspaceSource,
      totalWorkspaceSourceBytes,
    } = await import("./workspace");

    const id = await putWorkspaceSource({
      kind: "markdown",
      name: "note.md",
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });
    const source = await getWorkspaceSource(id);
    expect(source?.name).toBe("note.md");
    expect(Array.from(source?.bytes ?? [])).toEqual([1, 2, 3]);
    expect(await totalWorkspaceSourceBytes()).toBe(3);

    await removeWorkspaceSource(id);
    expect(await getWorkspaceSource(id)).toBeUndefined();
  });

  test("quota admission never materializes cached source blobs", async () => {
    const {
      __workspaceTest,
      getWorkspaceSource,
      putWorkspaceSource,
    } = await import("./workspace");
    const table = __workspaceTest.db.sources as unknown as {
      orderBy: (index: string) => {
        toArray: () => Promise<unknown[]>;
      };
      toArray: () => Promise<unknown[]>;
    };
    const originalTableToArray = table.toArray.bind(table);
    const originalOrderBy = table.orderBy.bind(table);
    let fullRowReads = 0;
    table.toArray = async () => {
      fullRowReads += 1;
      return originalTableToArray();
    };
    table.orderBy = (index) => {
      const collection = originalOrderBy(index);
      const originalCollectionToArray = collection.toArray.bind(collection);
      collection.toArray = async () => {
        fullRowReads += 1;
        return originalCollectionToArray();
      };
      return collection;
    };

    try {
      const id = await putWorkspaceSource({
        kind: "docx",
        name: "indexed.docx",
        size: 4,
        bytes: new Uint8Array(4),
        savedAt: 1,
      });
      expect(await getWorkspaceSource(id)).toBeDefined();
      expect(fullRowReads).toBe(0);
    } finally {
      table.toArray = originalTableToArray;
      table.orderBy = originalOrderBy;
    }
  });

  test("evicts the oldest unprotected source when the app cap is exceeded", async () => {
    const {
      __workspaceTest,
      getWorkspaceSource,
      putWorkspaceSource,
    } = await import("./workspace");
    __workspaceTest.setSourceCapBytes(6);
    const oldId = await putWorkspaceSource({
      kind: "markdown",
      name: "old.md",
      size: 4,
      bytes: new Uint8Array(4),
      savedAt: 1,
    });
    const currentId = await putWorkspaceSource({
      kind: "markdown",
      name: "current.md",
      size: 4,
      bytes: new Uint8Array(4),
      savedAt: 2,
    });

    expect(await getWorkspaceSource(oldId)).toBeUndefined();
    expect(await getWorkspaceSource(currentId)).toBeDefined();
  });

  test("keeps the source cap hard when every older row is protected", async () => {
    const {
      __workspaceTest,
      getWorkspaceSource,
      putWorkspaceSource,
      totalWorkspaceSourceBytes,
      WorkspaceSourceSaveError,
    } = await import("./workspace");
    __workspaceTest.setSourceCapBytes(6);
    const protectedId = await putWorkspaceSource({
      kind: "docx",
      name: "open.docx",
      size: 4,
      bytes: new Uint8Array(4),
      savedAt: 1,
    });

    try {
      await putWorkspaceSource(
        {
          kind: "docx",
          name: "next.docx",
          size: 4,
          bytes: new Uint8Array(4),
          savedAt: 2,
        },
        new Set([protectedId]),
      );
      throw new Error("the protected source cap should reject this write");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceSourceSaveError);
      expect((error as InstanceType<typeof WorkspaceSourceSaveError>).kind).toBe(
        "quota",
      );
    }
    expect(await getWorkspaceSource(protectedId)).toBeDefined();
    expect(await totalWorkspaceSourceBytes()).toBe(4);
  });

  test("frees LRU space and retries a Dexie-wrapped quota failure", async () => {
    const {
      __workspaceTest,
      getWorkspaceSource,
      putWorkspaceSource,
    } = await import("./workspace");
    const oldId = await putWorkspaceSource({
      kind: "markdown",
      name: "old.md",
      size: 4,
      bytes: new Uint8Array(4),
      savedAt: 1,
    });
    await putWorkspaceSource({
      kind: "markdown",
      name: "newer.md",
      size: 4,
      bytes: new Uint8Array(4),
      savedAt: 2,
    });

    const table = __workspaceTest.db.sources as unknown as {
      put: (value: unknown) => Promise<string>;
    };
    const originalPut = table.put.bind(table);
    let failures = 1;
    table.put = async (value) => {
      if (failures-- > 0) throw dexieWrappedQuotaError();
      return originalPut(value);
    };
    try {
      const id = await putWorkspaceSource({
        kind: "markdown",
        name: "incoming.md",
        size: 4,
        bytes: new Uint8Array(4),
        savedAt: 3,
      });
      expect(await getWorkspaceSource(id)).toBeDefined();
      expect(await getWorkspaceSource(oldId)).toBeUndefined();
    } finally {
      table.put = originalPut;
    }
  });

  test("classifies a quota failure that still fails after retry", async () => {
    const {
      __workspaceTest,
      putWorkspaceSource,
      WorkspaceSourceSaveError,
    } = await import("./workspace");
    const table = __workspaceTest.db.sources as unknown as {
      put: (value: unknown) => Promise<string>;
    };
    const originalPut = table.put.bind(table);
    table.put = async () => {
      throw dexieWrappedQuotaError();
    };
    try {
      await expect(
        putWorkspaceSource({
          kind: "markdown",
          name: "incoming.md",
          size: 4,
          bytes: new Uint8Array(4),
        }),
      ).rejects.toMatchObject({
        name: WorkspaceSourceSaveError.name,
        kind: "quota",
      });
    } finally {
      table.put = originalPut;
    }
  });
});

function dexieWrappedQuotaError(): Error {
  const inner = new DOMException("Storage is full", "QuotaExceededError");
  const wrapped = new Error(inner.message) as Error & { inner: DOMException };
  wrapped.name = "QuotaExceededError";
  wrapped.inner = inner;
  return wrapped;
}
