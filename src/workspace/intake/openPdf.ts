import { nanoid } from "nanoid";
import { sourceForPayload } from "../../documents/types";
import { explicitInitialPdfPageIndex } from "../../editor/openViewState";
import {
  filterExistingCollapsedCalloutIds,
  filterExistingCollapsedNoteIds,
} from "../../editor/overlays/notePresentation";
import { applyReopenedWorkspaceTab } from "../../editor/workspaceTabs";
import { exportSnapshotKey } from "../../editor/export/exportStatus";
import { LIVE_OPERATION_RECEIPT_MAX } from "../../live/liveReceiptPolicy";
import type { PdfDocument } from "../../pdf/engine/types";
import type { Overlay, PageModel } from "../../pdf/model/types";
import {
  assertPdfPageDimensionsWithinLimit,
  assertPdfWithinFileLimit,
  assertPdfWithinPageLimit,
  classifyPdfOpenError,
} from "../../pdf/openPolicy";
import { sha256Hex } from "../../storage/hash";
import { restoreSuspendedPdfSnapshot } from "../../storage/runtimeSessions";
import { defaultPdfView, pdfViewForLayout, pdfViewFromStore } from "../pdfView";
import type {
  PendingRestore,
  RestoredDraftNotice,
  WorkspaceRuntimeTab,
} from "../types";
import { finalizePdfOpen } from "./finalizePdfOpen";
import { chooseDraftRecovery } from "./recovery";
import { abandonOpen, findExistingTab, openClaim } from "./shared";
import type { IntakePorts, PdfOpenInput, PdfOpenOptions } from "./types";

/**
 * Opens PDF bytes as a tab, or restores them into an existing tab.
 *
 * Opening is long — parse, per-page metadata, annotation import, hash, draft
 * recovery — and the reader does not wait for it. The claim is taken here,
 * when the reader acts, not when the queued job starts: a claim made later
 * supersedes this one, and a superseded open still builds its tab, it just
 * does not take the screen.
 */
export function openPdf(
  input: PdfOpenInput,
  options: PdfOpenOptions,
  ports: IntakePorts,
): Promise<void> {
  const { shouldActivate, shouldContinue } = openClaim(ports, options);
  return ports.enqueuePdfOpen(() =>
    runPdfOpen(input, options, ports, shouldActivate, shouldContinue),
  );
}

