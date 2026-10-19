/**
 * Failure list (written before tests and implementation):
 * - R2, R3, R4 RC4, R4 AES and R6 bases lose encryption, /Encrypt, /ID[0],
 *   the original file key, source content or inserted pages.
 * - User vs owner vs empty passwords change access after insertion/export;
 *   missing/wrong passwords open a file they could not open before.
 * - R2 bit 4 / R3+ bit 11 pages permission denied is bypassed; owner is denied.
 * - Unknown security or unavailable/broken encryption leaks plaintext.
 * - Encrypted incoming pages are accepted or misreported as a base failure.
 * - Workspace reload loses the password, annotations, page identities/history,
 *   or subsequent insert/export stops using the original security handler.
 * - Autosave/restore, workspace source cache or suspended sessions persist
 *   unencrypted PDF bytes; restored history cannot undo insertion.
 * - Undo points at shifted physical pages, or exports the inserted pages anyway.
 * Review failure cases (listed before adding tests/fixes):
 * - Plain Error failures from base plaintext/encrypt/verification blame incoming.
 * - Closing the target during draft flush, imports or handler awaits produces a
 *   security error, overwrites a store, or writes plaintext to persistence.
 * - Permissions/security/cancellation coverage disappears without a native addon.
 * - A second insertion or its export loses encryption or original passwords.
 */
import "../../test/setupDom";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { openCoreDocument, resolveCoreFiles, type CoreDocument } from "../../../cli/src/coreEngine";

import { createPdfEditorStore, useEditorStore } from "../../editor/store/store";
import type { PdfDocument, PdfSecurity } from "../../pdf/engine/types";
import { withSourceEncryption, type ExportSourceEncryption } from "../../pdf/export/encryptedSource";
import { exportPdf } from "../../pdf/export/exportPdf";
import { insertPdfPages } from "../../pdf/merge/insertPdf";
import type { PageModel } from "../../pdf/model/types";
import { sha256Hex } from "../../storage/hash";


import { fakePdfEngine } from "../../test/fakePdfEngine";
import { QPDF, QpdfDocument, qpdfCheck, qpdfEncryption, qpdfRejectsPassword } from "../../test/qpdf";
import { finalizePdfOpen } from "../intake/finalizePdfOpen";
import { createWorkspaceStore } from "../workspaceStore";
import { createPageMerges, type PageMergeNotice, type PageMergePorts } from "./pageMerge";

Dexie.dependencies.indexedDB = indexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = IDBKeyRange as unknown as typeof globalThis.IDBKeyRange;
const { useDraftSync } = await import("../../editor/hooks/useDraftSync");
const { captureSuspendedPdfSnapshot, putRuntimeSession, readRuntimeSession, removeRuntimeSession } = await import("../../storage/runtimeSessions");
const { putWorkspaceSource, getWorkspaceSource, removeWorkspaceSource } = await import("../../storage/workspace");
afterEach(cleanup);

const fixture = (name: string) => new Uint8Array(readFileSync(join(
  import.meta.dir, "../../../crates/shiori-core/tests/fixtures/encrypted", `${name}.pdf`,
)));
const OWNER = "owner-pw";
// The web-only gate builds WASM, not the native addon. Build the addon first
// (test:core or the command in the artifact README) to run these real readers.
const coreTest = test.skipIf(!existsSync(resolveCoreFiles().addon));
// qpdf reads the merged exports as a reader that shares no code with the
// writer (PDFium decrypts and re-encrypts); see src/test/qpdf.ts.
const qpdfCoreTest = test.skipIf(!existsSync(resolveCoreFiles().addon) || !QPDF);
const cases: [string, string][] = [
  ["rc4-40", "user-pw"], ["rc4-128", "user-pw"], ["r4-rc4", "user-pw"],
  ["aes-128", "user-pw"], ["aes-128-nometa", "user-pw"],
  ["aes-256", "user-pw"], ["aes-256-nometa", "user-pw"],
  ["restricted", OWNER], ["empty-user", OWNER],
];

