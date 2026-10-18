import { afterEach, describe, expect, test } from "bun:test";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  InkOverlay,
  NoteOverlay,
  PageModel,
  TextOverlay,
} from "../../pdf/model/types";
import {
  capturePdfEditorSession,
  createPdfEditorStore,
  loadInitialPrefs,
  restorePdfEditorSession,
  useAppStore,
  useEditorStore,
} from "./store";
import { prepareLiveOverlayRevealBatch } from "../../live/overlayReveal";

describe("PDF editor store factory", () => {
  test("creates isolated state and history containers", () => {
    const first = createPdfEditorStore();
    const second = createPdfEditorStore();
    const page = makePage("factory-page");

    first.setState({
      model: { pages: [page], overlays: [] },
      selectedIds: ["selection-a"],
    });
    first.getState().commit({ overlays: [makeInk("ink-a", page.id)] });

    expect(first.getState().model.overlays).toHaveLength(1);
    expect(first.getState().undoStack).toHaveLength(1);
    expect(second.getState().model.pages).toEqual([]);
    expect(second.getState().model.overlays).toEqual([]);
    expect(second.getState().selectedIds).toEqual([]);
    expect(second.getState().undoStack).toEqual([]);
  });
});

function makePage(id: string, overrides: Partial<PageModel> = {}): PageModel {
  return {
    id,
    sourceIndex: -1,
    rotation: 0,
    widthPt: 612,
    heightPt: 792,
    blank: true,
    ...overrides,
  };
}

function makeInk(id: string, pageId: string): InkOverlay {
  return {
    type: "ink",
    id,
    pageId,
    color: "#cc3322",
    width: 2,
    paths: [
      [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ],
    ],
  };
}

function makeCallout(id: string, pageId: string): CalloutOverlay {
  return {
    type: "callout",
    id,
    pageId,
    targetRects: [{ x: 40, y: 60, w: 80, h: 18 }],
    rect: { x: 152, y: 88, w: 168, h: 72 },
    text: "Explain this",
    fontSize: 13,
    color: "#8f4c34",
    bold: false,
    align: "left",
    fontFamily: "sans",
  };
}

function makeText(
  id: string,
  pageId: string,
  text = "",
): TextOverlay {
  return {
    type: "text",
    id,
    pageId,
    rect: { x: 10, y: 10, w: 100, h: 30 },
    text,
    fontSize: 14,
    color: "#1a1815",
    bold: false,
    align: "left",
    fontFamily: "serif",
  };
}

