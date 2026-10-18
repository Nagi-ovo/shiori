import { describe, expect, spyOn, test } from "bun:test";
import Dexie, { type Table } from "dexie";
import { PDFDocument } from "pdf-lib";
import { exportPdf } from "../pdf/export/exportPdf";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import type { DocumentModel, PageModel } from "../pdf/model/types";
import { createPdfEditorStore } from "../editor/store/store";
import { planPhysicalAppendInsertion } from "../editor/pdfMergeState";
import { insertPdfPages } from "../pdf/merge/insertPdf";
import type { Draft } from "./drafts";

const TEST_CAP_BYTES = 2 * 1024;

const globals = globalThis as typeof globalThis & {
  indexedDB: IDBFactory;
  IDBKeyRange: typeof IDBKeyRange;
};
globals.indexedDB = fakeIndexedDB as unknown as IDBFactory;
globals.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;

describe("draft storage", () => {
  test("migrates v1 rows, keeps PDF bytes stable, and evicts by LRU pressure", async () => {
    await deleteDatabase("shiori");
    const legacyRow = makeDraft("hash-a", "legacy.pdf", new Uint8Array([1, 2, 3]), 10);
    const legacy = new Dexie("shiori");
    legacy.version(1).stores({ drafts: "id, lastTouched" });
    await legacy.table("drafts").put(legacyRow);
    legacy.close();

    const { default: drafts, __draftsTest } = await import("./drafts");
    const restored = await drafts.get("hash-a");
    expect(restored?.fileName).toBe("legacy.pdf");
    expect(Array.from(restored?.pdfBytes ?? [])).toEqual([1, 2, 3]);
    expect(restored?.model.pages[0]?.sourceIndex).toBe(0);
    expect(restored?.model.overlays[0]?.type).toBe("highlight");
    expect(await __draftsTest.counts()).toEqual({
      legacy: 1,
      blobs: 1,
      models: 1,
      receipts: 0,
    });

    await drafts.put({
      ...makeDraft("hash-a", "legacy-renamed.pdf", new Uint8Array([9, 9, 9]), 20),
      createdAt: restored?.createdAt,
    });
    const afterSecondSave = await drafts.get("hash-a");
    expect(afterSecondSave?.fileName).toBe("legacy-renamed.pdf");
    expect(Array.from(afterSecondSave?.pdfBytes ?? [])).toEqual([1, 2, 3]);
    expect(await drafts.totalBytes()).toBeLessThan(1024 * 1024);

    await __draftsTest.reset();

    __draftsTest.setQuotaCapBytes(TEST_CAP_BYTES);
    try {
      const largeBytes = new Uint8Array(Math.floor(TEST_CAP_BYTES / 2));
      await drafts.put(makeDraft("big-old", "old.pdf", largeBytes, 30));
      await drafts.put(makeDraft("big-new", "new.pdf", largeBytes, 40));
      const ids = (await drafts.list()).map((d) => d.id);
      expect(ids).toEqual(["big-new"]);
      expect(await drafts.totalBytes()).toBeLessThanOrEqual(TEST_CAP_BYTES);
    } finally {
      __draftsTest.setQuotaCapBytes(undefined);
    }
  });

  test("restored draft exports original bytes after all added overlays are deleted", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const original = await makeOnePagePdf();
    const draftModel = restoredDraftModel();

    await drafts.put({
      id: "restored-delete-all",
      fileName: "restore.pdf",
      fileSize: original.byteLength,
      pdfBytes: original,
      model: draftModel,
      createdAt: 1,
      lastTouched: 2,
    });

    const restored = await drafts.get("restored-delete-all");
    expect(restored?.model.overlays).toHaveLength(3);

    const { bytes: exported } = await exportPdf(
      restored!.pdfBytes,
      { pages: restored!.model.pages, overlays: [] },
      { mode: "annotations" },
    );
    expect(exported).toEqual(original);
  });

  test("notifies subscribers when stored draft usage changes", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    let changes = 0;
    const unsubscribe = drafts.subscribe(() => {
      changes += 1;
    });

    await drafts.put(makeDraft("notify", "notify.pdf", new Uint8Array([1, 2, 3]), 1));
    await drafts.remove("notify");
    unsubscribe();
    await drafts.put(makeDraft("after-unsubscribe", "after.pdf", new Uint8Array([4]), 2));

    expect(changes).toBe(2);
  });

  test("clean-baseline deletion preserves a newer cross-tab draft", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const firstVersion = await drafts.put(
      makeDraft("shared-source", "paper.pdf", new Uint8Array([1, 2, 3]), 10),
    );
    expect(
      await drafts.removeDraftPreservingLiveOperationReceiptsIfVersion(
        "shared-source",
        null,
      ),
    ).toBe(false);
    const secondVersion = await drafts.put(
      makeDraft("shared-source", "paper.pdf", new Uint8Array([1, 2, 3]), 20),
    );

    expect(
      await drafts.removeDraftPreservingLiveOperationReceiptsIfVersion(
        "shared-source",
        firstVersion,
      ),
    ).toBe(false);
    expect((await drafts.get("shared-source"))?.lastTouched).toBe(20);

    expect(
      await drafts.removeDraftPreservingLiveOperationReceiptsIfVersion(
        "shared-source",
        secondVersion,
      ),
    ).toBe(true);
    expect(await drafts.get("shared-source")).toBeUndefined();
  });

  test("records eviction notices and clears them on dismiss", async () => {
    const { __draftsTest, getEvictionNotices, clearEvictionNotices } =
      await import("./drafts");
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    try {
      expect(getEvictionNotices()).toEqual([]);
      __draftsTest.recordEvictions(["old-a.pdf", "old-b.pdf"], 1000);
      const notices = getEvictionNotices();
      expect(notices.map((n) => n.fileName)).toEqual(["old-a.pdf", "old-b.pdf"]);
      expect(notices[0]?.evictedAt).toBe(1000);
      clearEvictionNotices();
      expect(getEvictionNotices()).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  test("evicting a migrated draft also clears its legacy row", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    // Simulate a draft migrated from v1: present in the new tables AND still
    // carrying the kept-for-safety legacy row.
    const seed = makeDraft("legacy-evict", "old.pdf", new Uint8Array([1, 2, 3]), 10);
    await __draftsTest.putLegacyRow(seed);
    await drafts.put(seed);
    expect((await __draftsTest.counts()).legacy).toBe(1);

    __draftsTest.setQuotaCapBytes(TEST_CAP_BYTES);
    try {
      // A larger, newer draft forces the older migrated one out.
      await drafts.put(
        makeDraft("fresh", "fresh.pdf", new Uint8Array(TEST_CAP_BYTES * 2), 99),
      );
      // The evicted draft must be gone everywhere — not resurrectable via the
      // legacy fallback in get().
      expect(await drafts.get("legacy-evict")).toBeUndefined();
      expect((await __draftsTest.counts()).legacy).toBe(0);
    } finally {
      __draftsTest.setQuotaCapBytes(undefined);
    }
  });

  test("round-trips undo history and reads [] from pre-history records", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();

    const history = [sampleModel("step-1"), sampleModel("step-2")];
    await drafts.put({
      ...makeDraft("with-history", "history.pdf", new Uint8Array([1]), 10),
      history,
    });
    const restored = await drafts.get("with-history");
    expect(restored?.history.map((m) => m.pages[0]?.id)).toEqual([
      "step-1-page",
      "step-2-page",
    ]);

    // Records saved before history persistence (no `history` prop at all)
    // must read back as an empty array, not undefined.
    const models = (__draftsTest.db as Dexie).table("draftModels");
    await models.update("with-history", { history: undefined });
    const legacyShape = await drafts.get("with-history");
    expect(legacyShape?.history).toEqual([]);

    // Corrupted entries are filtered instead of crashing the restore path.
    await models.update("with-history", {
      history: [sampleModel("ok"), null, { pages: "nope" }, 42],
    });
    const sanitized = await drafts.get("with-history");
    expect(sanitized?.history.map((m) => m.pages[0]?.id)).toEqual(["ok-page"]);
  });

  test("does not resurrect a physically appended page after reopen and continuous Undo", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();

    const basePdf = await PDFDocument.create();
    basePdf.addPage([300, 400]);
    basePdf.addPage([400, 500]);
    const baseBytes = await basePdf.save();
    const incomingPdf = await PDFDocument.create();
    incomingPdf.addPage([200, 300]);
    const insertion = await insertPdfPages(
      baseBytes,
      await incomingPdf.save(),
      2,
      "inserted.pdf",
    );
    const mergedPdf = await PDFDocument.load(insertion.bytes);

    // Production physically appends C so every old sourceIndex remains valid,
    // then presents it logically between A and B.
    expect(mergedPdf.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([
      300,
      400,
      200,
    ]);
    const basePages = [
      draftPage("page-a", 0, 300, 400),
      draftPage("page-b", 1, 400, 500),
    ];
    const insertionPlan = planPhysicalAppendInsertion({
      previousPages: basePages,
      outputGeometry: mergedPdf.getPages().map((pdfPage) => {
        const crop = pdfPage.getCropBox();
        return {
          rotation: 0,
          originXPt: crop.x,
          originYPt: crop.y,
          widthPt: crop.width,
          heightPt: crop.height,
        };
      }),
      basePhysicalPageCount: 2,
      insertionIndex: 1,
      insertedPageCount: insertion.insertedPageCount,
      createId: () => "page-c",
    });
    const writer = createPdfEditorStore();
    writer.getState().setOpened(
      {
        fileName: "paper.pdf",
        fileSize: baseBytes.byteLength,
        doc: {} as never,
        bytes: baseBytes,
      },
      basePages,
    );
    const beforeInsertion = writer.getState().model;
    writer.getState().setOpened(
      {
        fileName: "paper.pdf",
        fileSize: insertion.bytes.byteLength,
        doc: {} as never,
        bytes: insertion.bytes,
      },
      insertionPlan.sourcePages,
      beforeInsertion,
      { preserveHistory: true },
    );
    writer.getState().commit({ pages: insertionPlan.pages });
    expect(writer.getState().model.pages.map((item) => item.id)).toEqual([
      "page-a",
      "page-c",
      "page-b",
    ]);

    const id = "1".repeat(64);
    await drafts.put({
      id,
      fileName: "paper.pdf",
      fileSize: insertion.bytes.byteLength,
      pdfBytes: insertion.bytes,
      model: writer.getState().model,
      history: writer.getState().undoStack,
      lastTouched: 10,
    });
    writer.getState().closeDocument();

    const persisted = await drafts.get(id);
    expect(persisted?.history).toHaveLength(1);
    expect(persisted).toBeDefined();
    const reopenedPdf = await PDFDocument.load(persisted!.pdfBytes);
    const reopened = createPdfEditorStore();
    const freshPhysicalPages = reopenedPdf.getPages().map((pdfPage, sourceIndex) => {
      const crop = pdfPage.getCropBox();
      return {
        id: `fresh-${sourceIndex}`,
        sourceIndex,
        rotation: 0 as const,
        originXPt: crop.x,
        originYPt: crop.y,
        widthPt: crop.width,
        heightPt: crop.height,
      };
    });
    reopened.getState().setOpened(
      {
        fileName: "paper.pdf",
        fileSize: persisted!.pdfBytes.byteLength,
        doc: {} as never,
        bytes: persisted!.pdfBytes,
      },
      freshPhysicalPages,
    );
    reopened.getState().commitRestoredDraft(
      persisted!.model,
      persisted!.history,
    );

    reopened.getState().undo();
    expect(reopened.getState().model.pages.map((item) => item.id)).toEqual([
      "page-a",
      "page-b",
    ]);
    expect(reopened.getState().undoStack).toHaveLength(0);
    const fullyUndone = reopened.getState().model;
    reopened.getState().undo();
    reopened.getState().undo();
    expect(reopened.getState().model).toBe(fullyUndone);
    expect(reopened.getState().model.pages.map((item) => item.sourceIndex)).toEqual([
      0,
      1,
    ]);
  });

  test("round-trips and sanitizes completed Live operation receipts", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const operationA = "a".repeat(64);
    const operationB = "b".repeat(64);
    await drafts.put({
      ...makeDraft("with-receipts", "receipts.pdf", new Uint8Array([1]), 10),
      completedLiveOperationIds: [operationA, operationB, operationA],
    });

    expect((await drafts.get("with-receipts"))?.completedLiveOperationIds).toEqual(
      [operationA, operationB],
    );

    const models = (__draftsTest.db as Dexie).table("draftModels");
    await models.update("with-receipts", {
      completedLiveOperationIds: [operationA, "invalid", 42, operationA],
    });
    expect((await drafts.get("with-receipts"))?.completedLiveOperationIds).toEqual(
      [operationA],
    );
  });

  test("keeps Live receipts outside draft recovery and applies explicit cleanup", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const hash = "1".repeat(64);
    const operationA = "a".repeat(64);
    const operationB = "b".repeat(64);

    await drafts.putLiveOperationReceipt(hash, operationA);
    await drafts.mergeLiveOperationReceipts(hash, [operationB, operationA]);
    expect(await drafts.get(hash)).toBeUndefined();
    expect(await drafts.getLiveOperationReceipts(hash)).toEqual([
      operationA,
      operationB,
    ]);

    await drafts.removeDraftPreservingLiveOperationReceipts(hash);
    expect(await drafts.getLiveOperationReceipts(hash)).toEqual([
      operationA,
      operationB,
    ]);
    await drafts.remove(hash);
    expect(await drafts.getLiveOperationReceipts(hash)).toEqual([]);
  });

  test("strictly validates and globally bounds the Live receipt ledger", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const firstHash = "1".repeat(64);
    const secondHash = "2".repeat(64);
    const operationId = "a".repeat(64);

    await expect(
      drafts.putLiveOperationReceipt("not-a-hash", operationId),
    ).rejects.toThrow(/PDF hash/);
    await expect(
      drafts.putLiveOperationReceipt(firstHash, "A".repeat(64)),
    ).rejects.toThrow(/operation id/);

    // One compact row fits; adding a protected second row evicts the oldest.
    __draftsTest.setLedgerCapBytes(400);
    try {
      await drafts.putLiveOperationReceipt(firstHash, operationId);
      await drafts.putLiveOperationReceipt(secondHash, "b".repeat(64));
      expect(await drafts.getLiveOperationReceipts(firstHash)).toEqual([]);
      expect(await drafts.getLiveOperationReceipts(secondHash)).toEqual([
        "b".repeat(64),
      ]);
      const receiptTable = (__draftsTest.db as Dexie).table(
        "liveOperationReceipts",
      );
      await receiptTable.update(secondHash, {
        operationIds: ["b".repeat(64), "invalid", 42],
      });
      expect(await drafts.getLiveOperationReceipts(secondHash)).toEqual([
        "b".repeat(64),
      ]);
    } finally {
      __draftsTest.setLedgerCapBytes(undefined);
    }
  });

  test("rejects tagged and geometrically invalid history before Undo", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const seed = makeDraft(
      "malicious-history",
      "malicious.pdf",
      new Uint8Array([1]),
      10,
    );
    await drafts.put(seed);
    const models = (__draftsTest.db as Dexie).table("draftModels");
    const valid = sampleModel("valid");
    const duplicateOverlayModel = sampleModel("duplicates");
    duplicateOverlayModel.overlays.push({
      ...duplicateOverlayModel.overlays[0]!,
    });
    await models.update(seed.id, {
      history: [
        valid,
        { kind: "overlay-batch", pages: [], overlays: [] },
        {
          pages: valid.pages,
          overlays: [
            {
              ...valid.overlays[0],
              rects: [{ x: 0, y: 0, w: Number.NaN, h: 10 }],
            },
          ],
        },
        duplicateOverlayModel,
      ],
    });

    expect((await drafts.get(seed.id))?.history).toEqual([valid]);
  });

  test("round-trips compact Live batch history without snapshot expansion", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();
    const pageId = "batch-page";
    const operationId = "d".repeat(64);
    const batch = {
      kind: "overlay-batch" as const,
      operationId,
      cursor: 1,
      overlays: [
        {
          type: "note" as const,
          id: `live-note-${operationId}-1`,
          pageId,
          rect: { x: 10, y: 20, w: 168, h: 94 },
          text: "first",
          color: "#f6c744",
        },
        {
          type: "note" as const,
          id: `live-note-${operationId}-2`,
          pageId,
          rect: { x: 30, y: 40, w: 168, h: 94 },
          text: "second",
          color: "#f6c744",
        },
      ],
    };
    await drafts.put({
      ...makeDraft("batch-history", "batch.pdf", new Uint8Array([1]), 10),
      history: [batch],
    });

    expect((await drafts.get("batch-history"))?.history).toEqual([batch]);
  });

  test("keeps only the newest HISTORY_MAX_STEPS snapshots", async () => {
    const { default: drafts, __draftsTest, HISTORY_MAX_STEPS } =
      await import("./drafts");
    await __draftsTest.reset();

    const history = Array.from({ length: HISTORY_MAX_STEPS + 10 }, (_, i) =>
      sampleModel(`step-${i}`),
    );
    await drafts.put({
      ...makeDraft("deep-history", "deep.pdf", new Uint8Array([1]), 10),
      history,
    });
    const restored = await drafts.get("deep-history");
    expect(restored?.history).toHaveLength(HISTORY_MAX_STEPS);
    // Oldest steps fall off; order stays oldest-first.
    expect(restored?.history[0]?.pages[0]?.id).toBe("step-10-page");
    expect(restored?.history.at(-1)?.pages[0]?.id).toBe(
      `step-${HISTORY_MAX_STEPS + 9}-page`,
    );
  });

  test("byte guard drops oldest snapshots and history counts toward quota", async () => {
    const { default: drafts, __draftsTest, HISTORY_MAX_BYTES } =
      await import("./drafts");
    await __draftsTest.reset();

    // Each snapshot ~40% of the byte cap → only the newest two fit.
    const bigSnapshot = (seed: string): DocumentModel => {
      const model = sampleModel(seed);
      return {
        ...model,
        overlays: [
          {
            id: `${seed}-text`,
            type: "text",
            pageId: model.pages[0]!.id,
            rect: { x: 0, y: 0, w: 100, h: 20 },
            text: "x".repeat(Math.floor(HISTORY_MAX_BYTES * 0.4)),
            fontSize: 16,
            color: "#000000",
            bold: false,
            align: "left",
            fontFamily: "sans",
          },
        ],
      };
    };
    const baseline = makeDraft("fat-history", "fat.pdf", new Uint8Array([1]), 10);
    await drafts.put(baseline);
    const withoutHistory = await drafts.totalBytes();

    await drafts.put({
      ...baseline,
      history: [bigSnapshot("old"), bigSnapshot("mid"), bigSnapshot("new")],
    });
    const restored = await drafts.get("fat-history");
    expect(restored?.history.map((m) => m.pages[0]?.id)).toEqual([
      "mid-page",
      "new-page",
    ]);
    // storageBytes must grow by roughly the kept snapshots' serialized size,
    // so LRU quota pressure sees the real footprint.
    const withHistory = await drafts.totalBytes();
    expect(withHistory - withoutHistory).toBeGreaterThan(HISTORY_MAX_BYTES * 0.7);
  });

  test("classifies a Dexie-wrapped quota error and retries after eviction", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();

    // Size the cap so old + new fit together (the regular post-write sweep
    // would evict nothing) but the evict-to-80% retry target forces the old
    // draft out: eviction can then only be explained by the quota-retry path.
    const oldDraft = makeDraft("quota-old", "old.pdf", new Uint8Array(400), 10);
    await drafts.put(oldDraft);
    const oldStorage = await drafts.totalBytes();
    const newDraft = makeDraft("quota-new", "new.pdf", new Uint8Array(64), 20);
    __draftsTest.setQuotaCapBytes(oldStorage + estimateStorageBytes(newDraft) + 64);

    const writes = failDraftModelPuts(__draftsTest.db, [dexieWrappedQuotaError()]);
    try {
      await drafts.put(newDraft);
    } finally {
      writes.restore();
      __draftsTest.setQuotaCapBytes(undefined);
    }

    // First write failed, eviction made room, retry succeeded.
    expect(writes.calls()).toBe(2);
    expect((await drafts.list()).map((d) => d.id)).toEqual(["quota-new"]);
  });

  test("evicts on a quota failure even when the app cap is nowhere near hit", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();

    // The real-world shape of this bug: the browser rejects the write because
    // the ORIGIN is out of room, while Shiori's own 1 GB cap is nowhere near
    // reached. The old retry target was 0.8 * appCap - incoming, so
    // enforceQuota saw total <= target, freed nothing, and the retry hit the
    // same wall — autosave then failed permanently.
    const oldDraft = makeDraft("roomy-old", "old.pdf", new Uint8Array(400), 10);
    await drafts.put(oldDraft);
    // Cap far above anything stored: the app cap can explain no eviction.
    __draftsTest.setQuotaCapBytes(50_000_000);

    const newDraft = makeDraft("roomy-new", "new.pdf", new Uint8Array(64), 20);
    const writes = failDraftModelPuts(__draftsTest.db, [
      dexieWrappedQuotaError(),
    ]);
    try {
      await drafts.put(newDraft);
    } finally {
      writes.restore();
      __draftsTest.setQuotaCapBytes(undefined);
    }

    expect(writes.calls()).toBe(2);
    // The progress floor forced the LRU sweep to actually free something.
    expect((await drafts.list()).map((d) => d.id)).toEqual(["roomy-new"]);
  });

  test("surfaces kind 'quota' when the retry after eviction also fails", async () => {
    const { default: drafts, __draftsTest, DraftSaveError } = await import("./drafts");
    await __draftsTest.reset();

    // Second failure mimics Dexie aborting the retried transaction: the
    // wrapper itself is an AbortError carrying the quota DOMException on
    // `.inner`, so only walking the chain classifies it correctly.
    const writes = failDraftModelPuts(__draftsTest.db, [
      dexieWrappedQuotaError(),
      abortWrappedQuotaError(),
    ]);
    let caught: unknown;
    try {
      await drafts.put(makeDraft("quota-full", "full.pdf", new Uint8Array(64), 30));
    } catch (err) {
      caught = err;
    } finally {
      writes.restore();
    }

    expect(writes.calls()).toBe(2);
    expect(caught).toBeInstanceOf(DraftSaveError);
    expect((caught as InstanceType<typeof DraftSaveError>).kind).toBe("quota");
  });

  test("reports success when the post-write quota sweep fails", async () => {
    const { default: drafts, __draftsTest } = await import("./drafts");
    await __draftsTest.reset();

    const table = (__draftsTest.db as Dexie & { draftModels: Table<unknown, unknown> })
      .draftModels;
    type OrderByFn = (typeof table)["orderBy"];
    // The sweep is the only orderBy user inside put(); failing it leaves the
    // already-committed write untouched.
    (table as { orderBy: OrderByFn }).orderBy = (() => {
      throw new Error("simulated sweep failure");
    }) as OrderByFn;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let changes = 0;
    const unsubscribe = drafts.subscribe(() => {
      changes += 1;
    });
    try {
      await drafts.put(makeDraft("sweep-fail", "sweep.pdf", new Uint8Array([5, 6]), 40));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      delete (table as { orderBy?: OrderByFn }).orderBy;
      unsubscribe();
      warn.mockRestore();
    }

    // The draft row was durably written before the sweep blew up:
    // put() resolves, subscribers are notified, and the data is readable.
    expect(changes).toBe(1);
    expect((await drafts.get("sweep-fail"))?.fileName).toBe("sweep.pdf");
  });
});

