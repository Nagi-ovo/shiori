import "../test/buildGlobals";
import { afterEach, describe, expect, test } from "bun:test";
import type { Overlay, PageModel } from "../pdf/model/types";
import { useEditorStore } from "../editor/store/store";
import { SemanticTextLimitError } from "../editor/textSelection/semanticText";
import type {
  LiveApiAnnotationRequest,
  LiveApiCompletion,
  LiveApiContext,
} from "../platform/liveApi";
import {
  applyLiveAnnotationRequest,
  buildLiveApiContext,
  connectLiveApiBridge,
  createLiveRequestDeadlineGuard,
  createLivePageTextContentReader,
  LIVE_API_DEADLINE_SAFETY_MS,
  createLiveContextPublisher,
  deriveLiveOperationId,
  serializeLivePageTopology,
  type ActiveLivePdf,
  type LiveAnnotationDependencies,
} from "./liveApiBridge";
import { setAppPdfEngineForTest } from "../pdf/engine/appEngine";
import type { PdfDocument } from "../pdf/engine/types";
import { fakePdfDocument, fakePdfEngine } from "../test/fakePdfEngine";

const initialStore = useEditorStore.getState();
const pages: PageModel[] = [
  {
    id: "page-a",
    sourceIndex: 0,
    rotation: 0,
    widthPt: 612,
    heightPt: 792,
  },
  {
    id: "page-b",
    sourceIndex: 1,
    rotation: 90,
    widthPt: 792,
    heightPt: 612,
  },
];
const OPERATION_ID = "d".repeat(64);
const PAGE_TOPOLOGY_HASH = "e".repeat(64);
const FUTURE_EXPIRES_AT_MS = Date.now() + 30_000;

afterEach(() => {
  useEditorStore.setState(initialStore, true);
});

describe("Live API context", () => {
  test("reports the current PDF and a 1-based active page", () => {
    expect(
      buildLiveApiContext({
        ready: true,
        documentId: "tab-a",
        name: "paper.pdf",
        path: "/papers/paper.pdf",
        sha256: "abc",
        pageTopologyHash: PAGE_TOPOLOGY_HASH,
        pages,
        activePageId: "page-b",
        annotationCount: 7,
        dirty: true,
      }),
    ).toEqual({
      documentId: "tab-a",
      name: "paper.pdf",
      path: "/papers/paper.pdf",
      sha256: "abc",
      pageTopologyHash: PAGE_TOPOLOGY_HASH,
      pageCount: 2,
      activePage: {
        page: 2,
        widthPt: 792,
        heightPt: 612,
        rotation: 90,
      },
      annotationCount: 7,
      dirty: true,
    });
  });

  test("keeps ready PDF context while activePage is temporarily unavailable", () => {
    const context = buildLiveApiContext({
      ready: true,
      documentId: "tab-a",
      name: "paper.pdf",
      sha256: "abc",
      pageTopologyHash: PAGE_TOPOLOGY_HASH,
      pages,
      activePageId: null,
      annotationCount: 0,
      dirty: false,
    });
    expect(context).toMatchObject({ documentId: "tab-a", pageCount: 2 });
    expect(context).not.toHaveProperty("activePage");
    expect(
      buildLiveApiContext({
        ready: false,
        documentId: "tab-a",
        name: "paper.pdf",
        sha256: "abc",
        pageTopologyHash: PAGE_TOPOLOGY_HASH,
        pages,
        activePageId: "page-a",
        annotationCount: 0,
        dirty: false,
      }),
    ).toBeNull();
  });

  test("serializes context writes and preserves a trailing clear", async () => {
    const writes: Array<LiveApiContext | null> = [];
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const publisher = createLiveContextPublisher(async (context) => {
      writes.push(context);
      if (writes.length === 1) await firstBlocked;
    });
    const context = buildLiveApiContext({
      ready: true,
      documentId: "tab-a",
      name: "paper.pdf",
      sha256: "abc",
      pageTopologyHash: PAGE_TOPOLOGY_HASH,
      pages,
      activePageId: "page-a",
      annotationCount: 0,
      dirty: false,
    });
    publisher.publish(context);
    publisher.publish(null);
    releaseFirst?.();
    await publisher.flush();
    expect(writes).toEqual([context, null]);
  });

  test("fingerprints page order and geometry across a reopened PDF", () => {
    expect(
      serializeLivePageTopology(
        pages.map((page, index) => ({
          ...page,
          id: `new-session-page-${index}`,
        })),
      ),
    ).toBe(serializeLivePageTopology(pages));
    expect(serializeLivePageTopology([...pages].reverse())).not.toBe(
      serializeLivePageTopology(pages),
    );
    expect(
      serializeLivePageTopology([
        { ...pages[0]!, rotation: 90 },
        pages[1]!,
      ]),
    ).not.toBe(serializeLivePageTopology(pages));
  });
});