function makeNote(id: string, pageId: string): NoteOverlay {
  return {
    type: "note",
    id,
    pageId,
    rect: { x: 20, y: 30, w: 168, h: 94 },
    text: "Remember this",
    color: "#f7e9a8",
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeContentText(
  id: string,
  pageId: string,
  text = "Original",
): ContentTextOverlay {
  return {
    type: "contentText",
    id,
    pageId,
    rect: { x: 10, y: 10, w: 100, h: 30 },
    coverRects: [{ x: 10, y: 10, w: 100, h: 30 }],
    originalText: "Original",
    text,
    fontSize: 14,
    color: "#1a1815",
    bold: false,
    align: "left",
    fontFamily: "serif",
    backgroundColor: "#ffffff",
  };
}

const initialSnapshot = useEditorStore.getState();
const initialAppSnapshot = useAppStore.getState();

afterEach(() => {
  useEditorStore.setState(initialSnapshot, true);
  useAppStore.setState(initialAppSnapshot, true);
});

describe("prefs migration", () => {
  test("migrates PDF paper tone and custom color preferences safely", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      expect(loadInitialPrefs().pdfPaperTone).toBe("Original");
      expect(loadInitialPrefs().pdfPaperCustomColor).toBe("#efebd4");
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ pdfPaperTone: "Sepia" }),
      );
      expect(loadInitialPrefs().pdfPaperTone).toBe("Original");
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ pdfPaperTone: "Everforest" }),
      );
      expect(loadInitialPrefs().pdfPaperTone).toBe("Everforest");
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({
          pdfPaperTone: "Custom",
          pdfPaperCustomColor: "#FDE",
        }),
      );
      expect(loadInitialPrefs().pdfPaperTone).toBe("Custom");
      expect(loadInitialPrefs().pdfPaperCustomColor).toBe("#ffddee");
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({
          pdfPaperTone: "Custom",
          pdfPaperCustomColor: "transparent",
        }),
      );
      expect(loadInitialPrefs().pdfPaperCustomColor).toBe("#efebd4");
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("enables annotation animation by default and migrates the Live opt-out", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      expect(loadInitialPrefs().annotationAnimations).toBe(true);
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ liveOverlayAnimations: false }),
      );
      expect(loadInitialPrefs().annotationAnimations).toBe(false);
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ annotationAnimations: false }),
      );
      expect(loadInitialPrefs().annotationAnimations).toBe(false);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("splits legacy theme choices into mode and palette", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ theme: "Night", terminalTheme: "Everforest" }),
      );

      expect(loadInitialPrefs()).toMatchObject({
        colorMode: "Dark",
        theme: "Default",
        terminalColorMode: "Auto",
        terminalTheme: "Everforest",
      });
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("keeps only supported external terminal preferences", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ preferredExternalTerminalId: "wezterm" }),
      );
      expect(loadInitialPrefs().preferredExternalTerminalId).toBe("wezterm");

      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ preferredExternalTerminalId: "unknown-terminal" }),
      );
      expect(loadInitialPrefs().preferredExternalTerminalId).toBeNull();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("validates Markdown appearance and recent fonts from storage", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({
          markdownAppearance: {
            bodyFont: { source: "system", family: "Avenir Next" },
            codeFont: { source: "builtin", family: "Shiori Nerd Symbols" },
            fontSize: 19,
            lineHeight: 8,
            contentWidth: 720,
          },
          recentMarkdownFonts: [
            { source: "system", family: "Avenir Next" },
            { source: "system", family: "avenir next" },
            { source: "system", family: "Bad\nFont" },
          ],
        }),
      );

      expect(loadInitialPrefs().markdownAppearance).toEqual({
        bodyFont: { source: "system", family: "Avenir Next" },
        codeFont: null,
        headingColor: null,
        fontSize: 19,
        lineHeight: 1.7,
        contentWidth: 720,
      });
      expect(loadInitialPrefs().recentMarkdownFonts).toEqual([
        { source: "system", family: "Avenir Next" },
      ]);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("migrates the legacy Markdown heading color without overriding a nested value", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({
          theme: "Night",
          accentColor: "#CC6633",
          markdownHeadingColor: "#2D5A3D",
        }),
      );
      const migrated = loadInitialPrefs();
      expect(migrated.colorMode).toBe("Dark");
      expect(migrated.theme).toBe("Default");
      expect(migrated.accentColor).toBe("#cc6633");
      expect(migrated.markdownAppearance.headingColor).toBe("#2d5a3d");

      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({
          markdownHeadingColor: "#2D5A3D",
          markdownAppearance: { headingColor: null },
        }),
      );
      expect(loadInitialPrefs().markdownAppearance.headingColor).toBeNull();

      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ markdownHeadingColor: "rgba(0, 0, 0, .5)" }),
      );
      expect(loadInitialPrefs().markdownAppearance.headingColor).toBeNull();

      localStorage.setItem(
        "shiori:prefs:v1",
        JSON.stringify({ accentColor: "transparent" }),
      );
      expect(loadInitialPrefs().accentColor).toBeNull();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("normalizes accent colors before persisting preference updates", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      useAppStore.getState().setPrefs({ accentColor: "#ABC" });
      expect(useAppStore.getState().prefs.accentColor).toBe("#aabbcc");
      expect(
        JSON.parse(storage.get("shiori:prefs:v1") ?? "{}").accentColor,
      ).toBe("#aabbcc");

      useAppStore.getState().setPrefs({ accentColor: "transparent" });
      expect(useAppStore.getState().prefs.accentColor).toBeNull();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("normalizes custom PDF paper colors before persisting updates", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      useAppStore.getState().setPrefs({ pdfPaperCustomColor: "#FDE" });
      expect(useAppStore.getState().prefs.pdfPaperCustomColor).toBe("#ffddee");
      expect(
        JSON.parse(storage.get("shiori:prefs:v1") ?? "{}").pdfPaperCustomColor,
      ).toBe("#ffddee");

      useAppStore.getState().setPrefs({ pdfPaperCustomColor: "transparent" });
      expect(useAppStore.getState().prefs.pdfPaperCustomColor).toBe("#ffddee");
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("defaults callout follow-up visibility on and validates stored values", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      expect(loadInitialPrefs().showCalloutFollowUp).toBe(true);

      storage.set(
        "shiori:prefs:v1",
        JSON.stringify({ showCalloutFollowUp: false }),
      );
      expect(loadInitialPrefs().showCalloutFollowUp).toBe(false);

      storage.set(
        "shiori:prefs:v1",
        JSON.stringify({ showCalloutFollowUp: "false" }),
      );
      expect(loadInitialPrefs().showCalloutFollowUp).toBe(true);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("store setOpened", () => {
  test("hydrates initial overlays without creating an undo step", () => {
    const sourcePage = makePage("source-page", { sourceIndex: 0, blank: false });
    const modelPage = makePage("model-page", { sourceIndex: 0, blank: false });
    const importedInk = makeInk("imported-ink", modelPage.id);

    useEditorStore.getState().setOpened(
      {
        fileName: "annotated.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [sourcePage],
      { pages: [modelPage], overlays: [importedInk] },
    );
    useEditorStore.getState().undo();

    const { model, opened, undoStack } = useEditorStore.getState();
    expect(opened?.sourcePages.map((page) => page.id)).toEqual(["source-page"]);
    expect(model.pages.map((page) => page.id)).toEqual(["model-page"]);
    expect(model.overlays.map((overlay) => overlay.id)).toEqual(["imported-ink"]);
    expect(undoStack).toHaveLength(0);
  });

  test("can open directly on an initial page", () => {
    const first = makePage("page-1");
    const target = makePage("page-7");

    useEditorStore.getState().setOpened(
      {
        fileName: "resume.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [first, target],
      undefined,
      { initialPageIndex: 1 },
    );

    const state = useEditorStore.getState();
    expect(state.activePageId).toBe("page-7");
    expect(state.pageJump).toBeNull();
  });

  test("consumes only the page jump Canvas actually handled", () => {
    useEditorStore.getState().goToPage("page-2", 1);
    const first = useEditorStore.getState().pageJump!;
    useEditorStore.getState().goToPage("page-3", 2);
    const second = useEditorStore.getState().pageJump!;

    useEditorStore.getState().consumePageJump(first);
    expect(useEditorStore.getState().pageJump).toBe(second);
    useEditorStore.getState().consumePageJump(second);
    expect(useEditorStore.getState().pageJump).toBeNull();
  });

  test("defers an opened callout reveal until its page mounts", () => {
    const page = makePage("page-callout");
    const callout = makeCallout("callout-open", page.id);
    const reveal = prepareLiveOverlayRevealBatch("pdf-open-callouts", [
      callout,
    ]);

    useEditorStore.getState().setOpened(
      {
        fileName: "callout.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [page],
      { pages: [page], overlays: [callout] },
      { initialOverlayReveal: reveal },
    );

    expect(useEditorStore.getState().model.overlays).toEqual([callout]);
    expect(useEditorStore.getState().liveOverlayReveals).toHaveLength(0);
    expect(useEditorStore.getState().pendingOverlayReveals.has(callout.id)).toBe(
      true,
    );

    useEditorStore.getState().activatePendingOverlayReveals([callout.id]);
    const state = useEditorStore.getState();
    expect(state.pendingOverlayReveals.has(callout.id)).toBe(false);
    expect(state.liveOverlayReveals).toHaveLength(1);
    expect(state.liveOverlayReveals[0]?.itemsById.has(callout.id)).toBe(true);
  });

  test("hydrates Live receipts before the opened document becomes writable", () => {
    const page = makePage("page-receipts");
    const operationId = "a".repeat(64);
    useEditorStore.getState().setOpened(
      {
        fileName: "receipts.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [page],
      undefined,
      { completedLiveOperationIds: [operationId] },
    );

    expect(useEditorStore.getState().completedLiveOperationIds.has(operationId)).toBe(
      true,
    );
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });
});

describe("arrow-key nudging", () => {
  test("a held arrow key is one undo step, not one per repeat", () => {
    const page = makePage("page-1");
    const ink = makeInk("ink-1", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [ink] },
      selectedIds: [ink.id],
      undoStack: [],
      redoStack: [],
    });

    // What Canvas does for a held arrow: one history step on the first
    // keydown, then history-free moves for every auto-repeat. Repeats arrive
    // every ~15-33 ms, so committing each one filled the 100-entry undo stack
    // in seconds and silently discarded all earlier work.
    useEditorStore.getState().beginHistoryStep();
    for (let i = 0; i < 40; i++) {
      useEditorStore.getState().nudgeSelectedNoHistory(0, -1);
    }

    expect(useEditorStore.getState().undoStack).toHaveLength(1);

    const moved = useEditorStore.getState().model.overlays[0];
    if (!moved || moved.type !== "ink") throw new Error("expected the ink");
    // 40 repeats of a 1pt nudge on an unrotated page: display-up is PDF +y.
    expect(moved.paths[0]?.[0]?.y).toBeCloseTo(140, 6);

    // A single undo returns to where the hold began.
    useEditorStore.getState().undo();
    const restored = useEditorStore.getState().model.overlays[0];
    if (!restored || restored.type !== "ink") throw new Error("expected the ink");
    expect(restored.paths[0]?.[0]?.y).toBeCloseTo(100, 6);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });

  test("a single tap still records its own step", () => {
    const page = makePage("page-1");
    const ink = makeInk("ink-1", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [ink] },
      selectedIds: [ink.id],
      undoStack: [],
      redoStack: [],
    });

    useEditorStore.getState().nudgeSelected(0, -1);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
  });
});

describe("prepared commits", () => {
  test("keeps the active source page when a commit replaces page IDs", () => {
    const freshFirst = makePage("fresh-page-1", {
      sourceIndex: 0,
      blank: false,
    });
    const freshSecond = makePage("fresh-page-2", {
      sourceIndex: 1,
      blank: false,
    });
    const restoredSecond = makePage("restored-page-2", {
      sourceIndex: 1,
      blank: false,
    });
    const restoredFirst = makePage("restored-page-1", {
      sourceIndex: 0,
      blank: false,
    });
    useEditorStore.setState({
      model: { pages: [freshFirst, freshSecond], overlays: [] },
      activePageId: freshSecond.id,
      undoStack: [],
      redoStack: [],
    });

    useEditorStore.getState().commit({
      pages: [restoredSecond, restoredFirst],
    });

    expect(useEditorStore.getState().activePageId).toBe(restoredSecond.id);
  });

  test("applies a prebuilt model and Undo snapshot in one synchronous step", () => {
    const page = makePage("page-1");
    const ink = makeInk("ink-1", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      undoStack: [],
      redoStack: [],
    });

    const prepared = useEditorStore.getState().prepareCommit({ overlays: [ink] });
    expect(useEditorStore.getState().model.overlays).toEqual([]);
    expect(useEditorStore.getState().commitPrepared(prepared)).toBe(true);
    expect(useEditorStore.getState().model.overlays).toEqual([ink]);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toEqual([]);
  });

  test("refuses a stale prepared commit after document history changes", () => {
    const page = makePage("page-1");
    const first = makeInk("ink-1", page.id);
    const concurrent = makeInk("ink-2", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      undoStack: [],
      redoStack: [],
    });

    const prepared = useEditorStore.getState().prepareCommit({ overlays: [first] });
    useEditorStore.getState().commit({ overlays: [concurrent] });

    expect(useEditorStore.getState().commitPrepared(prepared)).toBe(false);
    expect(useEditorStore.getState().model.overlays).toEqual([concurrent]);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
  });

  test("publishes a Live batch, selection, receipt, and reveal intent atomically", () => {
    const page = makePage("page-a");
    const overlay = makeText("live-text", page.id, "Hello");
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      undoStack: [],
      redoStack: [],
      selectedIds: ["old"],
      liveOverlayReveals: [],
    });
    const prepared = useEditorStore
      .getState()
      .prepareOverlayBatchCommit([overlay], "operation-a");
    const reveal = prepareLiveOverlayRevealBatch("operation-a", [overlay]);
    const snapshots: Array<{
      overlays: number;
      history: number;
      receipts: number;
      reveals: number;
      pendingReveals: number;
      selected: number;
    }> = [];
    const unsubscribe = useEditorStore.subscribe((state) => {
      snapshots.push({
        overlays: state.model.overlays.length,
        history: state.undoStack.length,
        receipts: state.completedLiveOperationIds.size,
        reveals: state.liveOverlayReveals.length,
        pendingReveals: state.pendingOverlayReveals.size,
        selected: state.selectedIds.length,
      });
    });
    try {
      expect(
        useEditorStore.getState().commitPreparedOverlayBatch(prepared, {
          liveOverlayReveal: reveal,
          selectedIds: [overlay.id],
        }),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
    expect(snapshots).toEqual([
      {
        overlays: 1,
        history: 1,
        receipts: 1,
        reveals: 0,
        pendingReveals: 1,
        selected: 1,
      },
    ]);
  });

  test("bounds cross-call Live reveal backlog without delaying document state", () => {
    const page = makePage("page-a");
    const overlay = makeText("live-new", page.id, "Newest");
    const oldOverlay = makeText("live-old", page.id, "Older");
    const oldPrepared = prepareLiveOverlayRevealBatch("operation-old", [
      oldOverlay,
    ])!;
    const now = Date.now();
    useEditorStore.setState({
      model: { pages: [page], overlays: [oldOverlay] },
      undoStack: [],
      redoStack: [],
      liveOverlayReveals: [{
        ...oldPrepared,
        startedAtMs: now,
        endsAtMs: now + 44_900,
      }],
    });
    const prepared = useEditorStore
      .getState()
      .prepareOverlayBatchCommit([overlay], "operation-new");
    const reveal = prepareLiveOverlayRevealBatch("operation-new", [overlay]);

    expect(
      useEditorStore.getState().commitPreparedOverlayBatch(prepared, {
        liveOverlayReveal: reveal,
      }),
    ).toBe(true);
    useEditorStore.getState().activatePendingOverlayReveals([overlay.id]);
    const state = useEditorStore.getState();
    expect(state.model.overlays).toEqual([oldOverlay, overlay]);
    expect(state.liveOverlayReveals).toHaveLength(1);
    expect(state.liveOverlayReveals[0]?.itemsById.has(overlay.id)).toBe(true);
    expect(state.liveOverlayReveals[0]!.endsAtMs - now).toBeLessThan(45_000);
  });

  test("cleans expired reveal receipts and Undo never replays them", async () => {
    const page = makePage("page-a");
    const overlay = makeText("live-text", page.id, "Hello");
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      undoStack: [],
      redoStack: [],
      liveOverlayReveals: [],
    });
    const prepared = useEditorStore.getState().prepareCommit({ overlays: [overlay] });
    const reveal = {
      id: "operation-short",
      itemsById: new Map([
        [overlay.id, { overlayId: overlay.id, offsetMs: 0, durationMs: 1 }],
      ]),
      totalDurationMs: 1,
    };
    useEditorStore.getState().commitPrepared(prepared, { liveOverlayReveal: reveal });
    expect(useEditorStore.getState().pendingOverlayReveals.has(overlay.id)).toBe(
      true,
    );
    useEditorStore.getState().activatePendingOverlayReveals([overlay.id]);
    expect(useEditorStore.getState().liveOverlayReveals).toHaveLength(1);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 120));
    expect(useEditorStore.getState().liveOverlayReveals).toHaveLength(0);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().liveOverlayReveals).toHaveLength(0);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().liveOverlayReveals).toHaveLength(0);
  });

  test("stores a Live batch as one compact group with per-overlay Undo", () => {
    const page = makePage("page-1");
    const overlays = [
      makeInk("ink-1", page.id),
      makeInk("ink-2", page.id),
      makeInk("ink-3", page.id),
    ];
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      undoStack: [],
      redoStack: [],
      completedLiveOperationIds: new Set<string>(),
      selectedIds: overlays.map((overlay) => overlay.id),
    });

    const prepared = useEditorStore
      .getState()
      .prepareOverlayBatchCommit(overlays, "operation-a");
    expect(useEditorStore.getState().commitPreparedOverlayBatch(prepared)).toBe(true);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    expect(useEditorStore.getState().completedLiveOperationIds.has("operation-a")).toBe(
      true,
    );

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays.map((overlay) => overlay.id)).toEqual(
      ["ink-1", "ink-2"],
    );
    expect(useEditorStore.getState().selectedIds).toEqual(["ink-1", "ink-2"]);
    useEditorStore.getState().undo();
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toEqual([]);
    expect(useEditorStore.getState().completedLiveOperationIds.has("operation-a")).toBe(
      true,
    );

    useEditorStore.getState().redo();
    useEditorStore.getState().redo();
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().model.overlays.map((overlay) => overlay.id)).toEqual(
      ["ink-1", "ink-2", "ink-3"],
    );
  });

  test("counts a multi-rect annotation as one Undo delta", () => {
    const page = makePage("page-1");
    const highlight = {
      type: "highlight" as const,
      id: "highlight-1",
      pageId: page.id,
      rects: [
        { x: 10, y: 20, w: 30, h: 8 },
        { x: 10, y: 30, w: 40, h: 8 },
      ],
      color: "#f6c744",
      opacity: 0.35,
    };
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      undoStack: [],
      redoStack: [],
      completedLiveOperationIds: new Set<string>(),
    });
    const prepared = useEditorStore
      .getState()
      .prepareOverlayBatchCommit([highlight], "operation-highlight");
    useEditorStore.getState().commitPreparedOverlayBatch(prepared);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toEqual([]);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });

  test("keeps one compact draft group for a partially undone batch", () => {
    const page = makePage("page-1");
    const overlays = [
      makeInk("ink-1", page.id),
      makeInk("ink-2", page.id),
      makeInk("ink-3", page.id),
    ];
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      undoStack: [],
      redoStack: [],
      completedLiveOperationIds: new Set<string>(),
    });
    const prepared = useEditorStore
      .getState()
      .prepareOverlayBatchCommit(overlays, "operation-draft");
    useEditorStore.getState().commitPreparedOverlayBatch(prepared);
    useEditorStore.getState().undo();

    const [persisted] = useEditorStore.getState().undoStack;
    expect(persisted).toMatchObject({
      kind: "overlay-batch",
      operationId: "operation-draft",
      cursor: 2,
    });
    expect(persisted?.overlays).toHaveLength(3);
  });

  test("caps Live history by top-level batch groups", () => {
    const page = makePage("page-1");
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      undoStack: [],
      redoStack: [],
      completedLiveOperationIds: new Set<string>(),
    });
    for (let index = 0; index < 101; index += 1) {
      const prepared = useEditorStore
        .getState()
        .prepareOverlayBatchCommit(
          [makeInk(`ink-${index}`, page.id)],
          `operation-${index}`,
        );
      useEditorStore.getState().commitPreparedOverlayBatch(prepared);
    }
    expect(useEditorStore.getState().model.overlays).toHaveLength(101);
    expect(useEditorStore.getState().undoStack).toHaveLength(100);
  });
});