function nodeEngine() {
  const docs = new Map<PdfDocument, CoreDocument>();
  const coreOf = (doc: PdfDocument) => docs.get(doc)!;
  const security = (doc: PdfDocument): PdfSecurity | null => {
    const report = coreOf(doc).security();
    return report.revision == null ? null : {
      revision: report.revision, permissions: report.permissions >>> 0,
      userPermissions: report.userPermissions >>> 0,
    };
  };
  const engine = fakePdfEngine({
    load: async (bytes, { password }) => {
      const doc = Object.freeze({}) as PdfDocument;
      docs.set(doc, openCoreDocument(bytes, password));
      return { doc, bytes };
    },
    pageCount: (doc) => coreOf(doc).pageCount(),
    pageGeometry: async (doc) => Array.from({ length: coreOf(doc).pageCount() }, (_, i) => {
      const g = coreOf(doc).pageGeometry(i);
      return { rotation: g.rotation as 0, widthPt: g.width, heightPt: g.height, originXPt: g.originX, originYPt: g.originY };
    }),
    importAnnotations: async () => [],
    security,
    destroy: async (doc) => { if (doc) { coreOf(doc)?.close(); docs.delete(doc); } },
    openEncryptedSource: async (bytes, password) => {
      const core = openCoreDocument(bytes, password);
      const report = core.security();
      return {
        security: { revision: report.revision!, permissions: report.permissions, userPermissions: report.userPermissions },
        plaintext: async () => core.decryptedCopy(),
        encrypt: async (plain) => core.encryptLikeSource(plain),
        close: () => core.close(),
      };
    },
  });
  return { engine, coreOf };
}

async function incoming() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([250, 300]).drawText("Inserted page", { font, x: 20, y: 200 });
  return pdf.save();
}

async function expectLocked(bytes: Uint8Array, source: Uint8Array, user: string, texts: string[]) {
  const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const original = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  expect(raw.isEncrypted).toBe(true);
  const encryptDict = (pdf: PDFDocument) => pdf.context.lookup(pdf.context.trailerInfo.Encrypt).toString().replace(/<([0-9a-f]+)>/gi, value => value.toLowerCase());
  expect(encryptDict(raw)).toBe(encryptDict(original));
  expect(raw.context.trailerInfo.ID?.lookup(0).toString().toLowerCase()).toBe(original.context.trailerInfo.ID?.lookup(0).toString().toLowerCase());
  for (const password of [user, OWNER]) {
    const core = openCoreDocument(bytes, password);
    try {
      expect(core.pageCount()).toBe(texts.length);
      for (let i = 0; i < texts.length; i++) expect(core.glyphs(i).map(g => g.text).join("")).toContain(texts[i]!);
    } finally { core.close(); }
  }
  for (const password of user === "" ? ["wrong-password"] : [undefined, "wrong-password"]) {
    expect(() => openCoreDocument(bytes, password)).toThrow(/password/i);
  }
}

/** The same lock, read by qpdf: both passwords and no others, the source's handler, a clean structure. */
function expectQpdfLocked(bytes: Uint8Array, source: Uint8Array, user: string, pageCount: number) {
  for (const password of [user, OWNER]) {
    const check = qpdfCheck(bytes, password);
    expect({ code: check.code, stderr: check.stderr }).toEqual({ code: 0, stderr: "" });
    expect(qpdfEncryption(bytes, password)).toBe(qpdfEncryption(source, password));
    expect(QpdfDocument.open(bytes, password).pages()).toHaveLength(pageCount);
  }
  for (const password of user === "" ? ["wrong-password"] : [undefined, "wrong-password"]) {
    expect(qpdfRejectsPassword(bytes, password)).toBe(true);
  }
}