describe("Live API annotation events", () => {
  test("completes an event through the transport", async () => {
    let handler:
      | ((request: LiveApiAnnotationRequest) => void | Promise<void>)
      | null = null;
    const completions: Array<{ requestId: string; result: LiveApiCompletion }> = [];
    const access = fakeAccess();
    const dispose = await connectLiveApiBridge(
      { getActivePdf: () => access },
      {
        listen: async (next) => {
          handler = next;
          return () => undefined;
        },
        authorizeMutation: async () => undefined,
        complete: async (requestId, result) => {
          completions.push({ requestId, result });
        },
      },
    );

    const request = noteRequest(false);
    request.operationId = await deriveLiveOperationId(request);
    await handler?.(request);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      requestId: "request-1",
      result: {
        ok: true,
        data: {
          operationId: request.operationId,
          added: 1,
          dryRun: false,
        },
      },
    });
    dispose();
  });

  test("rejects an operation id that does not authenticate its spec", async () => {
    let handler:
      | ((request: LiveApiAnnotationRequest) => void | Promise<void>)
      | null = null;
    let completion: LiveApiCompletion | null = null;
    let commits = 0;
    const access = fakeAccess({
      commitOverlays: () => {
        commits += 1;
      },
    });
    const dispose = await connectLiveApiBridge(
      { getActivePdf: () => access },
      {
        listen: async (next) => {
          handler = next;
          return () => undefined;
        },
        authorizeMutation: async () => undefined,
        complete: async (_requestId, result) => {
          completion = result;
        },
      },
    );

    await handler?.(noteRequest(false));
    expect(completion).toMatchObject({
      ok: false,
      error: { code: "SPEC_INVALID" },
    });
    expect(commits).toBe(0);
    dispose();
  });

  test("rejects operation specs deeper than the canonical JSON limit", async () => {
    let spec: Record<string, unknown> = {};
    for (let depth = 0; depth < 140; depth += 1) spec = { nested: spec };
    const request = noteRequest(false);
    request.spec = spec;
    await expect(deriveLiveOperationId(request)).rejects.toThrow(
      "Spec nesting is too deep",
    );
  });

  test("rejects a target switch after parsing and before commit", () => {
    const first = fakeAccess({ documentId: "tab-a", sha256: "aaa" });
    const switched = fakeAccess({ documentId: "tab-b", sha256: "bbb" });
    let reads = 0;
    let commits = 0;
    first.commitOverlays = () => {
      commits += 1;
    };
    const result = applyLiveAnnotationRequest(
      noteRequest(false, {
        documentId: "tab-a",
        sha256: "aaa",
        pageTopologyHash: PAGE_TOPOLOGY_HASH,
      }),
      { getActivePdf: () => (reads++ === 0 ? first : switched) },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TARGET_CHANGED" },
    });
    expect(commits).toBe(0);
  });

  test("rejects page topology changes on the same source PDF", () => {
    const initial = fakeAccess();
    const rearranged = fakeAccess({ pageTopologyHash: "f".repeat(64) });
    let reads = 0;
    const result = applyLiveAnnotationRequest(noteRequest(false), {
      getActivePdf: () => (reads++ === 0 ? initial : rearranged),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TARGET_CHANGED" },
    });
  });

  test("validates dry-run without committing", () => {
    let commits = 0;
    const access = fakeAccess();
    access.commitOverlays = () => {
      commits += 1;
    };
    const result = applyLiveAnnotationRequest(noteRequest(true), {
      getActivePdf: () => access,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        added: 1,
        dryRun: true,
        // Projected post-operation total, not the untouched current count.
        annotationCount: 1,
      },
    });
    expect(commits).toBe(0);
  });

  test("applies direct page text at an explicit PDF-space rectangle", () => {
    let committed: Overlay[] = [];
    const access = fakeAccess({
      commitOverlays: (overlays) => {
        committed = overlays;
      },
    });
    const request = noteRequest(false);
    request.spec = {
      annotations: [
        {
          type: "text",
          page: 1,
          rect: { x: 72, y: 420, w: 180, h: 32 },
          text: "Direct page text",
        },
      ],
    };
    expect(
      applyLiveAnnotationRequest(request, { getActivePdf: () => access }),
    ).toMatchObject({ ok: true, data: { added: 1 } });
    expect(committed).toEqual([
      expect.objectContaining({
        type: "text",
        pageId: "page-a",
        rect: { x: 72, y: 420, w: 180, h: 32 },
        text: "Direct page text",
      }),
    ]);
  });

  test("commits a batch atomically but undoes and redoes each annotation", () => {
    const existing: Overlay = {
      type: "note",
      id: "existing",
      pageId: "page-a",
      rect: { x: 1, y: 2, w: 168, h: 94 },
      text: "old",
      color: "#f6c744",
    };
    useEditorStore.setState({
      model: { pages, overlays: [existing] },
      undoStack: [],
      redoStack: [],
      selectedIds: [],
    });
    const result = applyLiveAnnotationRequest(batchRequest(), {
      getActivePdf: storeAccess,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { added: 3, annotationCount: 4 },
    });
    expect(useEditorStore.getState().model.overlays).toHaveLength(4);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    expect(useEditorStore.getState().selectedIds).toHaveLength(3);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toHaveLength(3);
    expect(useEditorStore.getState().selectedIds).toHaveLength(2);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toHaveLength(2);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model.overlays).toEqual([existing]);
    expect(useEditorStore.getState().selectedIds).toEqual([]);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
    expect(useEditorStore.getState().redoStack).toHaveLength(1);

    useEditorStore.getState().redo();
    useEditorStore.getState().redo();
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().model.overlays).toHaveLength(4);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
  });

  test("accepts an empty patch without creating an Undo entry", () => {
    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
    });
    const result = applyLiveAnnotationRequest(
      {
        requestId: "empty",
        operationId: OPERATION_ID,
        expiresAtMs: FUTURE_EXPIRES_AT_MS,
        target: {
          documentId: "tab-a",
          sha256: "abc",
          pageTopologyHash: PAGE_TOPOLOGY_HASH,
        },
        spec: { schema: "shiori.annotations/v1", annotations: [] },
        dryRun: false,
      },
      { getActivePdf: storeAccess },
    );
    expect(result).toMatchObject({ ok: true, data: { added: 0 } });
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });

  test("makes a completed operation retry a no-op", () => {
    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
      selectedIds: [],
    });

    const first = applyLiveAnnotationRequest(batchRequest(), {
      getActivePdf: storeAccess,
    });
    const retried = applyLiveAnnotationRequest(batchRequest(), {
      getActivePdf: storeAccess,
    });

    expect(first).toMatchObject({ ok: true, data: { added: 3 } });
    expect(retried).toMatchObject({
      ok: true,
      data: {
        operationId: OPERATION_ID,
        added: 0,
        annotationCount: 3,
      },
    });
    if (retried.ok) expect(retried.data.annotationIds).toHaveLength(3);
    expect(useEditorStore.getState().model.overlays).toHaveLength(3);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
  });

  test("keeps a completed operation retry a no-op after partial and full Undo", () => {
    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
      selectedIds: [],
      completedLiveOperationIds: new Set<string>(),
    });

    const first = applyLiveAnnotationRequest(batchRequest(), {
      getActivePdf: storeAccess,
    });
    expect(first).toMatchObject({ ok: true, data: { added: 3 } });

    useEditorStore.getState().undo();
    const partialRetry = applyLiveAnnotationRequest(batchRequest(), {
      getActivePdf: storeAccess,
    });
    expect(partialRetry).toMatchObject({
      ok: true,
      data: { added: 0, annotationCount: 2 },
    });
    expect(useEditorStore.getState().model.overlays).toHaveLength(2);

    useEditorStore.getState().undo();
    useEditorStore.getState().undo();
    const fullRetry = applyLiveAnnotationRequest(batchRequest(), {
      getActivePdf: storeAccess,
    });
    expect(fullRetry).toMatchObject({
      ok: true,
      data: { added: 0, annotationCount: 0 },
    });
    expect(useEditorStore.getState().model.overlays).toHaveLength(0);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });

  test("rejects a partially present operation instead of guessing", () => {
    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
    });
    applyLiveAnnotationRequest(batchRequest(), { getActivePdf: storeAccess });
    const firstTwo = useEditorStore.getState().model.overlays.slice(0, 2);
    useEditorStore.setState({
      model: { pages, overlays: firstTwo },
      undoStack: [],
      redoStack: [],
      selectedIds: [],
      // Simulate an imported/corrupt partial operation without its in-session
      // receipt. A real user Undo retains the receipt and is covered above.
      completedLiveOperationIds: new Set<string>(),
    });

    const repaired = applyLiveAnnotationRequest(batchRequest(), {
      getActivePdf: storeAccess,
    });

    expect(repaired).toMatchObject({
      ok: false,
      error: { code: "OPERATION_CONFLICT" },
    });
    expect(useEditorStore.getState().model.overlays).toHaveLength(2);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
    expect(useEditorStore.getState().selectedIds).toHaveLength(0);
  });

  test("does not overwrite a completed operation whose overlay was edited", () => {
    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
    });
    applyLiveAnnotationRequest(noteRequest(false), { getActivePdf: storeAccess });
    const [created] = useEditorStore.getState().model.overlays;
    if (!created || created.type !== "note") throw new Error("expected note");
    useEditorStore.setState({
      model: {
        pages,
        overlays: [{ ...created, text: "user changed this note" }],
      },
      undoStack: [],
      redoStack: [],
    });

    const retried = applyLiveAnnotationRequest(noteRequest(false), {
      getActivePdf: storeAccess,
    });
    expect(retried).toMatchObject({
      ok: true,
      data: { added: 0, annotationCount: 1 },
    });
    expect(useEditorStore.getState().model.overlays[0]).toMatchObject({
      text: "user changed this note",
    });
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });

  test("rejects malformed operation identifiers before parsing", () => {
    const result = applyLiveAnnotationRequest(
      { ...noteRequest(false), operationId: "not-an-operation" },
      { getActivePdf: () => fakeAccess() },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
});

describe("live anchor resolution", () => {
  test("deadline guard remains valid when the wall clock moves backwards", () => {
    let wall = 1_000;
    let monotonic = 10;
    const guard = createLiveRequestDeadlineGuard(
      2_000,
      () => wall,
      () => monotonic,
    );
    expect(guard.shouldCancel()).toBe(false);
    wall = 0;
    monotonic = 510;
    expect(guard.shouldCancel()).toBe(true);
  });

  test("fails closed when the wall clock rolled back before guard creation", () => {
    let monotonic = 0;
    const guard = createLiveRequestDeadlineGuard(
      2_030_000,
      () => 1_000_000,
      () => monotonic,
    );
    expect(guard.shouldCancel()).toBe(true);

    const capped = createLiveRequestDeadlineGuard(
      2_030_000,
      () => 2_000_000,
      () => monotonic,
    );
    expect(capped.shouldCancel()).toBe(false);
    monotonic = 29_500;
    expect(capped.shouldCancel()).toBe(true);
  });

  function anchorTextContent() {
    return {
      items: [
        {
          str: "The",
          dir: "ltr",
          transform: [12, 0, 0, 12, 72, 700],
          width: 24,
          height: 12,
          fontName: "f1",
          hasEOL: false,
        },
        {
          str: "quick",
          dir: "ltr",
          transform: [12, 0, 0, 12, 100, 700],
          width: 30,
          height: 12,
          fontName: "f1",
          hasEOL: false,
        },
        {
          str: "brown fox",
          dir: "ltr",
          transform: [12, 0, 0, 12, 134, 700],
          width: 54,
          height: 12,
          fontName: "f1",
          hasEOL: false,
        },
      ],
      styles: {
        f1: { ascent: 0.75, descent: -0.25, fontFamily: "serif", vertical: false },
      },
      lang: null,
    } as never;
  }

  function emptyTextContent() {
    return { items: [], styles: {}, lang: null } as never;
  }



  function anchoredRequest(): LiveApiAnnotationRequest {
    return {
      requestId: "anchored-1",
      operationId: OPERATION_ID,
      expiresAtMs: FUTURE_EXPIRES_AT_MS,
      target: {
        documentId: "tab-a",
        sha256: "abc",
        pageTopologyHash: PAGE_TOPOLOGY_HASH,
      },
      dryRun: false,
      spec: {
        annotations: [
          { type: "highlight", anchor: { quote: "brown fox" } },
        ],
      },
    };
  }

  async function connectHarness(
    getActivePdf: () => ActiveLivePdf | null,
    now?: () => number,
    authorizeMutation: (requestId: string) => Promise<void> = async () =>
      undefined,
    dependencyOverrides: Partial<LiveAnnotationDependencies> = {},
  ) {
    let handler:
      | ((request: LiveApiAnnotationRequest) => void | Promise<void>)
      | null = null;
    const completions: LiveApiCompletion[] = [];
    const dispose = await connectLiveApiBridge(
      { getActivePdf, ...(now ? { now } : {}), ...dependencyOverrides },
      {
        listen: async (next) => {
          handler = next;
          return () => undefined;
        },
        authorizeMutation,
        complete: async (_requestId, result) => {
          completions.push(result);
        },
      },
    );
    return {
      send: async (request: LiveApiAnnotationRequest) => {
        await handler?.(request);
        return completions[completions.length - 1]!;
      },
      dispose,
    };
  }

  test("notifies receipt persistence only after an authorized commit", async () => {
    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
      completedLiveOperationIds: new Set<string>(),
    });
    const persisted: Array<{ sha256: string; operationId: string }> = [];
    const dependencyOverrides = {
      onOperationCommitted: (sha256: string, operationId: string) => {
        persisted.push({ sha256, operationId });
      },
    };
    const request = noteRequest(false);
    request.operationId = await deriveLiveOperationId(request);
    const harness = await connectHarness(
      storeAccess,
      undefined,
      async () => undefined,
      dependencyOverrides,
    );

    expect(await harness.send(request)).toMatchObject({
      ok: true,
      data: { added: 1 },
    });
    expect(persisted).toEqual([
      { sha256: "abc", operationId: request.operationId },
    ]);
    // Receipt retry and dry-run have no mutation commit to persist.
    await harness.send(request);
    const dryRun = noteRequest(true);
    (
      dryRun.spec as {
        annotations: Array<{ text: string }>;
      }
    ).annotations[0]!.text = "dry only";
    dryRun.operationId = await deriveLiveOperationId(dryRun);
    await harness.send(dryRun);
    expect(persisted).toHaveLength(1);
    harness.dispose();

    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
      completedLiveOperationIds: new Set<string>(),
    });
    const rejected = await connectHarness(
      storeAccess,
      undefined,
      async () => {
        throw new Error("authorization rejected");
      },
      dependencyOverrides,
    );
    expect(await rejected.send(request)).toMatchObject({ ok: false });
    expect(persisted).toHaveLength(1);
    rejected.dispose();
  });

  test("resolves anchors, commits, and keeps retries idempotent", async () => {
    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
      selectedIds: [],
    });
    const access = () => ({
      ...storeAccess(),
      getPageTextContent: async (page: PageModel) =>
        page.sourceIndex === 0
          ? anchorTextContent()
          : emptyTextContent(),
    });
    const harness = await connectHarness(access);
    const request = anchoredRequest();
    request.operationId = await deriveLiveOperationId(request);

    const first = await harness.send(request);
    expect(first).toMatchObject({ ok: true, data: { added: 1, dryRun: false } });
    const overlays = useEditorStore.getState().model.overlays;
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({
      type: "highlight",
      pageId: "page-a",
      rects: [{ x: 134, y: 697, w: 54, h: 12 }],
      // Anchor provenance rides along outside the spec: exact matched text,
      // resolved page, page-local occurrence.
      anchor: { quote: "brown fox", page: 1, occurrence: 1 },
    });

    // Lost-response retry: re-resolution is deterministic, so the same
    // request must re-derive identical overlays and add nothing.
    const second = await harness.send(request);
    expect(second).toMatchObject({
      ok: true,
      data: { added: 0, annotationIds: first.ok ? first.data.annotationIds : [] },
    });
    expect(useEditorStore.getState().model.overlays).toHaveLength(1);
    harness.dispose();
  });

  test("maps reordered pages through their source index", async () => {
    const reordered = [pages[1]!, pages[0]!];
    const sourceReads: number[] = [];
    let committed: Overlay[] = [];
    const access = fakeAccess({
      pages: reordered,
      getPageTextContent: async (page) => {
        sourceReads.push(page.sourceIndex);
        return page.sourceIndex === 0 ? anchorTextContent() : emptyTextContent();
      },
      commitOverlays: (overlays) => {
        committed = overlays;
      },
    });
    const harness = await connectHarness(() => access);
    const request = anchoredRequest();
    request.operationId = await deriveLiveOperationId(request);

    const result = await harness.send(request);
    expect(result).toMatchObject({ ok: true, data: { added: 1 } });
    expect(sourceReads).toEqual([1, 0]);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ pageId: "page-a" });
    harness.dispose();
  });

  test("captures one PDF and skips synthetic blank pages", async () => {
    const documentA = fakePdfDocument();
    const documentB = fakePdfDocument();
    const reads: Array<[PdfDocument, number]> = [];
    const restore = setAppPdfEngineForTest(
      fakePdfEngine({
        pageText: async (doc, sourceIndex) => {
          reads.push([doc, sourceIndex]);
          return {
            content: (doc === documentA ? anchorTextContent() : emptyTextContent()) as never,
            glyphs: null,
            fontNames: new Map(),
            faceFamilies: new Map(),
          };
        },
      }),
    );
    try {
      let activeDocument = documentA;
      const readPageText = createLivePageTextContentReader(activeDocument);
      // Simulate A -> B while resolution is awaiting later pages. The operation
      // reader must keep using the document captured when it began.
      activeDocument = documentB;
      await readPageText({ ...pages[1]!, sourceIndex: 4 });
      expect(reads).toEqual([[documentA, 4]]);

      const blank: PageModel = {
        id: "blank",
        sourceIndex: -1,
        rotation: 0,
        widthPt: 612,
        heightPt: 792,
        blank: true,
      };
      await expect(readPageText(blank)).resolves.toEqual({
        items: [],
        styles: {},
        lang: null,
      });
      expect(reads).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("reads a page's text through the engine, and passes its failure on", async () => {
    const expected = anchorTextContent();
    const extractionError = new Error("text extraction failed");
    let fail = false;
    const restore = setAppPdfEngineForTest(
      fakePdfEngine({
        pageText: async () => {
          if (fail) throw extractionError;
          return { content: expected as never, glyphs: null, fontNames: new Map(), faceFamilies: new Map() };
        },
      }),
    );
    try {
      const readPageText = createLivePageTextContentReader(fakePdfDocument());
      await expect(readPageText(pages[0]!)).resolves.toEqual(expected);
      fail = true;
      await expect(readPageText(pages[0]!)).rejects.toBe(extractionError);
    } finally {
      restore();
    }
  });

  test("rechecks the active target after asynchronous anchor resolution", async () => {
    let releaseText: (() => void) | null = null;
    const textBlocked = new Promise<void>((resolve) => {
      releaseText = resolve;
    });
    let textStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      textStarted = resolve;
    });
    let commits = 0;
    const initial = fakeAccess({
      getPageTextContent: async () => {
        textStarted?.();
        await textBlocked;
        return anchorTextContent();
      },
      commitOverlays: () => {
        commits += 1;
      },
    });
    const switched = fakeAccess({
      documentId: "tab-b",
      sha256: "def",
    });
    let active = initial;
    const harness = await connectHarness(() => active);
    const request = anchoredRequest();
    (
      request.spec as {
        annotations: Array<{ anchor: { quote: string; page?: number } }>;
      }
    ).annotations[0]!.anchor.page = 1;
    request.operationId = await deriveLiveOperationId(request);

    const resultPromise = harness.send(request);
    await started;
    active = switched;
    releaseText?.();
    const result = await resultPromise;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TARGET_CHANGED" },
    });
    expect(commits).toBe(0);
    harness.dispose();
  });

  test("rejects an event whose native deadline already expired", async () => {
    let textReads = 0;
    let commits = 0;
    const nowMs = 10_000;
    const harness = await connectHarness(
      () =>
        fakeAccess({
          getPageTextContent: async () => {
            textReads += 1;
            return anchorTextContent();
          },
          commitOverlays: () => {
            commits += 1;
          },
        }),
      () => nowMs,
    );
    const request = anchoredRequest();
    request.expiresAtMs = nowMs + LIVE_API_DEADLINE_SAFETY_MS;
    request.operationId = await deriveLiveOperationId(request);

    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_TIMEOUT" },
    });
    expect(textReads).toBe(0);
    expect(commits).toBe(0);
    harness.dispose();
  });

  test("does not mutate when the native pre-commit authorization fails", async () => {
    let commits = 0;
    const harness = await connectHarness(
      () =>
        fakeAccess({
          getPageTextContent: async () => anchorTextContent(),
          commitOverlays: () => {
            commits += 1;
          },
        }),
      undefined,
      async () => {
        throw new Error("live-api-request-expired");
      },
    );
    const request = anchoredRequest();
    (
      request.spec as {
        annotations: Array<{ anchor: { page?: number } }>;
      }
    ).annotations[0]!.anchor.page = 1;
    request.operationId = await deriveLiveOperationId(request);

    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_TIMEOUT" },
    });
    expect(commits).toBe(0);
    harness.dispose();
  });

  test("does not commit when the deadline expires while authorization is pending", async () => {
    let releaseAuthorization: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let authorizationStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    let nowMs = 1_000;
    let commits = 0;
    const access = fakeAccess({
      getPageTextContent: async () => anchorTextContent(),
      commitOverlays: () => {
        commits += 1;
      },
    });
    const harness = await connectHarness(
      () => access,
      () => nowMs,
      async () => {
        authorizationStarted?.();
        await blocked;
      },
    );
    const request = anchoredRequest();
    request.expiresAtMs = 2_000;
    (
      request.spec as {
        annotations: Array<{ anchor: { page?: number } }>;
      }
    ).annotations[0]!.anchor.page = 1;
    request.operationId = await deriveLiveOperationId(request);

    const resultPromise = harness.send(request);
    await started;
    nowMs = 2_000 - LIVE_API_DEADLINE_SAFETY_MS;
    releaseAuthorization?.();
    const result = await resultPromise;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_TIMEOUT" },
    });
    expect(commits).toBe(0);
    harness.dispose();
  });

  test("does not overwrite edits made while authorization is pending", async () => {
    let releaseAuthorization: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let authorizationStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    useEditorStore.setState({
      model: { pages, overlays: [] },
      undoStack: [],
      redoStack: [],
    });
    const access = storeAccess();
    access.getPageTextContent = async () => anchorTextContent();
    const harness = await connectHarness(
      () => access,
      undefined,
      async () => {
        authorizationStarted?.();
        await blocked;
      },
    );
    const request = anchoredRequest();
    (
      request.spec as {
        annotations: Array<{ anchor: { page?: number } }>;
      }
    ).annotations[0]!.anchor.page = 1;
    request.operationId = await deriveLiveOperationId(request);

    const resultPromise = harness.send(request);
    await started;
    const concurrent: Overlay = {
      type: "note",
      id: "concurrent-note",
      pageId: pages[0]!.id,
      rect: { x: 1, y: 2, w: 168, h: 94 },
      text: "user edit",
      color: "#f6c744",
    };
    useEditorStore.getState().commit({ overlays: [concurrent] });
    releaseAuthorization?.();
    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      error: { code: "TARGET_CHANGED" },
    });
    expect(useEditorStore.getState().model.overlays).toEqual([concurrent]);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    harness.dispose();
  });

  test("maps unknown native authorization failures to INTERNAL", async () => {
    const harness = await connectHarness(
      () =>
        fakeAccess({
          getPageTextContent: async () => anchorTextContent(),
        }),
      undefined,
      async () => {
        throw new Error("ipc transport disconnected");
      },
    );
    const request = anchoredRequest();
    (
      request.spec as {
        annotations: Array<{ anchor: { page?: number } }>;
      }
    ).annotations[0]!.anchor.page = 1;
    request.operationId = await deriveLiveOperationId(request);

    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL" },
    });
    harness.dispose();
  });

  test("does not commit when the deadline expires during anchor resolution", async () => {
    let releaseText: (() => void) | null = null;
    const textBlocked = new Promise<void>((resolve) => {
      releaseText = resolve;
    });
    let textStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      textStarted = resolve;
    });
    let nowMs = 1_000;
    let commits = 0;
    const access = fakeAccess({
      getPageTextContent: async () => {
        textStarted?.();
        await textBlocked;
        return anchorTextContent();
      },
      commitOverlays: () => {
        commits += 1;
      },
    });
    const harness = await connectHarness(() => access, () => nowMs);
    const request = anchoredRequest();
    request.expiresAtMs = 2_000;
    (
      request.spec as {
        annotations: Array<{ anchor: { quote: string; page?: number } }>;
      }
    ).annotations[0]!.anchor.page = 1;
    request.operationId = await deriveLiveOperationId(request);

    const resultPromise = harness.send(request);
    await started;
    nowMs = 2_000 - LIVE_API_DEADLINE_SAFETY_MS;
    releaseText?.();
    const result = await resultPromise;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_TIMEOUT" },
    });
    expect(commits).toBe(0);
    harness.dispose();
  });

  test("stops loading pages when the deadline expires inside anchor search", async () => {
    let nowMs = 1_000;
    let commits = 0;
    const textReads: string[] = [];
    const access = fakeAccess({
      getPageTextContent: async (page) => {
        textReads.push(page.id);
        // The resolver must check the native deadline again immediately after
        // this await, before it loads or scans another page.
        nowMs = 1_500;
        return emptyTextContent();
      },
      commitOverlays: () => {
        commits += 1;
      },
    });
    const harness = await connectHarness(() => access, () => nowMs);
    const request = anchoredRequest();
    request.expiresAtMs = 2_000;
    (
      request.spec as {
        annotations: Array<{ anchor: { quote: string } }>;
      }
    ).annotations[0]!.anchor.quote = "not present";
    request.operationId = await deriveLiveOperationId(request);

    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_TIMEOUT" },
    });
    expect(textReads).toEqual(["page-a"]);
    expect(commits).toBe(0);
    harness.dispose();
  });

  test("rejects malformed raw anchors before reading PDF text", async () => {
    let textReads = 0;
    let commits = 0;
    const harness = await connectHarness(() =>
      fakeAccess({
        getPageTextContent: async () => {
          textReads += 1;
          return anchorTextContent();
        },
        commitOverlays: () => {
          commits += 1;
        },
      }),
    );
    const invalidAnnotations: unknown[] = [
      { type: "highlight", anchor: { quote: "brown fox", page: "1" } },
      {
        type: "highlight",
        anchor: { quote: "brown fox", occurrence: 1.5 },
      },
      {
        type: "highlight",
        anchor: { quote: "brown fox" },
        rects: [{ x: 1, y: 1, w: 1, h: 1 }],
      },
      {
        type: "highlight",
        page: 1,
        anchor: { quote: "brown fox" },
      },
    ];

    for (const [index, annotation] of invalidAnnotations.entries()) {
      const request = anchoredRequest();
      request.requestId = `invalid-anchor-${index}`;
      request.spec = { annotations: [annotation] };
      request.operationId = await deriveLiveOperationId(request);
      const result = await harness.send(request);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "SPEC_INVALID" },
      });
    }
    expect(textReads).toBe(0);
    expect(commits).toBe(0);
    harness.dispose();
  });

  test("bounds raw anchor validation errors to the native response limit", async () => {
    const harness = await connectHarness(() => fakeAccess());
    const request = anchoredRequest();
    const anchor = (
      request.spec as {
        annotations: Array<{ anchor: Record<string, unknown> }>;
      }
    ).annotations[0]!.anchor;
    anchor["x".repeat(3_000)] = true;
    request.operationId = await deriveLiveOperationId(request);

    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SPEC_INVALID" },
    });
    const message = result.ok ? "" : result.error.message;
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(
      2_048,
    );
    harness.dispose();
  });

  test("reports TARGET_CHANGED when the document vanishes before resolution", async () => {
    const harness = await connectHarness(() => null);
    const request = anchoredRequest();
    request.operationId = await deriveLiveOperationId(request);
    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TARGET_CHANGED", details: { actual: null } },
    });
    harness.dispose();
  });

  test("fails anchored requests cleanly without a text accessor", async () => {
    const harness = await connectHarness(() => fakeAccess());
    const request = anchoredRequest();
    request.operationId = await deriveLiveOperationId(request);
    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SPEC_INVALID" },
    });
    harness.dispose();
  });

  test("classifies bounded text extraction failures for CLI compatibility", async () => {
    const harness = await connectHarness(() =>
      fakeAccess({
        getPageTextContent: async () => {
          throw new SemanticTextLimitError("page text exceeded the safe limit");
        },
      }),
    );
    const request = anchoredRequest();
    request.operationId = await deriveLiveOperationId(request);

    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "SPEC_INVALID",
        details: { reason: "TEXT_UNAVAILABLE" },
      },
    });
    harness.dispose();
  });

  test("surfaces unresolved quotes as SPEC_INVALID with the resolver message", async () => {
    const harness = await connectHarness(() => ({
      ...fakeAccess(),
      getPageTextContent: async () => anchorTextContent(),
    }));
    const request = anchoredRequest();
    (request.spec as { annotations: Array<{ anchor: { quote: string } }> })
      .annotations[0]!.anchor.quote = "missing text";
    request.operationId = await deriveLiveOperationId(request);
    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "SPEC_INVALID",
        details: { reason: "ANCHOR_UNRESOLVED" },
      },
    });
    if (!result.ok) {
      expect(result.error.message).toContain("was not found");
    }
    harness.dispose();
  });

  function seededCallout() {
    useEditorStore.setState({
      model: {
        pages,
        overlays: [
          {
            type: "callout",
            id: "callout-target",
            pageId: "page-a",
            targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
            rect: { x: 250, y: 620, w: 144, h: 54 },
            text: "这两个方差是怎么来的？",
            fontSize: 12,
            color: "#b13a2e",
            bold: false,
            align: "left",
            fontFamily: "sans",
          },
        ],
      },
      undoStack: [],
      redoStack: [],
      selectedIds: [],
    });
  }

  function replyRequest(spec: unknown): LiveApiAnnotationRequest {
    return {
      requestId: "reply-1",
      operationId: OPERATION_ID,
      expiresAtMs: FUTURE_EXPIRES_AT_MS,
      target: {
        documentId: "tab-a",
        sha256: "abc",
        pageTopologyHash: PAGE_TOPOLOGY_HASH,
      },
      dryRun: false,
      spec,
    };
  }

  test("appends agent turns to a callout thread and keeps retries idempotent", async () => {
    seededCallout();
    const harness = await connectHarness(storeAccess);
    const request = replyRequest({
      annotations: [
        {
          type: "calloutReply",
          replyTo: "callout-target",
          text: "它们是方差的上下界。",
          author: "Claude Code",
        },
      ],
    });
    request.operationId = await deriveLiveOperationId(request);

    const first = await harness.send(request);
    expect(first).toMatchObject({
      ok: true,
      data: {
        added: 1,
        annotationIds: ["callout-target"],
        // A reply patches an existing overlay: the count must not move.
        annotationCount: 1,
      },
    });
    const overlays = useEditorStore.getState().model.overlays;
    expect(overlays).toHaveLength(1);
    const callout = overlays[0];
    if (callout?.type !== "callout") throw new Error("missing callout");
    expect(callout.thread).toHaveLength(1);
    expect(callout.thread?.[0]).toMatchObject({
      role: "agent",
      author: "Claude Code",
      text: "它们是方差的上下界。",
    });
    // The reply the agent just wrote is visible immediately: selecting the
    // callout is what unfolds its conversation panel.
    expect(useEditorStore.getState().selectedIds).toEqual(["callout-target"]);

    // Lost-response retry: the turn id derives from the operation id, so the
    // same request finds its own turn already present and adds nothing.
    const second = await harness.send(request);
    expect(second).toMatchObject({ ok: true, data: { added: 0 } });
    const after = useEditorStore.getState().model.overlays[0];
    if (after?.type !== "callout") throw new Error("missing callout");
    expect(after.thread).toHaveLength(1);
    harness.dispose();
  });

  test("rejects replies whose target is not a callout in the open document", async () => {
    seededCallout();
    const harness = await connectHarness(storeAccess);
    const request = replyRequest({
      annotations: [
        { type: "calloutReply", replyTo: "no-such-overlay", text: "hello" },
      ],
    });
    request.operationId = await deriveLiveOperationId(request);
    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SPEC_INVALID" },
    });
    if (!result.ok) {
      expect(result.error.message).toContain("does not match a callout");
    }
    harness.dispose();
  });

  test("rejects a spec mixing calloutReply with overlay creation", async () => {
    seededCallout();
    const harness = await connectHarness(storeAccess);
    const request = replyRequest({
      annotations: [
        { type: "calloutReply", replyTo: "callout-target", text: "hi" },
        {
          type: "highlight",
          page: 1,
          rects: [{ x: 10, y: 10, w: 20, h: 10 }],
        },
      ],
    });
    request.operationId = await deriveLiveOperationId(request);
    const result = await harness.send(request);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SPEC_INVALID" },
    });
    if (!result.ok) {
      expect(result.error.message).toContain("open document only");
    }
    harness.dispose();
  });
});