describe("commitRestoredDraft", () => {
  test("maps the active source page onto restored draft page IDs", () => {
    const freshFirst = makePage("fresh-page-1", {
      sourceIndex: 0,
      blank: false,
    });
    const freshSecond = makePage("fresh-page-2", {
      sourceIndex: 1,
      blank: false,
    });
    const draftSecond = makePage("draft-page-2", {
      sourceIndex: 1,
      blank: false,
    });
    const draftFirst = makePage("draft-page-1", {
      sourceIndex: 0,
      blank: false,
    });
    useEditorStore.getState().setOpened(
      {
        fileName: "restored.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [freshFirst, freshSecond],
      undefined,
      { initialPageIndex: 1 },
    );

    useEditorStore.getState().commitRestoredDraft(
      { pages: [draftFirst, draftSecond], overlays: [] },
      [],
    );

    expect(useEditorStore.getState().activePageId).toBe(draftSecond.id);
    // A pre-history/legacy draft still gets one restore step back to the
    // freshly opened source; topology gating must not change that contract.
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().activePageId).toBe(freshSecond.id);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().activePageId).toBe(draftSecond.id);
  });

  test("does not join empty history to an incompatible physical page order", () => {
    const freshFirst = makePage("fresh-page-1", {
      sourceIndex: 0,
      blank: false,
    });
    const freshSecond = makePage("fresh-page-2", {
      sourceIndex: 1,
      blank: false,
    });
    const physicallyAppended = makePage("fresh-page-3", {
      sourceIndex: 2,
      blank: false,
    });
    useEditorStore.getState().setOpened(
      {
        fileName: "inserted.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [freshFirst, freshSecond, physicallyAppended],
    );
    const restored = {
      pages: [freshFirst, physicallyAppended, freshSecond],
      overlays: [],
    };

    // trimHistory() may legally drop an oversized newest entry, so [] cannot
    // by itself prove this is a history-free legacy draft.
    useEditorStore.getState().commitRestoredDraft(restored, []);
    expect(useEditorStore.getState().model.pages).toEqual(restored.pages);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.pages).toEqual(restored.pages);
  });

  test("keeps pending note disclosure IDs until the draft model is restored", () => {
    const page = makePage("page-1", { sourceIndex: 0, blank: false });
    const draftNote = makeNote("draft-note", page.id);
    useEditorStore.getState().setOpened(
      {
        fileName: "restored.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [page],
    );
    useEditorStore.getState().setCollapsedNoteIds([draftNote.id]);
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([draftNote.id]);

    useEditorStore.getState().commitRestoredDraft({ overlays: [draftNote] }, []);
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([draftNote.id]);
    expect(capturePdfEditorSession()?.collapsedNoteIds).toEqual([draftNote.id]);
  });

  test("seeds persisted history beneath the restore step so undo crosses sessions", () => {
    const page = makePage("page-1", { sourceIndex: 0, blank: false });
    useEditorStore.getState().setOpened(
      {
        fileName: "restored.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [page],
    );

    // Persisted history from the previous session: empty page → one stroke.
    const inkA = makeInk("ink-a", page.id);
    const inkB = makeInk("ink-b", page.id);
    const history = [
      { pages: [page], overlays: [] },
      { pages: [page], overlays: [inkA] },
    ];
    const completedOperationId = "a".repeat(64);
    useEditorStore
      .getState()
      .commitRestoredDraft(
        { pages: [page], overlays: [inkA, inkB] },
        history,
        [completedOperationId],
      );

    const restored = useEditorStore.getState();
    expect(restored.model.overlays.map((o) => o.id)).toEqual(["ink-a", "ink-b"]);
    // pre-restore fresh model (1) + history (2)
    expect(restored.undoStack).toHaveLength(3);
    expect(restored.completedLiveOperationIds.has(completedOperationId)).toBe(
      true,
    );

    // Undo walks the draft's timeline: restored draft → newest history →
    // oldest history → this session's pre-restore state.
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays.map((o) => o.id)).toEqual(["ink-a"]);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays.map((o) => o.id)).toEqual([]);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toEqual([]);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);

    // Redo returns all the way to the restored draft.
    useEditorStore.getState().redo();
    useEditorStore.getState().redo();
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().model.overlays.map((o) => o.id)).toEqual([
      "ink-a",
      "ink-b",
    ]);
  });

  test("restores a compact Live group with per-overlay Undo intact", () => {
    const page = makePage("page-live", { sourceIndex: 0, blank: false });
    const first = makeInk("ink-live-1", page.id);
    const second = makeInk("ink-live-2", page.id);
    useEditorStore.getState().setOpened(
      {
        fileName: "restored-live.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [page],
    );
    useEditorStore.getState().commitRestoredDraft(
      { pages: [page], overlays: [first] },
      [
        {
          kind: "overlay-batch",
          operationId: "e".repeat(64),
          overlays: [first, second],
          cursor: 1,
        },
      ],
      ["e".repeat(64)],
    );

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toEqual([]);
    expect(useEditorStore.getState().completedLiveOperationIds.has("e".repeat(64))).toBe(
      true,
    );
  });
});

