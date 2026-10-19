import { exportSnapshotKey } from "../editor/export/exportStatus";
import { reserveResidentPdfSlot } from "../editor/store/residentPdfSessions";
import type { PdfEditorStoreApi } from "../editor/store/store";
import { removeTabEditorStore } from "../editor/store/tabStoreRegistry";
import type { CapturedPdfTabPreview } from "../editor/tabPreview";
import type { PdfDocument, PdfEngine } from "../pdf/engine/types";
import {
  captureSuspendedPdfSnapshot,
  type SuspendedPdfSnapshot,
} from "../storage/runtimeSessions";
import { pdfViewFromStore } from "./pdfView";
import type { WorkspaceRuntimeTab } from "./types";
import type { WorkspaceStore } from "./workspaceStore";

/** At most this many PDFs keep a live engine document; the rest suspend. */
export const PDF_RESIDENT_LIMIT = 3;

export type PdfRuntimePorts = {
  store: WorkspaceStore;
  engine: PdfEngine;
  /** Suspended sessions: a tab's bytes and editor state, parked durably. */
  sessions: {
    /** Resolves only once the row was written and read back. */
    put: (input: {
      tabId: string;
      bytes: Uint8Array;
      snapshot: SuspendedPdfSnapshot;
      lastTouched: number;
    }) => Promise<unknown>;
    remove: (tabId: string) => Promise<void>;
    /** Kept in memory only: an encrypted PDF resumes without asking again. */
    rememberCredential: (tabId: string, password: string | undefined) => void;
  };
  /** The tab strip's hover previews. */
  previews: {
    capture: (store: PdfEditorStoreApi) => CapturedPdfTabPreview | null;
    put: (preview: CapturedPdfTabPreview & { tabId: string }) => Promise<unknown>;
    remove: (tabId: string) => Promise<void>;
  };
  /** The editor store on screen. */
  activeEditor: () => PdfEditorStoreApi;
  /** Saves the draft of the PDF on screen; rejects if it could not. */
  flushDraft: () => Promise<void>;
  onFlushFailed: (tab: WorkspaceRuntimeTab, error: unknown) => void;
};

/**
 * The engine documents PDF tabs hold, and when each one is let go.
 *
 * A PDF tab is resident (its editor store holds a live engine document) or
 * suspended (a durable session row holds its bytes and editor state). Only
 * PDF_RESIDENT_LIMIT tabs stay resident. Every document is released exactly
 * once through the engine, and never before its tab's state is safe: a
 * suspension releases only after the row is verified, and a failed write keeps
 * the document. The engine owns native (or wasm) memory, so a missed release
 * is a leak the GC cannot recover, and a second release of the same handle
 * is an error.
 */