/** Inserts a page into fixture `name` and exports the result as the app does. */
async function insertThenExport(name: string, password: string) {
  const bytes = fixture(name);
  const { engine } = nodeEngine();
  const { doc } = await engine.load(bytes, { password });
  let merged: Uint8Array;
  try {
    merged = (await withSourceEncryption(engine, { doc, bytes, password }, encryption =>
      insertPdfPages(bytes, awaitIncoming, 1, "insert.pdf", encryption),
    )).bytes;
  } finally { await engine.destroy(doc); }
  const reopened = await engine.load(merged, { password });
  try {
    const pages: PageModel[] = (await engine.pageGeometry(reopened.doc)).map((g, sourceIndex) => ({
      ...g, sourceIndex, id: `p${sourceIndex}`, rotation: sourceIndex === 1 ? 90 : 0,
    }));
    const exported = await withSourceEncryption(engine, { doc: reopened.doc, bytes: merged, password }, sourceEncryption =>
      exportPdf(merged, { pages, overlays: [] }, { mode: "annotations", preserveSourceAnnotations: true, sourceEncryption }),
    );
    return { source: bytes, merged, exported: exported.bytes, user: name === "empty-user" ? "" : "user-pw" };
  } finally { await engine.destroy(reopened.doc); }
}

const MERGED_TEXTS = ["Secret page one", "Inserted page", "Secret page two"];

for (const [name, password] of cases) {
  coreTest(`${name}: insert then export keeps the original handler and both passwords`, async () => {
    const run = await insertThenExport(name, password);
    await expectLocked(run.merged, run.source, run.user, MERGED_TEXTS);
    await expectLocked(run.exported, run.source, run.user, MERGED_TEXTS);
  });

  qpdfCoreTest(`${name}: qpdf opens the inserted and exported files with both passwords only`, async () => {
    const run = await insertThenExport(name, password);
    expectQpdfLocked(run.merged, run.source, run.user, MERGED_TEXTS.length);
    expectQpdfLocked(run.exported, run.source, run.user, MERGED_TEXTS.length);
  });
}