describe("restoreBaselineModel", () => {
  test("swaps to the baseline with no draft state reachable via undo", () => {
    const page = makePage("page-1", { sourceIndex: 0, blank: false });
    const draftInk = makeInk("draft-ink", page.id);
    useEditorStore.getState().setOpened(
      {
        fileName: "baseline.pdf",
        fileSize: 123,
        doc: {} as never,
        bytes: new Uint8Array([1, 2, 3]),
      },
      [page],
    );
    const baseline = useEditorStore.getState().model;
    // Silent restore puts the draft on top with history beneath it.
    useEditorStore.getState().commitRestoredDraft(
      { pages: [page], overlays: [draftInk] },
      [{ pages: [page], overlays: [] }],
    );
    useEditorStore.getState().selectOnly(draftInk.id);
    expect(useEditorStore.getState().undoStack.length).toBeGreaterThan(0);

    useEditorStore.getState().restoreBaselineModel(baseline);

    const state = useEditorStore.getState();
    expect(state.model).toBe(baseline);
    // An undo into the set-aside draft would immediately re-raise the
    // overwrite conflict — the timeline must start fresh.
    expect(state.undoStack).toHaveLength(0);
    expect(state.redoStack).toHaveLength(0);
    expect(state.selectedIds).toEqual([]);
  });
});

