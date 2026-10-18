import { nanoid } from "nanoid";
import { exportSnapshotKey } from "../../editor/export/exportStatus";
import {
  bindPageMergeIntent,
  captureMergeTarget,
  finishPdfMerge,
  mergeStillOwnsTarget,
} from "../../editor/pdfMergeOwnership";
import {
  assertPdfMergeInputWithinFileLimit,
  planPhysicalAppendInsertion,
} from "../../editor/pdfMergeState";
import type { PdfEditorStoreApi } from "../../editor/store/store";
import type { PdfDocument, PdfEngine } from "../../pdf/engine/types";
import type { DocumentModel } from "../../pdf/model/types";
import {
  assertPdfPageDimensionsWithinLimit,
  assertPdfWithinFileLimit,
  assertPdfWithinPageLimit,
} from "../../pdf/openPolicy";
import { createSerialQueue } from "../../shared/serialQueue";
import { sha256Hex } from "../../storage/hash";
import { finalizePdfOpen } from "../intake/finalizePdfOpen";
import { pdfViewFromStore } from "../pdfView";
import type { WorkspaceStore } from "../workspaceStore";

export type PageMergeRequest = {
  placement: { kind: "append" } | { kind: "after"; pageId: string };
  keepBaseFileName: boolean;
  /** Say so when pages land, or when the target moved away (the picker). */
  announcePdfInsertion: boolean;
};

export type BoundPageMerge = (
  incomingBytes: Uint8Array,
  incomingName: string,
) => Promise<boolean>;

export type PageInsertErrorCode =
  | "encryptedIncoming"
  | "baseEncryption"
  | "pagesPermission"
  | "interactive"
  | "navigation"
  | "empty"
  | "invalidPosition"
  | "documentFiles"
  | "baseDocumentFiles"
  | "baseSigned";

export type PageMergeNotice =
  | { kind: "targetChanged" }
  | { kind: "targetMissing" }
  | { kind: "recentsSaveFailed" }
  | { kind: "inserted"; count: number; name: string }
  | { kind: "insertRefused"; code: PageInsertErrorCode; name: string }
  | { kind: "openFailed"; name: string; size: number; error: unknown };

export type PageMergePorts = {
  store: WorkspaceStore;
  engine: PdfEngine;
  /** The editor store of the document on screen. */
  activeEditor: () => PdfEditorStoreApi;
  /** Any tab's resident editor store, to see who else holds a document. */
  tabEditor: (tabId: string) => PdfEditorStoreApi | undefined;
  flushActiveDraft: () => Promise<void>;
  /** Physically appends the incoming pages (pdf-lib; loaded on first use). */
  insertPages: (
    base: Uint8Array,
    incoming: Uint8Array,
    basePageCount: number,
    incomingName: string,
  ) => Promise<{ bytes: Uint8Array; insertedPageCount: number }>;
  cache: {
    put: (entry: { name: string; size: number; bytes: Uint8Array }) => Promise<string>;
    removeIfUnreferenced: (cacheId: string) => Promise<void>;
  };
  /**
   * Records the merged file in recents, replacing the cache-only entry it
   * supersedes. False means it could not, and the merge must not commit.
   */
  recordMergedRecent: (
    entry: { name: string; pages: number; size: number; hash: string; cacheId: string },
    previousCacheId: string | undefined,
  ) => boolean;
  lastPage: (key: string) => number | undefined;
  settings: () => { animateOverlays: boolean };
  notify: (notice: PageMergeNotice) => void;
};

function pageInsertErrorCode(error: unknown): PageInsertErrorCode | null {
  if (
    !(error instanceof Error) ||
    error.name !== "PdfPageInsertError" ||
    !("code" in error)
  ) {
    return null;
  }
  const code = (error as Error & { code?: unknown }).code;
  const codes: readonly string[] = [
    "encryptedIncoming",
    "baseEncryption",
    "pagesPermission",
    "interactive",
    "navigation",
    "empty",
    "invalidPosition",
    "documentFiles",
    "baseDocumentFiles",
    "baseSigned",
  ];
  return typeof code === "string" && codes.includes(code)
    ? (code as PageInsertErrorCode)
    : null;
}