const awaitIncoming = await incoming();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** Real merge/writer; fake engine controls only security and handler faults. */
async function fakeEncryptedMerge(options: {
  security?: PdfSecurity | null | (() => PdfSecurity | null);
  fault?: "plaintext" | "encrypt" | "verify";
  plaintext?: () => Promise<Uint8Array>;
  flush?: () => Promise<void>;
  password?: string;
} = {}) {
  const base = await PDFDocument.create();
  base.addPage([612, 792]); base.addPage([612, 792]);
  const plain = await base.save();
  const bytes = fixture("aes-128");
  const doc = Object.freeze({}) as PdfDocument;
  const security = options.security === undefined
    ? { revision: 4, permissions: 0xffffffff, userPermissions: 0xffffffff }
    : options.security;
  let closed = false;
  const engine = fakePdfEngine({
    pageCount: () => 2,
    security: () => {
      if (closed) throw new Error("pdf-core-closed");
      return typeof security === "function" ? security() : security;
    },
    openEncryptedSource: async () => ({
      security: typeof security === "function" ? security()! : security!,
      plaintext: options.plaintext ?? (async () => {
        if (options.fault === "plaintext") throw new Error("could not rewrite the document");
        return plain;
      }),
      encrypt: async () => {
        if (options.fault === "encrypt") throw new Error("could not encrypt the document");
        return bytes;
      },
      close: () => {},
    }),
    load: async () => { throw new Error("verification could not reopen the document"); },
    destroy: async target => { if (target === doc) closed = true; },
  });
  const editor = createPdfEditorStore();
  const pages: PageModel[] = [0, 1].map(sourceIndex => ({
    id: `p${sourceIndex}`, sourceIndex, rotation: 0, widthPt: 612, heightPt: 792,
  }));
  finalizePdfOpen({ store: editor, file: { name: "locked-base.pdf", size: bytes.length },
    hash: "original", pages, doc, bytes, source: {}, password: options.password ?? "user-pw",
    encrypted: true, animateImportedCallouts: false });
  const store = createWorkspaceStore({ tabs: [{ id: "base", kind: "pdf", title: "locked-base.pdf",
    status: "loaded", hash: "original", source: { type: "cache", id: "original-cache" } }],
    activeTabId: "base", folderPaths: [] });
  const persisted: Uint8Array[] = [];
  const recentEntries: unknown[] = [];
  const notices: PageMergeNotice[] = [];
  const ports: PageMergePorts = {
    store, engine, activeEditor: () => editor, tabEditor: () => editor,
    flushActiveDraft: options.flush ?? (async () => {}), insertPages: insertPdfPages,
    cache: { put: async entry => { persisted.push(new Uint8Array(entry.bytes)); return "new-cache"; },
      removeIfUnreferenced: async () => {} },
    recordMergedRecent: entry => { recentEntries.push(entry); return true; },
    lastPage: () => undefined, settings: () => ({ animateOverlays: false }),
    notify: notice => { notices.push(notice); },
  };
  const merges = createPageMerges(ports);
  const begin = () => merges.begin({ placement: { kind: "append" }, keepBaseFileName: true, announcePdfInsertion: true });
  const editorBefore = editor.getState();
  const worldBefore = store.getState();
  function expectUnchanged(world = worldBefore) {
    expect(editor.getState().opened).toEqual(editorBefore.opened);
    expect(editor.getState().model).toEqual(editorBefore.model);
    expect(editor.getState().undoStack).toEqual(editorBefore.undoStack);
    expect(store.getState().tabs).toEqual(world.tabs);
    expect(store.getState().session).toEqual(world.session);
    expect(persisted).toEqual([]);
    expect(recentEntries).toEqual([]);
  }
  const closeTarget = async () => {
    store.setState({ tabs: [], activeTabId: null });
    await engine.destroy(doc);
    return store.getState();
  };
  return { begin, engine, doc, bytes, plain, notices, expectUnchanged, closeTarget };
}

for (const fault of ["plaintext", "encrypt", "verify"] as const) {
  test(`base ${fault} fault identifies the base and persists no replacement bytes`, async () => {
    const run = await fakeEncryptedMerge({ fault });
    expect(await run.begin()(awaitIncoming, "incoming.pdf")).toBe(false);
    expect(run.notices).toEqual([{ kind: "insertRefused", code: "baseEncryption", name: "locked-base.pdf" }]);
    run.expectUnchanged();
  });
}

test("closing the target during draft flush cancels without a security notice or persistence", async () => {
  const started = deferred(); const flush = deferred();
  const run = await fakeEncryptedMerge({ flush: async () => { started.resolve(); await flush.promise; } });
  const merging = run.begin()(awaitIncoming, "incoming.pdf");
  await started.promise;
  const afterClose = await run.closeTarget();
  flush.resolve();
  expect(await merging).toBe(false);
  expect(run.notices).toEqual([{ kind: "targetChanged" }]);
  run.expectUnchanged(afterClose);
});

test("closing the target while base plaintext awaits takes precedence over its closed-handle fault", async () => {
  const started = deferred(); const release = deferred();
  const run = await fakeEncryptedMerge({ plaintext: async () => {
    started.resolve(); await release.promise; throw new Error("pdf-core-closed");
  } });
  const merging = run.begin()(awaitIncoming, "incoming.pdf");
  await started.promise;
  const afterClose = await run.closeTarget();
  release.resolve();
  expect(await merging).toBe(false);
  expect(run.notices).toEqual([{ kind: "targetChanged" }]);
  run.expectUnchanged(afterClose);
});