describe("PDF editor session snapshots", () => {
  test("does not restore or activate stale reveals after animations are disabled", () => {
    const page = makePage("page-callout");
    const callout = makeCallout("callout-pending", page.id);
    const reveal = prepareLiveOverlayRevealBatch("open-callout", [callout]);
    useAppStore.setState({
      prefs: { ...useAppStore.getState().prefs, annotationAnimations: true },
    });
    useEditorStore.getState().setOpened(
      {
        fileName: "callout.pdf",
        fileSize: 100,
        doc: {} as never,
        bytes: new Uint8Array([1]),
      },
      [page],
      { pages: [page], overlays: [callout] },
      { initialOverlayReveal: reveal },
    );
    const session = capturePdfEditorSession();
    if (!session || !reveal) throw new Error("expected pending reveal session");
    expect(session.pendingOverlayReveals.has(callout.id)).toBe(true);

    useAppStore.getState().setPrefs({ annotationAnimations: false });
    restorePdfEditorSession(session);
    expect(useEditorStore.getState().pendingOverlayReveals.size).toBe(0);

    useEditorStore.setState({
      pendingOverlayReveals: new Map(reveal.itemsById),
    });
    useEditorStore.getState().activatePendingOverlayReveals([callout.id]);
    expect(useEditorStore.getState().pendingOverlayReveals.size).toBe(0);
    expect(useEditorStore.getState().liveOverlayReveals).toHaveLength(0);
  });

  test("keeps collapsed notes per document without touching model history", () => {
    const pageA = makePage("page-a");
    const pageB = makePage("page-b");
    const note = makeNote("note-a", pageA.id);
    const text = makeText("not-a-note", pageA.id, "body");
    useEditorStore.getState().setOpened(
      {
        fileName: "a.pdf",
        fileSize: 100,
        doc: {} as never,
        bytes: new Uint8Array([1]),
      },
      [pageA],
      { pages: [pageA], overlays: [note, text] },
    );
    const modelBefore = useEditorStore.getState().model;
    const undoBefore = useEditorStore.getState().undoStack;

    useEditorStore.getState().setNoteCollapsed(note.id, true);
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([note.id]);
    expect(useEditorStore.getState().model).toBe(modelBefore);
    expect(useEditorStore.getState().undoStack).toBe(undoBefore);
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
    useEditorStore.getState().setCollapsedNoteIds([
      note.id,
      "missing-note",
      text.id,
    ]);
    // Workspace state is allowed to arrive before a recoverable draft model.
    // Keep bounded unmatched IDs temporarily; session capture prunes them.
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([
      note.id,
      "missing-note",
      text.id,
    ]);
    const first = capturePdfEditorSession();
    if (!first) throw new Error("expected first session");
    expect(first.collapsedNoteIds).toEqual([note.id]);
    const pendingRestoreSession = capturePdfEditorSession({
      preserveUnmatchedCollapsedNoteIds: true,
    });
    expect(pendingRestoreSession?.collapsedNoteIds).toEqual([
      note.id,
      "missing-note",
      text.id,
    ]);

    useEditorStore.getState().setOpened(
      {
        fileName: "b.pdf",
        fileSize: 200,
        doc: {} as never,
        bytes: new Uint8Array([2]),
      },
      [pageB],
    );
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([]);

    restorePdfEditorSession(first);
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([note.id]);
    useEditorStore.getState().toggleNoteCollapsed(note.id);
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([]);

    if (!pendingRestoreSession) throw new Error("expected pending session");
    restorePdfEditorSession(pendingRestoreSession, {
      preserveUnmatchedCollapsedNoteIds: true,
    });
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([
      note.id,
      "missing-note",
      text.id,
    ]);
  });

  test("restore keeps undo and redo isolated to the captured tab", () => {
    const pageA = makePage("page-a");
    const pageB = makePage("page-b");
    const textA = makeText("text-a", pageA.id, "alpha");
    const inkB = makeInk("ink-b", pageB.id);

    useEditorStore.getState().setOpened(
      {
        fileName: "a.pdf",
        fileSize: 100,
        doc: {} as never,
        bytes: new Uint8Array([1]),
      },
      [pageA],
    );
    useEditorStore.getState().addOverlay(textA);
    useEditorStore.getState().setScale(1.7);
    useEditorStore.setState({ showThumbs: false, activePageId: pageA.id });
    const first = capturePdfEditorSession();
    if (!first) throw new Error("expected first session");

    useEditorStore.getState().setOpened(
      {
        fileName: "b.pdf",
        fileSize: 200,
        doc: {} as never,
        bytes: new Uint8Array([2]),
      },
      [pageB],
    );
    useEditorStore.getState().addOverlay(inkB);
    useEditorStore.getState().undo();
    const second = capturePdfEditorSession();
    if (!second) throw new Error("expected second session");

    restorePdfEditorSession(first);
    expect(useEditorStore.getState().opened?.fileName).toBe("a.pdf");
    expect(useEditorStore.getState().model.overlays.map((o) => o.id)).toEqual([
      "text-a",
    ]);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
    expect(useEditorStore.getState().scale).toBe(1.7);
    expect(useEditorStore.getState().showThumbs).toBe(false);

    restorePdfEditorSession(second);
    expect(useEditorStore.getState().opened?.fileName).toBe("b.pdf");
    expect(useEditorStore.getState().model.overlays).toHaveLength(0);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
    expect(useEditorStore.getState().redoStack.map((entry) => entry.overlays.length)).toEqual([
      1,
    ]);
  });

  test("preserves a partially undone Live batch and its receipt across tabs", () => {
    const page = makePage("page-live");
    const overlays = [
      makeInk("ink-live-1", page.id),
      makeInk("ink-live-2", page.id),
    ];
    const operationId = "c".repeat(64);
    useEditorStore.getState().setOpened(
      {
        fileName: "live.pdf",
        fileSize: 100,
        doc: {} as never,
        bytes: new Uint8Array([1]),
      },
      [page],
    );
    const prepared = useEditorStore
      .getState()
      .prepareOverlayBatchCommit(overlays, operationId);
    useEditorStore.getState().commitPreparedOverlayBatch(prepared);
    useEditorStore.getState().undo();
    const session = capturePdfEditorSession();
    if (!session) throw new Error("expected Live session");

    useEditorStore.getState().setOpened(
      {
        fileName: "other.pdf",
        fileSize: 100,
        doc: {} as never,
        bytes: new Uint8Array([2]),
      },
      [makePage("other-page")],
    );
    restorePdfEditorSession(session);

    expect(useEditorStore.getState().model.overlays.map((overlay) => overlay.id)).toEqual(
      ["ink-live-1"],
    );
    expect(useEditorStore.getState().completedLiveOperationIds.has(operationId)).toBe(
      true,
    );
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().model.overlays.map((overlay) => overlay.id)).toEqual(
      ["ink-live-1", "ink-live-2"],
    );
    useEditorStore.getState().undo();
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toEqual([]);
  });
});