function makeDraft(
  id: string,
  fileName: string,
  pdfBytes: Uint8Array,
  lastTouched: number,
): Draft {
  return {
    id,
    fileName,
    fileSize: pdfBytes.byteLength,
    pdfBytes,
    model: sampleModel(id),
    history: [],
    completedLiveOperationIds: [],
    createdAt: 1,
    lastTouched,
  };
}

function sampleModel(seed: string): DocumentModel {
  const pageId = `${seed}-page`;
  return {
    pages: [
      {
        id: pageId,
        sourceIndex: 0,
        rotation: 0,
        widthPt: 612,
        heightPt: 792,
      },
    ],
    overlays: [
      {
        id: `${seed}-highlight`,
        type: "highlight",
        pageId,
        rects: [{ x: 10, y: 20, w: 30, h: 12 }],
        color: "#f4d674",
        opacity: 0.4,
      },
    ],
  };
}

function draftPage(
  id: string,
  sourceIndex: number,
  widthPt: number,
  heightPt: number,
): PageModel {
  return { id, sourceIndex, rotation: 0, widthPt, heightPt };
}

async function makeOnePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

function restoredDraftModel(): DocumentModel {
  const pageId = "restored-page";
  return {
    pages: [
      {
        id: pageId,
        sourceIndex: 0,
        rotation: 0,
        widthPt: 612,
        heightPt: 792,
      },
    ],
    overlays: [
      {
        id: "restored-note",
        type: "note",
        pageId,
        rect: { x: 72, y: 650, w: 168, h: 94 },
        text: "临时便签",
        color: "#f7e9a8",
      },
      {
        id: "restored-text",
        type: "text",
        pageId,
        rect: { x: 72, y: 580, w: 220, h: 50 },
        text: "临时文字",
        fontSize: 16,
        color: "#1a1815",
        bold: false,
        align: "left",
        fontFamily: "sans",
      },
      {
        id: "restored-ink",
        type: "ink",
        pageId,
        paths: [[{ x: 72, y: 520 }, { x: 120, y: 535 }, { x: 160, y: 515 }]],
        color: "#b13a2e",
        width: 2,
      },
    ],
  };
}