function storeAccess(): ActiveLivePdf {
  const state = useEditorStore.getState();
  const expectedPages = state.model.pages;
  const expectedOverlays = state.model.overlays;
  const expectedReceipts = state.completedLiveOperationIds;
  return {
    documentId: "tab-a",
    sha256: "abc",
    pageTopologyHash: PAGE_TOPOLOGY_HASH,
    pages: state.model.pages,
    overlays: state.model.overlays,
    commitOverlays: (overlays) => useEditorStore.getState().commit({ overlays }),
    prepareOverlayCommit: (overlays, ui) => {
      if (!ui) return null;
      const current = useEditorStore.getState();
      if (
        current.model.pages !== expectedPages ||
        current.model.overlays !== expectedOverlays
      ) {
        return null;
      }
      const prepared = current.prepareCommit({ overlays });
      return () =>
        useEditorStore.getState().commitPrepared(prepared, {
          selectedIds: ui.selectedIds,
        });
    },
    hasOperationReceipt: (operationId) =>
      expectedReceipts.has(operationId),
    prepareOverlayBatchCommit: (overlays, operationId, ui) => {
      if (!ui) return null;
      const current = useEditorStore.getState();
      if (
        current.model.pages !== expectedPages ||
        current.model.overlays !== expectedOverlays ||
        current.completedLiveOperationIds !== expectedReceipts
      ) {
        return null;
      }
      const prepared = current.prepareOverlayBatchCommit(overlays, operationId);
      return () =>
        useEditorStore.getState().commitPreparedOverlayBatch(prepared, {
          selectedIds: ui.selectedIds,
        });
    },
    commitsSelectionAtomically: true,
    isCurrentSnapshot: () => {
      const current = useEditorStore.getState();
      return (
        current.model.pages === expectedPages &&
        current.model.overlays === expectedOverlays
      );
    },
    selectOverlays: (ids) => useEditorStore.setState({ selectedIds: ids }),
  };
}