describe("the right rail survives document changes", () => {
  // Three separate code paths used to close it, and each was reported as a
  // fresh bug because each had a different trigger: switching a loaded tab,
  // loading one from disk, and opening any document at all (which closes the
  // previous one first — the path every Markdown and HTML tab takes). The rail
  // holds a terminal; closing it kills a running session.
  test("restorePdfEditorSession leaves it where the reader put it", () => {
    const page = makePage("page-rail");
    useEditorStore.getState().setOpened(
      {
        fileName: "a.pdf",
        fileSize: 10,
        doc: {} as never,
        bytes: new Uint8Array([1]),
      },
      [page],
      { pages: [page], overlays: [] },
    );
    useAppStore.setState({ showRail: false, railTab: "terminal" });
    const session = capturePdfEditorSession();
    if (!session) throw new Error("expected a session");

    useAppStore.getState().setShowRail(true);
    restorePdfEditorSession(session);

    expect(useAppStore.getState().showRail).toBe(true);
    expect(useAppStore.getState().railTab).toBe("terminal");
  });

  test("closeDocument leaves it where the reader put it", () => {
    useAppStore.setState({ showRail: true, railTab: "browser" });
    useEditorStore.getState().closeDocument();
    expect(useAppStore.getState().showRail).toBe(true);
    expect(useAppStore.getState().railTab).toBe("browser");
  });
});