test("page permission refusals run without PDFium and leave stores/cache unchanged", async () => {
  for (const [revision, permissions, password] of [[2, 1024, "user-pw"], [3, 8, "user-pw"], [4, 4 | 32, "user-pw"], [6, 4, "user-pw"], [6, 4, ""]] as [number, number, string][]) {
    const run = await fakeEncryptedMerge({ password, security: { revision: revision!, permissions: permissions!, userPermissions: permissions! } });
    expect(await run.begin()(awaitIncoming, "incoming.pdf")).toBe(false);
    expect(run.notices).toEqual([{ kind: "insertRefused", code: "pagesPermission", name: "locked-base.pdf" }]);
    run.expectUnchanged();
  }
  // Positive permission cases reach a deliberately injected encryption fault.
  for (const [revision, permissions] of [[2, 8], [3, 1024], [6, 0xffffffff]]) {
    let written: Uint8Array | undefined;
    const run = await fakeEncryptedMerge();
    const encryption: ExportSourceEncryption = {
      security: { revision: revision!, permissions: permissions!, userPermissions: permissions! },
      plaintext: async () => run.plain,
      encrypt: async plain => { written = plain; throw new Error("injected encryption fault"); },
    };
    await expect(insertPdfPages(run.bytes, awaitIncoming, 1, "incoming.pdf", encryption))
      .rejects.toMatchObject({ name: "PdfPageInsertError", code: "baseEncryption" });
    expect((await PDFDocument.load(written!)).getPageCount()).toBe(3);
  }
});

test("unknown base security refuses without PDFium and cannot persist plaintext", async () => {
  for (const security of [null, () => { throw new Error("unknown security"); }]) {
    const run = await fakeEncryptedMerge({ security });
    expect(await run.begin()(awaitIncoming, "incoming.pdf")).toBe(false);
    expect(run.notices).toEqual([{ kind: "insertRefused", code: "baseEncryption", name: "locked-base.pdf" }]);
    run.expectUnchanged();
  }
  await expect(insertPdfPages(fixture("aes-128"), awaitIncoming, 2)).rejects.toMatchObject({ code: "baseEncryption" });
});

test("encrypted incoming refusal identifies the incoming file even for an encrypted base", async () => {
  const run = await fakeEncryptedMerge();
  expect(await run.begin()(fixture("aes-256"), "incoming-locked.pdf")).toBe(false);
  expect(run.notices).toEqual([{ kind: "insertRefused", code: "encryptedIncoming", name: "incoming-locked.pdf" }]);
  run.expectUnchanged();
});