function fakeAccess(
  overrides: Partial<ActiveLivePdf> = {},
): ActiveLivePdf {
  const access = {
    documentId: "tab-a",
    sha256: "abc",
    pageTopologyHash: PAGE_TOPOLOGY_HASH,
    pages,
    overlays: [],
    commitOverlays: () => undefined,
    ...overrides,
  } as ActiveLivePdf;
  access.isCurrentSnapshot ??= () => true;
  access.prepareOverlayCommit ??= (overlays) => () => {
    if (!access.isCurrentSnapshot()) return false;
    access.commitOverlays(overlays);
    return true;
  };
  return access;
}

function noteRequest(
  dryRun: boolean,
  target = {
    documentId: "tab-a",
    sha256: "abc",
    pageTopologyHash: PAGE_TOPOLOGY_HASH,
  },
): LiveApiAnnotationRequest {
  return {
    requestId: "request-1",
    operationId: OPERATION_ID,
    expiresAtMs: FUTURE_EXPIRES_AT_MS,
    target,
    dryRun,
    spec: {
      schema: "shiori.annotations/v1",
      annotations: [
        {
          type: "note",
          page: 1,
          at: { x: 20, y: 30 },
          text: "new",
          color: "#f6c744",
        },
      ],
    },
  };
}

function batchRequest(): LiveApiAnnotationRequest {
  return {
    requestId: "batch-7",
    operationId: OPERATION_ID,
    expiresAtMs: FUTURE_EXPIRES_AT_MS,
    target: {
      documentId: "tab-a",
      sha256: "abc",
      pageTopologyHash: PAGE_TOPOLOGY_HASH,
    },
    dryRun: false,
    spec: {
      schema: "shiori.annotations/v1",
      annotations: [
        {
          type: "highlight",
          page: 1,
          rects: [{ x: 10, y: 20, w: 30, h: 8 }],
          color: "#f6c744",
          opacity: 0.35,
        },
        {
          type: "note",
          page: 1,
          at: { x: 50, y: 60 },
          text: "batch",
          color: "#f6c744",
        },
        {
          type: "rect",
          page: 2,
          rect: { x: 1, y: 2, w: 30, h: 40 },
          color: "#aa3322",
          strokeWidth: 2,
          fill: null,
        },
      ],
    },
  };
}