export function createPdfRuntime(ports: PdfRuntimePorts) {
  const { store, engine, sessions, previews } = ports;
  const previewWrites = new Map<string, Promise<void>>();
  const findTab = (tabId: string) =>
    store.getState().tabs.find((tab) => tab.id === tabId);

  function recordPreview(tabId: string, editor: PdfEditorStoreApi): void {
    const captured = previews.capture(editor);
    if (!captured) return;
    const write = previews
      .put({ tabId, ...captured })
      .then(() => undefined)
      .catch((error) => {
        console.warn("Failed to cache tab preview", error);
      });
    previewWrites.set(tabId, write);
    void write.finally(() => {
      if (previewWrites.get(tabId) === write) previewWrites.delete(tabId);
    });
  }

  /**
   * Parks an inactive PDF tab in a verified session row, then releases its
   * document. The tab reloads from the row when shown.
   */
  async function suspend(tabId: string, editor: PdfEditorStoreApi): Promise<void> {
    if (store.getState().activeTabId === tabId) {
      throw new Error("Refusing to suspend the visible PDF tab");
    }
    const tab = findTab(tabId);
    const state = editor.getState();
    if (!tab || tab.kind !== "pdf" || !state.opened) {
      throw new Error("Resident PDF tab is incomplete");
    }
    sessions.rememberCredential(tabId, state.opened.password);
    await sessions.put({
      tabId,
      bytes: state.opened.bytes,
      snapshot: captureSuspendedPdfSnapshot(editor),
      lastTouched: tab.updatedAt,
    });
    const tabStillExists = findTab(tabId) !== undefined;
    // Only now, with the row verified, may the document be released. Even a
    // failed release may have torn down part of it, so the row is the only
    // safe authority afterwards: keeping this half-released store would leave
    // two diverging copies of the tab.
    await engine.destroy(state.opened.doc);
    removeTabEditorStore(tabId);
    if (!tabStillExists) {
      // The reader closed this tab while its row was being written. A close
      // that ran before the write could not see the row, so remove it here
      // rather than leave an orphan until the next startup repair.
      try {
        await sessions.remove(tabId);
      } catch (error) {
        console.warn("Failed to clean up a concurrently closed PDF tab", error);
      }
      sessions.rememberCredential(tabId, undefined);
      return;
    }
    store.getState().updateTab(tabId, (current) => ({
      ...current,
      status: "suspended",
      pdfView: pdfViewFromStore(editor),
      suspendedSnapshotKey: exportSnapshotKey(state.model),
    }));
  }

  return {
    recordPreview,

    /** Resolves once a preview being written for the tab has landed. */
    previewWritten(tabId: string): Promise<void> | undefined {
      return previewWrites.get(tabId);
    },

    /**
     * Makes room for `targetTabId` among the resident PDFs, suspending the
     * least recently used. False means no room could be made; `onRefused`
     * tells the reader why.
     */
    async reserve(targetTabId: string, onRefused: () => void): Promise<boolean> {
      const result = await reserveResidentPdfSlot({
        targetTabId,
        residentLimit: PDF_RESIDENT_LIMIT,
        activeTabId: store.getState().activeTabId,
        suspend,
      });
      if (result.admitted) return true;
      console.error("Unable to reserve a resident PDF slot", result.error);
      onRefused();
      return false;
    },

    /**
     * Records the PDF on screen into its tab before another document takes
     * the screen: saves the draft, the view, the export markers and the
     * preview. False means the draft could not be saved and the switch
     * should not happen.
     */
    async persistLeaving(): Promise<boolean> {
      const sourceTabId = store.getState().activeTabId;
      const sourceTab = sourceTabId ? findTab(sourceTabId) : undefined;
      const sourceEditor = ports.activeEditor();
      if (!sourceTabId || sourceTab?.kind !== "pdf" || !sourceEditor.getState().opened) {
        return true;
      }
      try {
        await ports.flushDraft();
      } catch (error) {
        ports.onFlushFailed(sourceTab, error);
        return false;
      }
      // Rapid tab requests can join the same save. If an earlier one already
      // switched documents, never record the new document into the old tab.
      if (
        store.getState().activeTabId !== sourceTabId ||
        ports.activeEditor() !== sourceEditor
      ) {
        return true;
      }
      recordPreview(sourceTabId, sourceEditor);
      const { session } = store.getState();
      store.getState().updateTab(sourceTabId, (tab) => ({
        ...tab,
        status: "loaded",
        pdfView: pdfViewFromStore(sourceEditor),
        hash: session.activeHash ?? tab.hash,
        exportBaselineSnapshot: session.exportBaselineSnapshot,
        lastExport: session.lastExport,
        updatedAt: Date.now(),
      }));
      return true;
    },

    /**
     * Frees what a closed tab held: its editor store, engine document,
     * session row and preview. `onScreen` is the document that was on screen
     * when the tab closed, if the closed tab was the visible one.
     */
    async release(closing: WorkspaceRuntimeTab, onScreen: unknown): Promise<void> {
      // Unregister before any await: the neighbour may already be admitting.
      const closingEditor = removeTabEditorStore(closing.id);
      const closingDoc = closingEditor?.getState().opened?.doc;
      if (closing.kind === "pdf") await engine.destroy(closingDoc);
      try {
        await sessions.remove(closing.id);
      } catch (error) {
        console.warn("Failed to remove suspended PDF runtime session", error);
        sessions.rememberCredential(closing.id, undefined);
      }
      try {
        await previewWrites.get(closing.id);
        await previews.remove(closing.id);
      } catch (error) {
        console.warn("Failed to remove tab preview", error);
      }
      if (onScreen && onScreen !== closingDoc) {
        void engine.destroy(onScreen as PdfDocument);
      }
    },
  };
}

export type PdfRuntime = ReturnType<typeof createPdfRuntime>;