coreTest("workspace insertion, autosave/restore, source cache, suspended session and Undo keep encrypted bytes", async () => {
  const previousGlobalEditor = useEditorStore.getState();
  const bytes = fixture("aes-128");
  const password = "user-pw";
  const { engine } = nodeEngine();
  const { doc } = await engine.load(bytes, { password });
  const editor = createPdfEditorStore();
  const pages: PageModel[] = (await engine.pageGeometry(doc)).map((g, sourceIndex) => ({ ...g, sourceIndex, id: `p${sourceIndex}` }));
  finalizePdfOpen({ store: editor, file: { name: "locked.pdf", size: bytes.length }, hash: await sha256Hex(bytes),
    pages, doc, bytes, source: {}, password, encrypted: true, animateImportedCallouts: false });
  const store = createWorkspaceStore({ tabs: [{ id: "encrypted-test", kind: "pdf", title: "locked.pdf", status: "loaded",
    hash: await sha256Hex(bytes), source: { type: "cache", id: "previous" } }], activeTabId: "encrypted-test", folderPaths: [] });
  const notices: PageMergeNotice[] = [];
  const cached: string[] = [];
  const merges = createPageMerges({
    store, engine, activeEditor: () => editor, tabEditor: () => editor, flushActiveDraft: async () => {},
    insertPages: insertPdfPages,
    cache: { put: async entry => { const id = await putWorkspaceSource({ kind: "pdf", ...entry }); cached.push(id); return id; },
      removeIfUnreferenced: removeWorkspaceSource },
    recordMergedRecent: () => true, lastPage: () => undefined, settings: () => ({ animateOverlays: false }),
    notify: n => { notices.push(n); },
  });
  const { default: drafts } = await import("../../storage/drafts");
  let hash: string | null = null;
  let hook: ReturnType<typeof renderHook> | undefined;
  try {
    expect(await merges.begin({ placement: { kind: "after", pageId: "p0" }, keepBaseFileName: true, announcePdfInsertion: true })(awaitIncoming, "insert.pdf")).toBe(true);
    expect(notices).toEqual([{ kind: "inserted", count: 1, name: "insert.pdf" }]);
    const opened = editor.getState().opened!;
    expect(opened.password).toBe(password);
    expect(opened.encrypted).toBe(true);
    expect(editor.getState().model.pages.map(p => p.sourceIndex)).toEqual([0, 2, 1]);
    const cachedSource = await getWorkspaceSource(cached[0]!);
    expect(cachedSource!.bytes).toEqual(opened.bytes);
    await expectLocked(opened.bytes, bytes, password, ["Secret page one", "Secret page two", "Inserted page"]);

    hash = store.getState().session.activeHash!;
    act(() => { useEditorStore.setState(editor.getState()); });
    hook = renderHook(() => useDraftSync(hash));
    await waitFor(async () => { expect(await drafts.get(hash!)).toBeDefined(); }, { timeout: 4000 });
    hook.unmount(); hook = undefined;
    const saved = (await drafts.get(hash))!;
    expect(saved.pdfBytes).toEqual(opened.bytes);
    const restored = await engine.load(saved.pdfBytes, { password });
    const restoreStore = createPdfEditorStore();
    finalizePdfOpen({ store: restoreStore, file: { name: saved.fileName, size: saved.fileSize }, hash,
      pages: captureSuspendedPdfSnapshot(editor).sourcePages, doc: restored.doc, bytes: saved.pdfBytes,
      source: {}, password, encrypted: true, animateImportedCallouts: false });
    restoreStore.getState().commitRestoredDraft(saved.model, saved.history ?? []);
    restoreStore.getState().undo();
    expect(restoreStore.getState().model.pages.map(p => p.sourceIndex)).toEqual([0, 1]);
    await engine.destroy(restored.doc);

    await putRuntimeSession({ tabId: "encrypted-test", bytes: opened.bytes, snapshot: captureSuspendedPdfSnapshot(editor) });
    expect((await readRuntimeSession("encrypted-test"))!.bytes).toEqual(opened.bytes);
    const exportCurrent = () => withSourceEncryption(engine, editor.getState().opened!, sourceEncryption =>
      exportPdf(editor.getState().opened!.bytes, editor.getState().model, { mode: "annotations", preserveSourceAnnotations: true, sourceEncryption }),
    );
    await expectLocked((await exportCurrent()).bytes, bytes, password, ["Secret page one", "Inserted page", "Secret page two"]);
    editor.getState().undo();
    expect(editor.getState().model.pages.map(p => p.sourceIndex)).toEqual([0, 1]);
    await expectLocked((await exportCurrent()).bytes, bytes, password, ["Secret page one", "Secret page two"]);
    expect(await merges.begin()(awaitIncoming, "again.pdf")).toBe(true);
    expect(editor.getState().opened!.password).toBe(password);
    const twiceInserted = editor.getState().opened!.bytes;
    await expectLocked(twiceInserted, bytes, password, ["Secret page one", "Secret page two", "Inserted page", "Inserted page"]);
    await expectLocked((await exportCurrent()).bytes, bytes, password, ["Secret page one", "Secret page two", "Inserted page"]);
  } finally {
    hook?.unmount();
    useEditorStore.setState(previousGlobalEditor);
    if (hash) await drafts.remove(hash);
    for (const id of cached) await removeWorkspaceSource(id);
    await removeRuntimeSession("encrypted-test");
    await engine.destroy(editor.getState().opened?.doc);
  }
});