describe("store editing cleanup", () => {
  test("removes an empty inserted text overlay when editing is cleared", () => {
    const page = makePage("page-a");
    const emptyText = makeText("text-empty", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [emptyText] },
      selectedIds: [emptyText.id],
      editingOverlayId: emptyText.id,
    });

    useEditorStore.getState().setEditingOverlayId(null);

    const { model, selectedIds, editingOverlayId } = useEditorStore.getState();
    expect(model.overlays).toHaveLength(0);
    expect(selectedIds).toEqual([]);
    expect(editingOverlayId).toBeNull();
  });

  test("removes the creation undo step when empty inserted text is cleared", () => {
    const page = makePage("page-a");
    const emptyText = makeText("text-empty", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      selectedIds: [],
      undoStack: [],
      redoStack: [],
    });

    useEditorStore.getState().addOverlay(emptyText);
    useEditorStore.setState({
      selectedIds: [emptyText.id],
      editingOverlayId: emptyText.id,
    });
    useEditorStore.getState().setEditingOverlayId(null);

    const { model, undoStack } = useEditorStore.getState();
    expect(model.overlays).toHaveLength(0);
    expect(undoStack).toHaveLength(0);
  });

  test("keeps earlier undo history when empty inserted text is cleared", () => {
    const page = makePage("page-a");
    const ink = makeInk("ink-a", page.id);
    const emptyText = makeText("text-empty", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [ink] },
      selectedIds: [],
      undoStack: [{ pages: [page], overlays: [] }],
      redoStack: [],
    });

    useEditorStore.getState().addOverlay(emptyText);
    useEditorStore.setState({
      selectedIds: [emptyText.id],
      editingOverlayId: emptyText.id,
    });
    useEditorStore.getState().setEditingOverlayId(null);
    useEditorStore.getState().undo();

    const { model, undoStack } = useEditorStore.getState();
    expect(model.overlays).toHaveLength(0);
    expect(undoStack).toHaveLength(0);
  });

  test("keeps a non-empty inserted text overlay when editing is cleared", () => {
    const page = makePage("page-a");
    const text = makeText("text-filled", page.id, "hello");
    useEditorStore.setState({
      model: { pages: [page], overlays: [text] },
      selectedIds: [text.id],
      editingOverlayId: text.id,
    });

    useEditorStore.getState().setEditingOverlayId(null);

    const { model, selectedIds, editingOverlayId } = useEditorStore.getState();
    expect(model.overlays.map((overlay) => overlay.id)).toEqual([text.id]);
    expect(selectedIds).toEqual([text.id]);
    expect(editingOverlayId).toBeNull();
  });

  test("keeps the creation undo step when inserted text receives content", () => {
    const page = makePage("page-a");
    const text = makeText("text-filled", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      selectedIds: [],
      undoStack: [],
      redoStack: [],
    });

    useEditorStore.getState().addOverlay(text);
    useEditorStore.setState({
      selectedIds: [text.id],
      editingOverlayId: text.id,
    });
    useEditorStore
      .getState()
      .updateOverlayNoHistory(text.id, { text: "hello" } as Partial<TextOverlay>);
    useEditorStore.getState().setEditingOverlayId(null);
    useEditorStore.getState().undo();

    const { model, undoStack } = useEditorStore.getState();
    expect(model.overlays).toHaveLength(0);
    expect(undoStack).toHaveLength(0);
  });

  test("removes an empty inserted text overlay when editing switches", () => {
    const page = makePage("page-a");
    const emptyText = makeText("text-empty", page.id);
    const nextText = makeText("text-next", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [emptyText, nextText] },
      selectedIds: [nextText.id],
      editingOverlayId: emptyText.id,
    });

    useEditorStore.getState().setEditingOverlayId(nextText.id);

    const { model, selectedIds, editingOverlayId } = useEditorStore.getState();
    expect(model.overlays.map((overlay) => overlay.id)).toEqual([nextText.id]);
    expect(selectedIds).toEqual([nextText.id]);
    expect(editingOverlayId).toBe(nextText.id);
  });

  test("keeps a non-empty inserted text overlay when editing switches", () => {
    const page = makePage("page-a");
    const text = makeText("text-filled", page.id, "hello");
    const nextText = makeText("text-next", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [text, nextText] },
      selectedIds: [nextText.id],
      editingOverlayId: text.id,
    });

    useEditorStore.getState().setEditingOverlayId(nextText.id);

    const { model, selectedIds, editingOverlayId } = useEditorStore.getState();
    expect(model.overlays.map((overlay) => overlay.id)).toEqual([
      text.id,
      nextText.id,
    ]);
    expect(selectedIds).toEqual([nextText.id]);
    expect(editingOverlayId).toBe(nextText.id);
  });

  test("removes an unchanged content text edit when switching tools", () => {
    const page = makePage("page-a");
    const edit = makeContentText("content-text", page.id);
    useEditorStore.setState({
      model: { pages: [page], overlays: [edit] },
      selectedIds: [edit.id],
      editingOverlayId: edit.id,
      tool: "text",
    });

    useEditorStore.getState().setTool("select");

    const { model, selectedIds, editingOverlayId, tool } = useEditorStore.getState();
    expect(model.overlays).toHaveLength(0);
    expect(selectedIds).toEqual([]);
    expect(editingOverlayId).toBeNull();
    expect(tool).toBe("select");
  });
});