/**
 * Inserting pages from another PDF (a pasted image arrives as one) into the
 * document on screen.
 *
 * Two phases on purpose. `begin` runs synchronously the moment the reader
 * acts and binds the document they were looking at. Everything after — the
 * picker, decoding, waiting in the queue — can take arbitrarily long, and
 * re-reading the active tab at the end would put the pages into whatever
 * document they had since switched to.
 *
 * Merges run one at a time. Two quick pastes used to each claim the open
 * generation, so the second superseded the first and one image silently
 * never appeared. Queued, the second builds on the first's result.
 */
export function createPageMerges(ports: PageMergePorts) {
  const enqueue = createSerialQueue();
  const { store, engine } = ports;

  async function run(
    incomingBytes: Uint8Array,
    incomingName: string,
    requestedTabId: string | null,
    requestedGeneration: number,
    request: PageMergeRequest,
  ): Promise<boolean> {
    const targetChanged = () => {
      if (request.announcePdfInsertion) ports.notify({ kind: "targetChanged" });
      return false;
    };
    const editor = ports.activeEditor();
    // Everything the claim is built from is read here, at execution time,
    // from the live stores. A queued merge that used values captured when it
    // was asked for failed its own ownership check after an earlier merge
    // changed the document, and vanished without an error.
    const target = captureMergeTarget({
      snapshot: () => editor.getState(),
      generation: requestedGeneration,
      tabId: requestedTabId,
      tabHash: (tabId) =>
        store.getState().tabs.find((tab) => tab.id === tabId)?.hash ?? null,
    });
    const targetTabId = target.claim.tabId;
    const targetOpened = target.opened;
    const targetModel = target.model;
    if (!targetOpened) return targetChanged();
    const placement = request.placement;
    const insertionIndex =
      placement.kind === "append"
        ? targetModel.pages.length
        : targetModel.pages.findIndex((page) => page.id === placement.pageId) + 1;
    if (insertionIndex <= 0 && placement.kind === "after") {
      ports.notify({ kind: "targetMissing" });
      return false;
    }
    let loadedDoc: PdfDocument | null = null;
    // The claim READS the generation and never takes one: taking one let a
    // queued merge outrank an open the reader started while it waited. Every
    // await below is a chance for the reader to move on, and committing after
    // they left would drop this merge onto whatever is now on screen.
    const claim = target.claim;
    const stillOwnsTarget = () =>
      mergeStillOwnsTarget(claim, {
        generation: store.getState().navigation.generation,
        activeTabId: store.getState().activeTabId,
        targetTab: store.getState().tabs.find((tab) => tab.id === targetTabId),
        model: editor.getState().model,
      });
    // The picker may have stayed open while the reader switched or closed
    // the target. Reject that before any flushing, parsing or hashing.
    if (!stillOwnsTarget()) return targetChanged();
    try {
      // Captured now so it can be released once the merged document replaces
      // it; its worker, bytes and page caches would otherwise leak.
      const previousDoc = targetOpened.doc;
      const basePhysicalPageCount = engine.pageCount(previousDoc);
      await ports.flushActiveDraft();
      if (!stillOwnsTarget()) return targetChanged();
      assertPdfWithinFileLimit(incomingBytes.byteLength);
      assertPdfMergeInputWithinFileLimit(
        targetOpened.bytes.byteLength,
        incomingBytes.byteLength,
      );
      const insert = (baseBytes: Uint8Array) => ports.insertPages(
        baseBytes,
        incomingBytes,
        // Physical append is load-bearing. Every Undo snapshot names source
        // pages by index; inserting into the byte stream would shift those
        // identities and point history at the wrong pages.
        basePhysicalPageCount,
        incomingName,
      );
      let security;
      try {
        security = engine.security(previousDoc);
      } catch {
        const { PdfPageInsertError } = await import("../../pdf/merge/insertPdf");
        throw new PdfPageInsertError("baseEncryption", "The base PDF's security is unknown.");
      }
      // Unencrypted sources still go through the writer's /Encrypt guard.
      // For encrypted sources reuse export's original handler and verification;
      // no plaintext result crosses this await into stores or persistence.
      let insertion;
      if (security || targetOpened.encrypted) {
        const [
          { withSourceEncryption, ExportEncryptedSourceError },
          { withPageInsertionEncryption, PdfPageInsertError },
        ] = await Promise.all([
          import("../../pdf/export/encryptedSource"),
          import("../../pdf/merge/insertPdf"),
        ]);
        // Imports yield too: do not let withSourceEncryption read security
        // from a document whose tab was closed while the writer loaded.
        if (!stillOwnsTarget()) return targetChanged();
        try {
          insertion = await withSourceEncryption(engine, targetOpened, (encryption) =>
              withPageInsertionEncryption(targetOpened.bytes, encryption, insert),
          );
        } catch (cause) {
          if (cause instanceof ExportEncryptedSourceError) {
            throw new PdfPageInsertError("baseEncryption", "The base PDF's security is unknown.", { cause });
          }
          throw cause;
        }
      } else {
        insertion = await insert(targetOpened.bytes);
      }
      const mergedBytes = insertion.bytes;
      assertPdfWithinFileLimit(mergedBytes.byteLength);
      const hash = await sha256Hex(mergedBytes);
      // Nothing allocated yet beyond bytes: bail before parsing a document
      // this merge would only destroy.
      if (!stillOwnsTarget()) return targetChanged();
      const { doc, bytes: keep } = await engine.load(mergedBytes, {
        password: targetOpened.password,
      });
      loadedDoc = doc;
      assertPdfWithinPageLimit(engine.pageCount(doc));
      const outputGeometry = await engine.pageGeometry(doc);
      outputGeometry.forEach((geometry, index) =>
        assertPdfPageDimensionsWithinLimit(geometry.widthPt, geometry.heightPt, index + 1),
      );
      const insertionPlan = planPhysicalAppendInsertion({
        previousPages: targetModel.pages,
        outputGeometry,
        basePhysicalPageCount,
        insertionIndex,
        insertedPageCount: insertion.insertedPageCount,
        createId: nanoid,
      });
      const mergedPages = insertionPlan.pages;
      const insertedPages = insertionPlan.insertedPages;
      // The fresh document has empty annotation storage, so every page is
      // scanned, but overlays come back only for inserted pages: base overlays
      // may have been edited or deleted and stay authoritative.
      const importedOverlays = await engine.importAnnotations(
        doc,
        insertionPlan.sourcePages,
        keep,
        Date.now(),
        { overlayPageIds: new Set(insertedPages.map((page) => page.id)) },
      );
      const mergedName = request.keepBaseFileName
        ? targetOpened.fileName
        : `${targetOpened.fileName.replace(/\.pdf$/i, "")}+${incomingName}`;
      const mergedModel: DocumentModel = {
        pages: mergedPages,
        overlays: [...targetModel.overlays, ...importedOverlays],
      };
      const historyBaseline = targetModel;
      // Identity metadata only: a synthetic File would copy the merged PDF
      // once more, where the engine and the cache already hold it.
      const fileLike = { name: mergedName, size: mergedBytes.byteLength };
      const cacheId = await ports.cache.put({
        name: mergedName,
        size: mergedBytes.byteLength,
        bytes: mergedBytes,
      });
      if (stillOwnsTarget()) {
        // A cache-only PDF cannot be found again by reopening the original,
        // so its recents entry is written before the store or tab changes.
        // This check and finishPdfMerge's run in the same turn.
        const previousSource = targetTabId
          ? store.getState().tabs.find((tab) => tab.id === targetTabId)?.source
          : undefined;
        const recorded = ports.recordMergedRecent(
          {
            name: mergedName,
            pages: mergedPages.length,
            size: mergedBytes.byteLength,
            hash,
            cacheId,
          },
          previousSource?.type === "cache" ? previousSource.id : undefined,
        );
        if (!recorded) {
          void engine.destroy(doc);
          loadedDoc = null;
          await ports.cache.removeIfUnreferenced(cacheId).catch(() => undefined);
          ports.notify({ kind: "recentsSaveFailed" });
          return false;
        }
      }
      // Last gate: past it, the store, the tab and the pre-merge document's
      // lifetime all change.
      const committed = await finishPdfMerge({
        stillOwnsTarget,
        document: doc,
        cacheId,
        destroyDocument: (merged) => void engine.destroy(merged),
        // Unreferenced only: another tab may have adopted these exact bytes
        // meanwhile. Awaited so a failed delete is observed here.
        removeCachedSource: (id) => ports.cache.removeIfUnreferenced(id),
        commit: () => {
          // Existing page indices did not move, so the pre-merge export
          // bookkeeping stays valid across the retained Undo timeline. The
          // hash moves forward so undoing back to an exported snapshot still
          // reads as exported.
          const { session } = store.getState();
          const preservedBaseline =
            session.exportBaselineSnapshot ?? exportSnapshotKey(historyBaseline);
          const preservedLastExport = session.lastExport
            ? { ...session.lastExport, documentHash: hash }
            : null;
          // No Live receipts passed: the store keeps the ones it has.
          finalizePdfOpen({
            store: editor,
            file: fileLike,
            hash,
            pages: insertionPlan.sourcePages,
            doc,
            bytes: keep,
            source: {},
            password: targetOpened.password,
            encrypted: Boolean(security || targetOpened.encrypted),
            model: { ...mergedModel, historyBaseline, preserveHistory: true },
            modelAsEdit: true,
            resumePageIndex: ports.lastPage(fileLike.name),
            animateImportedCallouts: ports.settings().animateOverlays,
          });
          store.getState().setSession({
            activeHash: hash,
            exportBaselineSnapshot: preservedBaseline,
            lastExport: preservedLastExport,
          });
          const insertedPage = insertedPages[0];
          if (insertedPage) {
            const insertedIndex = mergedPages.findIndex(
              (page) => page.id === insertedPage.id,
            );
            if (insertedIndex >= 0) {
              editor.getState().goToPage(insertedPage.id, insertedIndex);
            }
          }
          loadedDoc = null;
          if (targetTabId) {
            store.getState().updateTab(targetTabId, (tab) => ({
              ...tab,
              title: mergedName,
              size: mergedBytes.byteLength,
              source: { type: "cache", id: cacheId },
              hash,
              status: "loaded",
              pdfView: pdfViewFromStore(editor),
              exportBaselineSnapshot: preservedBaseline,
              lastExport: preservedLastExport,
              updatedAt: Date.now(),
            }));
          }
          // Release the pre-merge document unless it is the merged one or
          // another tab's session still holds it.
          if (
            previousDoc &&
            previousDoc !== doc &&
            !store
              .getState()
              .tabs.some(
                (tab) =>
                  tab.kind === "pdf" &&
                  ports.tabEditor(tab.id)?.getState().opened?.doc === previousDoc,
              )
          ) {
            void engine.destroy(previousDoc);
          }
        },
      });
      if (!committed) {
        // finishPdfMerge already destroyed the document and dropped the row.
        loadedDoc = null;
        return targetChanged();
      }
      if (request.announcePdfInsertion) {
        ports.notify({
          kind: "inserted",
          count: insertion.insertedPageCount,
          name: incomingName,
        });
      }
      return true;
    } catch (error) {
      void engine.destroy(loadedDoc);
      // An awaited handler can fail because the reader closed its target.
      // Ownership, rather than the exception's wording, decides cancellation.
      if (!stillOwnsTarget()) return targetChanged();
      const code = pageInsertErrorCode(error);
      ports.notify(
        code
          ? {
              kind: "insertRefused",
              code,
              name: code === "baseEncryption" || code === "pagesPermission"
                ? targetOpened.fileName
                : incomingName,
            }
          : {
              kind: "openFailed",
              name: incomingName,
              size: incomingBytes.byteLength,
              error,
            },
      );
      return false;
    }
  }

  return {
    /** Binds a merge to the document on screen now; call it the moment the reader acts. */
    begin(
      request: PageMergeRequest = {
        placement: { kind: "append" },
        keepBaseFileName: false,
        announcePdfInsertion: false,
      },
    ): BoundPageMerge {
      return bindPageMergeIntent<[Uint8Array, string], boolean>({
        activeTabId: () => store.getState().activeTabId,
        generation: () => store.getState().navigation.generation,
        enqueue,
        run: (intent, incomingBytes, incomingName) =>
          run(incomingBytes, incomingName, intent.tabId, intent.generation, request),
      });
    },
  };
}

export type PageMerges = ReturnType<typeof createPageMerges>;