async function runPdfOpen(
  input: PdfOpenInput,
  options: PdfOpenOptions,
  ports: IntakePorts,
  shouldActivate: () => boolean,
  shouldContinue: () => boolean,
): Promise<void> {
  const { store, engine } = ports;
  let pendingCacheId = input.cacheId;
  const abandon = () => abandonOpen(ports, options.tabId, pendingCacheId);
  if (!(await ports.persistActive())) return;
  if (!shouldContinue()) return abandon();
  if (shouldActivate()) ports.ui.setError(null);
  let loadedDoc: PdfDocument | null = null;
  try {
    assertPdfWithinFileLimit(input.size);
    const sourcePayload = await ports.sources.ensure({
      kind: "pdf",
      name: input.name,
      size: input.size,
      bytes: input.bytes,
      path: input.path,
      webFileHandleId: input.webFileHandleId,
      cacheId: input.cacheId,
    });
    pendingCacheId = sourcePayload.cacheId;
    const tabSource = sourceForPayload(sourcePayload);
    const hash = input.hash ?? (await sha256Hex(input.bytes));
    const settings = ports.settings();
    const explicitPdfView = options.pdfView
      ? pdfViewForLayout(options.pdfView, settings.compactLayout)
      : undefined;
    const initialPdfView =
      explicitPdfView ?? defaultPdfView(settings.compactLayout);
    const initialPageIndexOverride = explicitInitialPdfPageIndex(
      explicitPdfView,
      input.replaceRecentEntry,
    );
    const existing = options.skipDuplicateCheck
      ? null
      : await findExistingTab(ports, "pdf", tabSource, hash);
    if (existing && existing.id !== options.tabId) {
      if (
        sourcePayload.cacheId &&
        sourcePayload.cacheId !==
          (existing.source.type === "cache" ? existing.source.id : undefined)
      ) {
        ports.sources.removeIfUnreferenced(sourcePayload.cacheId);
      }
      if (!shouldActivate()) {
        if (options.tabId) abandon();
        return;
      }
      await ports.activateLoadedTab(existing.id);
      return;
    }
    const { doc, bytes: keep } = await engine.load(input.bytes, {
      password: input.password,
    });
    loadedDoc = doc;
    ports.ui.warnAboutCanvas();
    assertPdfWithinPageLimit(engine.pageCount(doc));
    const nextPages: PageModel[] = (await engine.pageGeometry(doc)).map(
      (geometry, index) => {
        assertPdfPageDimensionsWithinLimit(
          geometry.widthPt,
          geometry.heightPt,
          index + 1,
        );
        return { id: nanoid(), sourceIndex: index, ...geometry };
      },
    );

    let importedOverlays: Overlay[] = [];
    // Password is a reliable fallback when the raw pdf-lib scan cannot
    // inspect the source. The scan also catches empty-password encryption.
    let encryptedSource = Boolean(input.password);
    try {
      importedOverlays = await engine.importAnnotations(
        doc,
        nextPages,
        keep,
        undefined,
        {
          onSourceInfo: (info) => {
            encryptedSource = info.encrypted ?? encryptedSource;
          },
        },
      );
    } catch (err) {
      console.warn("PDF annotation import failed", err);
    }
    const importedModel =
      importedOverlays.length > 0
        ? { pages: nextPages, overlays: importedOverlays }
        : undefined;
    const baselineSnapshot = exportSnapshotKey(
      importedModel ?? { pages: nextPages, overlays: [] },
    );

    // Receipt tombstones live outside recoverable drafts. Await them before
    // the document goes on screen so it cannot publish a writable Live
    // context during a lost-response retry window.
    const [draft, persistedReceipts] = options.runtimeSnapshot
      ? [null, options.runtimeSnapshot.completedLiveOperationIds]
      : await Promise.all([
          ports.drafts.get(hash),
          ports.drafts.getLiveOperationReceipts(hash),
        ]);
    const completedLiveOperationIds = [
      ...new Set([
        ...persistedReceipts,
        ...(draft?.completedLiveOperationIds ?? []),
      ]),
    ].slice(-LIVE_OPERATION_RECEIPT_MAX);
    const draftVersion = draft
      ? { lastTouched: draft.lastTouched, revision: draft.revision ?? null }
      : null;
    if (
      completedLiveOperationIds.some(
        (operationId) => !persistedReceipts.includes(operationId),
      )
    ) {
      // One-time migration for drafts written before the independent ledger
      // existed. These ids came from successful historical commits.
      await ports.drafts.mergeLiveOperationReceipts(
        hash,
        completedLiveOperationIds,
      );
    }
    const recovery = chooseDraftRecovery(
      draft,
      options.runtimeSnapshot ? null : ports.drafts.readOperationLog(hash),
      nextPages,
      completedLiveOperationIds,
    );
    const fileLike: File =
      input.file ??
      new File([new Uint8Array(input.bytes)], input.name, {
        type: "application/pdf",
      });

    if (!shouldContinue()) {
      void engine.destroy(loadedDoc);
      return abandon();
    }

    const nextTabId = options.tabId ?? nanoid();
    if (!(await ports.editors.reserveResidentSlot(nextTabId))) {
      void engine.destroy(loadedDoc);
      if (options.tabId) {
        store.getState().updateTab(nextTabId, (tab) => ({
          ...tab,
          // Shown with its reason and a Retry, rather than `suspended`, which
          // would retry silently on every visit while quota stays full. This
          // also covers an unloaded tab whose durable row was missing and so
          // reopened from its source instead.
          status: "unavailable",
          unavailableDetail: "runtime-storage-admission-failed",
        }));
      }
      return;
    }
    // Admission can await a durable snapshot write and a document destroy. A
    // newer open may win meanwhile; never let this older one register a store
    // and reclaim the foreground afterwards.
    if (!shouldContinue()) {
      void engine.destroy(loadedDoc);
      return abandon();
    }
    const targetStore = ports.editors.ensure(nextTabId);
    finalizePdfOpen({
      store: targetStore,
      file: fileLike,
      hash,
      pages: nextPages,
      doc,
      bytes: keep,
      source: {
        path: input.path,
        webFileHandleId: input.webFileHandleId,
        cacheId: sourcePayload.cacheId,
      },
      password: input.password,
      encrypted: encryptedSource,
      draftVersion,
      model: importedModel,
      resumePageIndex:
        initialPageIndexOverride ??
        ports.recents.lastPage(
          input.path ??
            input.webFileHandleId ??
            sourcePayload.cacheId ??
            fileLike.name,
        ),
      view: initialPdfView,
      completedLiveOperationIds,
      // Draft-owned collapsed ids match nothing until the draft is applied.
      keepUnmatchedCollapsedIds: Boolean(recovery),
      animateImportedCallouts: settings.animateOverlays,
    });
    loadedDoc = null;
    let restoredDraftNotice: RestoredDraftNotice | undefined;
    if (recovery) {
      const recoveryDraft: PendingRestore = {
        file: fileLike,
        hash,
        pages: nextPages,
        fileSize: input.size,
        lastTouched: recovery.lastTouched,
        draftModelOverlays: recovery.overlays,
        draftModelPages: recovery.pages,
        draftHistory: recovery.history,
        completedLiveOperationIds: recovery.completedLiveOperationIds,
      };
      // Restore the draft silently: it IS the reader's current state, not a
      // backup awaiting approval. The as-opened model is captured first so
      // the status bar can offer "open the original", which sets the draft
      // aside without deleting it.
      const originalModel = targetStore.getState().model;
      targetStore.getState().commitRestoredDraft(
        { pages: recoveryDraft.draftModelPages, overlays: recoveryDraft.draftModelOverlays },
        recoveryDraft.draftHistory,
        recoveryDraft.completedLiveOperationIds,
      );
      const overlays = targetStore.getState().model.overlays;
      targetStore
        .getState()
        .setCollapsedNoteIds(
          filterExistingCollapsedNoteIds(
            targetStore.getState().collapsedNoteIds,
            overlays,
          ),
        );
      targetStore
        .getState()
        .setCollapsedCalloutIds(
          filterExistingCollapsedCalloutIds(
            targetStore.getState().collapsedCalloutIds,
            overlays,
          ),
        );
      restoredDraftNotice = {
        draft: recoveryDraft,
        originalModel,
        committedModel: targetStore.getState().model,
      };
    }
    if (options.runtimeSnapshot) {
      restoreSuspendedPdfSnapshot(targetStore, options.runtimeSnapshot);
      try {
        await ports.runtime.removeSession(nextTabId);
      } catch (error) {
        // The in-memory store is already authoritative and usable. Leaving
        // the verified suspended row behind is safe; startup repair or the
        // next suspend will reconcile it.
        console.warn("Failed to remove resumed PDF runtime session", error);
      }
      ports.runtime.rememberCredential(nextTabId, input.password);
    }
    if (
      options.tabId &&
      !store.getState().tabs.some((candidate) => candidate.id === nextTabId)
    ) {
      // Closing a tab may win while its cold restore waits for IndexedDB
      // cleanup. Never resurrect the closed tab; release this runtime.
      await engine.destroy(targetStore.getState().opened?.doc);
      ports.editors.remove(nextTabId);
      ports.runtime.rememberCredential(nextTabId, undefined);
      return;
    }
    // A resumed tab gets its model back from the snapshot, page ids and all,
    // so the baseline it is compared against is the one its record kept. A
    // baseline from this load's fresh page ids never matches it, and an
    // untouched document came back marked unexported.
    const exportBaseline =
      (options.runtimeSnapshot &&
        store.getState().tabs.find((tab) => tab.id === nextTabId)
          ?.exportBaselineSnapshot) ||
      baselineSnapshot;
    const nextTab: WorkspaceRuntimeTab = {
      id: nextTabId,
      kind: "pdf",
      title: input.name,
      size: input.size,
      source: tabSource,
      hash,
      pdfView: pdfViewFromStore(targetStore),
      status: "loaded",
      exportBaselineSnapshot: exportBaseline,
      lastExport: null,
      restoredDraft: restoredDraftNotice,
      updatedAt: Date.now(),
    };
    // applyReopenedWorkspaceTab decides what the export state must become:
    // cleared for a genuinely new document, carried across for a reopen,
    // whose record lives on the tab. Every route passes through here,
    // including the password retry, which re-enters long after the cold
    // loader has returned.
    const { nextTabs, restoredLastExport } = applyReopenedWorkspaceTab(
      store.getState().tabs,
      nextTab,
    );
    store.setState({ tabs: nextTabs });
    // The awaits above may have let the reader move on. Keep the restored tab
    // warm but do not steal the screen back from a newer request.
    if (shouldActivate()) {
      store.getState().setSession({
        activeHash: hash,
        exportBaselineSnapshot: exportBaseline,
        restoredDraft: restoredDraftNotice ?? null,
        pendingRestore: null,
        deferredDraft: null,
      });
      ports.ui.setError(null);
      store.getState().setActiveTab(nextTabId);
      ports.editors.touch(nextTabId);
      ports.editors.show(targetStore);
      store.getState().setSession({ lastExport: restoredLastExport });
    }
    rememberOpenedPdf(ports, input, sourcePayload.cacheId, hash, doc);
  } catch (err) {
    void engine.destroy(loadedDoc);
    if (!shouldContinue()) return abandon();
    if (classifyPdfOpenError(err) === "password") {
      ports.ui.requestPassword({
        // The full request frame: a restored tab keeps its identity, view,
        // duplicate policy and activation guard when the password retry
        // re-enters.
        input: { ...input, cacheId: pendingCacheId, password: undefined },
        options,
        wrongPassword: !!input.password,
      });
      return;
    }
    console.error(err);
    const info = ports.ui.describeOpenError(input.name, input.size, err);
    if (options.tabId) {
      store.getState().updateTab(options.tabId, (tab) => ({
        ...tab,
        // This load still owns its claim, so it did not lose a race: a parse
        // or policy rejection is a terminal restore result. Keep the reason
        // and require an explicit retry instead of reloading automatically.
        status: "unavailable",
        unavailableDetail: `${info.code} · ${info.message}`,
        updatedAt: Date.now(),
      }));
    }
    if (ports.editors.hasOpenDocument()) {
      ports.ui.toastError(
        info.title,
        `${info.code} · ${input.name} · ${info.message}`,
      );
      return;
    }
    ports.ui.setError(info);
  }
}

function rememberOpenedPdf(
  ports: IntakePorts,
  input: PdfOpenInput,
  cacheId: string | undefined,
  hash: string,
  doc: PdfDocument,
): void {
  const entry = {
    name: input.name,
    pages: ports.engine.pageCount(doc),
    size: input.size,
    hash,
    path: input.path,
    webFileHandleId: input.webFileHandleId,
    cacheId,
  };
  if (!ports.recents.canReopen(entry)) return;
  const previous = input.replaceRecentEntry;
  if (previous) {
    ports.recents.replace(previous, entry);
    if (
      previous.webFileHandleId &&
      previous.webFileHandleId !== input.webFileHandleId
    ) {
      ports.recents.forgetWebFileHandle(previous.webFileHandleId);
    }
  } else {
    ports.recents.record(entry);
  }
  // The row shows at once with a stub; the thumbnail backfills when it
  // renders, and silently no-ops if the entry was evicted meanwhile.
  void ports.engine.thumbnail(doc, 1, 120).then((thumb) => {
    if (thumb) {
      ports.recents.attachThumb(
        input.path ?? input.webFileHandleId ?? cacheId ?? input.name,
        thumb,
      );
    }
  });
}