// Mirrors estimateDraftStorage() in drafts.ts: pdf bytes + model JSON + 512.
function estimateStorageBytes(draft: Draft): number {
  return (
    draft.pdfBytes.byteLength +
    new TextEncoder().encode(JSON.stringify(draft.model)).byteLength +
    512
  );
}

// Shape of Dexie's DexieError wrap: a plain Error subclass (NOT a
// DOMException) that preserves the original name and exposes the original
// DOMException on `.inner`.
function dexieWrappedQuotaError(): Error {
  const inner = new DOMException("The quota has been exceeded.", "QuotaExceededError");
  const wrapped = new Error(inner.message);
  wrapped.name = "QuotaExceededError";
  (wrapped as Error & { inner?: unknown }).inner = inner;
  return wrapped;
}

function abortWrappedQuotaError(): Error {
  const inner = new DOMException("The quota has been exceeded.", "QuotaExceededError");
  const wrapped = new Error(`AbortError ${inner.message}`);
  wrapped.name = "AbortError";
  (wrapped as Error & { inner?: unknown }).inner = inner;
  return wrapped;
}

// Patch draftModels.put on the live db so each queued error fails one write
// attempt (the transaction aborts and surfaces it, like a real quota failure),
// while eviction deletes keep working.
function failDraftModelPuts(
  db: Dexie,
  failures: Error[],
): { calls: () => number; restore: () => void } {
  // Patch the table instance hanging off the db object itself — that is the
  // one drafts.ts uses; db.table() returns a distinct _allTables instance.
  const table = (db as Dexie & { draftModels: Table<unknown, unknown> }).draftModels;
  type PutFn = (typeof table)["put"];
  const originalPut: PutFn = table.put.bind(table);
  let calls = 0;
  (table as { put: PutFn }).put = ((...args: Parameters<PutFn>) => {
    calls += 1;
    const failure = failures.shift();
    if (failure) throw failure;
    return originalPut(...args);
  }) as PutFn;
  return {
    calls: () => calls,
    restore: () => {
      // Instance assignment shadowed the prototype method; delete restores it.
      delete (table as { put?: PutFn }).put;
    },
  };
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`Blocked deleting ${name}`));
  });
}

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
