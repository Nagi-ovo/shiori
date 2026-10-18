import "../../test/setupDom";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import Dexie from "dexie";
import type { PdfDocument as PDFDocumentProxy } from "../../pdf/engine/types";
import type { PageModel } from "../../pdf/model/types";

// setupDom points global indexedDB at the in-memory fake but wires Dexie's
// dependency separately, so set both here.
Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

const HASH = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const page: PageModel = {
  id: "p1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 100,
  heightPt: 200,
};

function openDirtyDoc(useEditorStore: typeof import("../store/store").useEditorStore) {
  // Open a one-page doc, then commit a highlight so the model is dirty
  // relative to sourcePages — that is what makes the autosave want to write.
  act(() => {
    useEditorStore.getState().setOpened(
      {
        fileName: "sample.pdf",
        fileSize: 1234,
        doc: {} as PDFDocumentProxy,
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
      [page],
    );
  });
  act(() => {
    useEditorStore.getState().commit({
      overlays: [
        {
          type: "highlight",
          id: "h1",
          pageId: "p1",
          rects: [{ x: 0, y: 0, w: 10, h: 10 }],
          color: "#ffff00",
          opacity: 0.4,
        },
      ],
    });
  });
}

describe("useDraftSync disabled gate", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  test("suspends autosave while disabled, then writes once re-enabled", async () => {
    const { useEditorStore } = await import("../store/store");
    const { default: drafts } = await import("../../storage/drafts");
    const { useDraftSync, SAVE_DEBOUNCE_MS } = await import("./useDraftSync");
    await drafts.remove(HASH);

    openDirtyDoc(useEditorStore);
    const completedOperationId = "a".repeat(64);
    act(() => {
      useEditorStore.setState({
        completedLiveOperationIds: new Set([completedOperationId]),
      });
    });

    const view = renderHook(
      ({ disabled }) => useDraftSync(HASH, disabled),
      { initialProps: { disabled: true } },
    );

    // Past the debounce window the draft must still not exist on disk: a
    // pending restore decision is protecting the un-restored draft.
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 200));
    expect(await drafts.get(HASH)).toBeUndefined();

    // Re-enabling (user restored or chose to continue) resumes persistence.
    view.rerender({ disabled: false });
    await waitFor(
      async () => {
        expect(await drafts.get(HASH)).toBeTruthy();
      },
      { timeout: 2000 },
    );

    // The save carries the undo history: one snapshot (the pre-commit,
    // overlay-free model) so the reopened draft can step back across sessions.
    const saved = await drafts.get(HASH);
    expect(saved?.history).toHaveLength(1);
    expect(saved?.history[0]?.overlays).toEqual([]);
    expect(saved?.completedLiveOperationIds).toEqual([completedOperationId]);

    await drafts.remove(HASH);
  });

  test("full Undo removes the old draft but preserves the Live receipt ledger", async () => {
    const { useEditorStore } = await import("../store/store");
    const { default: drafts } = await import("../../storage/drafts");
    const { useDraftSync } = await import("./useDraftSync");
    await drafts.remove(HASH);
    const operationId = "a".repeat(64);
    const overlay = {
      type: "highlight" as const,
      id: `live-highlight-${operationId}-1`,
      pageId: page.id,
      rects: [{ x: 0, y: 0, w: 10, h: 10 }],
      color: "#ffff00",
      opacity: 0.4,
    };

    act(() => {
      useEditorStore.getState().setOpened(
        {
          fileName: "sample.pdf",
          fileSize: 1234,
          doc: {} as PDFDocumentProxy,
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
        [page],
      );
    });
    const view = renderHook(() => useDraftSync(HASH, false));
    act(() => {
      const prepared = useEditorStore
        .getState()
        .prepareOverlayBatchCommit([overlay], operationId);
      useEditorStore.getState().commitPreparedOverlayBatch(prepared);
    });
    await waitFor(
      async () => expect(await drafts.get(HASH)).toBeTruthy(),
      { timeout: 2000 },
    );

    act(() => useEditorStore.getState().undo());
    await waitFor(
      async () => expect(await drafts.get(HASH)).toBeUndefined(),
      { timeout: 2000 },
    );
    expect(await drafts.getLiveOperationReceipts(HASH)).toEqual([operationId]);

    view.unmount();
    await drafts.remove(HASH);
  });

  test("persists a receipt when commit and full Undo share one render batch", async () => {
    const { useEditorStore } = await import("../store/store");
    const { default: drafts } = await import("../../storage/drafts");
    const { useDraftSync } = await import("./useDraftSync");
    await drafts.remove(HASH);
    const operationId = "b".repeat(64);
    act(() => {
      useEditorStore.getState().setOpened(
        {
          fileName: "sample.pdf",
          fileSize: 1234,
          doc: {} as PDFDocumentProxy,
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
        [page],
      );
    });
    const view = renderHook(() => useDraftSync(HASH, false));
    act(() => {
      const prepared = useEditorStore.getState().prepareOverlayBatchCommit(
        [
          {
            type: "rect",
            id: `live-rect-${operationId}-1`,
            pageId: page.id,
            rect: { x: 1, y: 2, w: 10, h: 12 },
            color: "#ff0000",
            strokeWidth: 1,
            fill: null,
          },
        ],
        operationId,
      );
      useEditorStore.getState().commitPreparedOverlayBatch(prepared);
      useEditorStore.getState().undo();
    });

    await waitFor(
      async () =>
        expect(await drafts.getLiveOperationReceipts(HASH)).toEqual([
          operationId,
        ]),
      { timeout: 2000 },
    );
    expect(await drafts.get(HASH)).toBeUndefined();
    view.unmount();
    await drafts.remove(HASH);
  });

  test("strict flush rejects when the durable draft write fails", async () => {
    const { useEditorStore } = await import("../store/store");
    const { default: drafts } = await import("../../storage/drafts");
    const { useDraftSync } = await import("./useDraftSync");
    const originalPut = drafts.put;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    drafts.put = async () => {
      throw new Error("simulated-write-failure");
    };

    try {
      openDirtyDoc(useEditorStore);
      const view = renderHook(() => useDraftSync(HASH, false));
      let failure: unknown;
      await act(async () => {
        try {
          await view.result.current.flushNowOrThrow();
        } catch (err) {
          failure = err;
        }
      });

      expect(failure).toBeInstanceOf(Error);
      expect(view.result.current.status).toBe("error");
      expect(view.result.current.error).toBe("simulated-write-failure");
      view.unmount();
    } finally {
      consoleError.mockRestore();
      drafts.put = originalPut;
      await drafts.remove(HASH);
    }
  });

  test("strict flush serializes writes and drains an edit made mid-save", async () => {
    const { useEditorStore } = await import("../store/store");
    const { default: drafts } = await import("../../storage/drafts");
    const { useDraftSync } = await import("./useDraftSync");
    await drafts.remove(HASH);

    const originalPut = drafts.put;
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let putCalls = 0;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    drafts.put = async (incoming) => {
      putCalls += 1;
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      try {
        if (putCalls === 1) await firstWriteGate;
        await originalPut(incoming);
      } finally {
        activeWrites -= 1;
      }
    };

    try {
      openDirtyDoc(useEditorStore);
      const view = renderHook(() => useDraftSync(HASH, false));
      let strictFlush!: Promise<void>;
      act(() => {
        strictFlush = view.result.current.flushNowOrThrow();
      });
      await waitFor(() => expect(putCalls).toBe(1));

      act(() => {
        const current = useEditorStore.getState().model;
        useEditorStore.getState().commit({
          overlays: [
            ...current.overlays,
            {
              type: "highlight",
              id: "h2",
              pageId: "p1",
              rects: [{ x: 12, y: 0, w: 10, h: 10 }],
              color: "#00ffff",
              opacity: 0.4,
            },
          ],
        });
      });
      releaseFirstWrite();
      await act(async () => {
        await strictFlush;
      });

      expect(putCalls).toBe(2);
      expect(maxActiveWrites).toBe(1);
      expect((await drafts.get(HASH))?.model.overlays.map((item) => item.id)).toEqual([
        "h1",
        "h2",
      ]);
      view.unmount();
    } finally {
      releaseFirstWrite();
      drafts.put = originalPut;
      await drafts.remove(HASH);
    }
  });
});