describe("store deletePage", () => {
  test("drops the page and every overlay tied to it", () => {
    const a = makePage("page-a");
    const b = makePage("page-b");
    useEditorStore.setState({
      model: {
        pages: [a, b],
        overlays: [makeInk("ink-a-1", "page-a"), makeInk("ink-b-1", "page-b")],
      },
      activePageId: "page-a",
    });

    useEditorStore.getState().deletePage("page-a");

    const { model, activePageId } = useEditorStore.getState();
    expect(model.pages.map((p) => p.id)).toEqual(["page-b"]);
    expect(model.overlays.map((o) => o.id)).toEqual(["ink-b-1"]);
    expect(activePageId).toBe("page-b");
  });

  test("leaves overlays on other pages untouched", () => {
    const a = makePage("page-a");
    const b = makePage("page-b");
    const c = makePage("page-c");
    useEditorStore.setState({
      model: {
        pages: [a, b, c],
        overlays: [
          makeInk("ink-a-1", "page-a"),
          makeInk("ink-a-2", "page-a"),
          makeInk("ink-b-1", "page-b"),
          makeInk("ink-c-1", "page-c"),
        ],
      },
      activePageId: "page-b",
    });

    useEditorStore.getState().deletePage("page-a");

    const { model, activePageId } = useEditorStore.getState();
    expect(model.pages.map((p) => p.id)).toEqual(["page-b", "page-c"]);
    expect(model.overlays.map((o) => o.id)).toEqual(["ink-b-1", "ink-c-1"]);
    // Active page wasn't deleted, so the selection shouldn't change.
    expect(activePageId).toBe("page-b");
  });

  test("refuses to delete the last remaining page", () => {
    const only = makePage("page-only");
    useEditorStore.setState({
      model: {
        pages: [only],
        overlays: [makeInk("ink-only-1", "page-only")],
      },
      activePageId: "page-only",
    });

    useEditorStore.getState().deletePage("page-only");

    const { model } = useEditorStore.getState();
    expect(model.pages.map((p) => p.id)).toEqual(["page-only"]);
    expect(model.overlays.map((o) => o.id)).toEqual(["ink-only-1"]);
  });

  test("undo restores the deleted page and its overlays", () => {
    const a = makePage("page-a");
    const b = makePage("page-b");
    const inkA = makeInk("ink-a-1", "page-a");
    const inkB = makeInk("ink-b-1", "page-b");
    useEditorStore.setState({
      model: { pages: [a, b], overlays: [inkA, inkB] },
      undoStack: [],
      redoStack: [],
      activePageId: "page-a",
    });

    useEditorStore.getState().deletePage("page-a");
    useEditorStore.getState().undo();

    const { model } = useEditorStore.getState();
    expect(model.pages.map((p) => p.id)).toEqual(["page-a", "page-b"]);
    expect(model.overlays.map((o) => o.id)).toEqual(["ink-a-1", "ink-b-1"]);
  });

  test("editing an overlay records that the reader touched it", () => {
    // Only notes have an updatedAt of their own; every other shape relied on
    // this, and without it an edited callout looked untouched to anything
    // ranking by recency.
    const before = Date.now();
    useEditorStore.setState({
      model: {
        pages: [
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [
          {
            type: "callout",
            id: "c1",
            pageId: "p1",
            targetRects: [],
            rect: { x: 0, y: 0, w: 10, h: 10 },
            text: "before",
            fontSize: 11,
            color: "#000000",
            bold: false,
            align: "left",
            fontFamily: "sans",
            origin: "imported",
            importedAt: before - 10_000,
          },
        ],
      },
    } as never);

    useEditorStore.getState().updateOverlay("c1", { text: "after" } as never);

    const edited = useEditorStore.getState().model.overlays[0]!;
    expect((edited as { text: string }).text).toBe("after");
    expect(edited.localActivityAt).toBeGreaterThanOrEqual(before);
    // The import record is untouched — this is an edit, not a re-import.
    expect(edited.importedAt).toBe(before - 10_000);
  });
});
