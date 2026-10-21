import { drainPendingWrites } from "../../editor/textSourceSaveQueue";
import { applyTextSourceWriteCompletion } from "../../editor/workspaceTabs";
import type { DocumentKind, DocumentSource } from "../../documents/types";
import type { SaveResult } from "../../platform/save";
import type { WriteBackResult, WriteBackTarget } from "../../platform/writeBack";
import { createSerialQueue } from "../../shared/serialQueue";
import { sha256Hex } from "../../storage/hash";
import type { WorkspaceStore } from "../workspaceStore";
import { encodeTextDocument, textDocumentContents } from "./textEncoding";

export type TextKind = Extract<DocumentKind, "markdown" | "html">;

/** How long typing must pause before the working copy is written. */
export const TEXT_SOURCE_SAVE_DEBOUNCE_MS = 500;

/** What the reader is told; App turns these into translated toasts. */
export type TextSourceNotice =
  | { kind: "workingCopySaveFailed"; error: unknown }
  | { kind: "savedNoChanges" }
  | { kind: "saved"; name: string }
  | { kind: "savedAs"; path: string }
  | { kind: "saveOriginMissing"; title: string }
  | { kind: "savePermissionDenied"; title: string }
  | { kind: "saveEncodingUnsupported"; title: string }
  /** The file changed on disk since Shiori read it; `overwrite` saves anyway. */
  | { kind: "saveSourceChanged"; title: string; overwrite: () => Promise<void> }
  /** Shiori cannot tell what the file held when the edits began; `overwrite` saves anyway. */
  | { kind: "saveSourceUnverified"; title: string; overwrite: () => Promise<void> }
  | { kind: "saveFailed"; title: string; error: unknown };

export type TextSourcePorts = {
  store: WorkspaceStore;
  timers: {
    set: (run: () => void, ms: number) => number;
    clear: (handle: number) => void;
  };
  cache: {
    /** Writes a working copy; returns its cache id. */
    put: (entry: {
      kind: TextKind;
      name: string;
      size: number;
      bytes: Uint8Array;
    }) => Promise<string>;
    remove: (cacheId: string) => void;
    removeIfUnreferenced: (cacheId: string) => void;
  };
  /** Saves workspace metadata now; false means it did not persist. */
  persistMetadata: () => boolean;
  writeBack: {
    target: (source: DocumentSource) => WriteBackTarget | null;
    /**
     * `unchanged` (when given) is asked about the file's current bytes right
     * before they are replaced; false answers `changed` and writes nothing.
     */
    write: (
      target: WriteBackTarget,
      text: string,
      unchanged?: (current: Uint8Array) => Promise<boolean>,
    ) => Promise<WriteBackResult>;
    /** Save As: a download on the web, a dialog on desktop. */
    saveAs: (bytes: Uint8Array, name: string, mime: string) => Promise<SaveResult>;
    /** Desktop: a document with no origin has no honest place to overwrite. */
    requiresOrigin: boolean;
  };
  notify: (notice: TextSourceNotice) => void;
  /** Whether any edit is still waiting for its working copy. */
  onPendingChange: (pending: boolean) => void;
};

type PendingSave = { kind: TextKind; title: string; text: string; seq: number };

/**
 * Markdown and HTML edits: autosave to an app-local working copy, and the
 * explicit ⌘S write-back over the file the document came from.
 *
 * An edit only updates the tab and restarts a debounce; the whole document is
 * encoded once the typing pauses, never per keystroke. Each tab's saves carry
 * a sequence number, so a slow write never attaches older text over newer.
 */
export function createTextSources(ports: TextSourcePorts) {
  const { store } = ports;
  const timers = new Map<string, number>();
  const seqs = new Map<string, number>();
  const pending = new Map<string, PendingSave>();
  const inFlight = new Map<string, { seq: number; promise: Promise<void> }>();
  // Source-file writes are the reader's intent, not autosave. Keep them in
  // click order so two quick saves cannot put older bytes over newer ones.
  const enqueueWriteBack = createSerialQueue();

  const reportPending = () => ports.onPendingChange(pending.size > 0);

  async function persistNow(tabId: string, save: PendingSave): Promise<void> {
    if (seqs.get(tabId) !== save.seq) return;
    const bom = store.getState().tabs.find((tab) => tab.id === tabId)?.textBom;
    const bytes = encodeTextDocument(save.text, bom);
    const hash = await sha256Hex(bytes);
    const cacheId = await ports.cache.put({
      kind: save.kind,
      name: save.title,
      size: bytes.byteLength,
      bytes,
    });
    if (seqs.get(tabId) !== save.seq) {
      ports.cache.remove(cacheId);
      return;
    }
    let attached = false;
    let previousCacheId: string | null = null;
    store.getState().updateTab(tabId, (tab) => {
      if (tab.kind !== save.kind || tab.text !== save.text) return tab;
      attached = true;
      previousCacheId = tab.workingCopyCacheId ?? null;
      return {
        ...tab,
        hash,
        size: bytes.byteLength,
        workingCopyCacheId: cacheId,
        updatedAt: Date.now(),
      };
    });
    if (!attached) {
      ports.cache.remove(cacheId);
      return;
    }
    if (!ports.persistMetadata()) {
      // The blob is attached but the record pointing at it did not persist,
      // so the next attempt would write another one and orphan this. Metadata
      // saves fail when storage is full, exactly when leaking a whole-document
      // copy per retry is worst.
      store
        .getState()
        .updateTab(tabId, (tab) =>
          tab.workingCopyCacheId === cacheId
            ? { ...tab, workingCopyCacheId: previousCacheId ?? undefined }
            : tab,
        );
      ports.cache.remove(cacheId);
      throw new Error("workspace-metadata-save-failed");
    }
    if (previousCacheId && previousCacheId !== cacheId) {
      ports.cache.removeIfUnreferenced(previousCacheId);
    }
  }

  function persist(tabId: string, save: PendingSave): Promise<void> {
    const existing = inFlight.get(tabId);
    if (existing?.seq === save.seq) return existing.promise;
    const promise = persistNow(tabId, save).finally(() => {
      if (inFlight.get(tabId)?.promise === promise) inFlight.delete(tabId);
    });
    inFlight.set(tabId, { seq: save.seq, promise });
    return promise;
  }

  function clearTimer(tabId: string): void {
    const timer = timers.get(tabId);
    if (timer !== undefined) ports.timers.clear(timer);
    timers.delete(tabId);
  }

  /** Queues a working-copy save for text the tab now holds. */
  function schedule(tabId: string, kind: TextKind, title: string, text: string) {
    clearTimer(tabId);
    const seq = (seqs.get(tabId) ?? 0) + 1;
    seqs.set(tabId, seq);
    pending.set(tabId, { kind, title, text, seq });
    reportPending();
    const timer = ports.timers.set(() => {
      timers.delete(tabId);
      const save = pending.get(tabId);
      if (!save || save.seq !== seq) return;
      void persist(tabId, save)
        .then(() => {
          if (pending.get(tabId)?.seq === seq) pending.delete(tabId);
          reportPending();
        })
        .catch((error) => {
          // Keep the edit pending so closing, going home or pagehide retries
          // it instead of silently dropping it.
          console.error("Failed to persist text document", error);
          ports.notify({ kind: "workingCopySaveFailed", error });
        });
    }, TEXT_SOURCE_SAVE_DEBOUNCE_MS);
    timers.set(tabId, timer);
  }

  /** Writes pending working copies now (one tab, or all). */
  async function flush(tabId?: string): Promise<void> {
    await drainPendingWrites({ pending, id: tabId, clearTimer, persist });
    reportPending();
  }

  const api = {
    schedule,

    /** A Markdown keystroke: the tab takes the text now, the copy follows. */
    edit(tabId: string, text: string): void {
      const tab = store.getState().tabs.find((entry) => entry.id === tabId);
      if (tab?.kind !== "markdown" || tab.text === text) return;
      store.getState().updateTab(tabId, (current) => ({
        ...current,
        text,
        // `size` is refreshed by the working-copy save. The file on disk
        // keeps the old text until the reader saves.
        textDirty: true,
        updatedAt: Date.now(),
      }));
      schedule(tabId, "markdown", tab.title, text);
    },

    flush,

    /** Forgets a closed tab's pending save. */
    discard(tabId: string): void {
      clearTimer(tabId);
      seqs.delete(tabId);
      pending.delete(tabId);
    },

    /**
     * Stops the timers. Sequence state stays: a flush that pagehide or the
     * native close handshake already started must still attach its copy.
     */
    dispose(): void {
      for (const timer of timers.values()) ports.timers.clear(timer);
      timers.clear();
    },

    /**
     * ⌘S: writes the tab's text over the file it was opened from. Explicit
     * and never on a timer — autosave already protects the edit, and silently
     * rewriting someone's file is not a decision to make for them.
     */
    saveToSource(tabId: string, options: { overwrite?: boolean } = {}): Promise<void> {
      const tab = store.getState().tabs.find((entry) => entry.id === tabId);
      if (!tab || (tab.kind !== "markdown" && tab.kind !== "html")) {
        return Promise.resolve();
      }
      const text = tab.text;
      if (text == null) return Promise.resolve();
      if (!tab.textDirty) {
        ports.notify({ kind: "savedNoChanges" });
        return Promise.resolve();
      }
      if (tab.textLossy) {
        // Not UTF-8: the text holds U+FFFD where the file has real bytes.
        ports.notify({ kind: "saveEncodingUnsupported", title: tab.title });
        return Promise.resolve();
      }
      const mime = tab.kind === "html" ? "text/html" : "text/markdown";
      const bytes = encodeTextDocument(text, tab.textBom);
      // Not awaited before the write: the browser grants File System Access
      // write permission only during the click's transient activation, which
      // an IndexedDB flush can outlive. The copy holds the same text anyway.
      void flush(tabId).catch(() => undefined);
      const target = ports.writeBack.target(tab.source);
      return enqueueWriteBack(async () => {
        const markSaved = async (overSource = false) => {
          const hash = await sha256Hex(bytes);
          store.getState().updateTab(tabId, (entry) => {
            const next = applyTextSourceWriteCompletion(entry, text, hash);
            // The file now holds these bytes, whatever was typed meanwhile.
            return overSource && next.sourceHash !== hash
              ? { ...next, sourceHash: hash }
              : next;
          });
        };
        const saveAs = async () => {
          const result = await ports.writeBack.saveAs(bytes, tab.title, mime);
          if (result.status !== "saved") return;
          await markSaved();
          ports.notify({ kind: "savedAs", path: result.path });
        };
        if (!target) {
          // On the web a dropped or cached document has no handle, so it is
          // downloaded. On desktop it is backed only by the workspace cache.
          if (ports.writeBack.requiresOrigin) {
            ports.notify({ kind: "saveOriginMissing", title: tab.title });
            return;
          }
          await saveAs();
          return;
        }
        try {
          // Read when the write runs, not when it was asked for: an earlier
          // save still in the queue moves it.
          const expected = store
            .getState()
            .tabs.find((entry) => entry.id === tabId)?.sourceHash;
          // An unknown baseline (edits restored from their working copy) can
          // vouch for no file, so it counts as changed. Still asked through
          // write: a browser without writable handles downloads instead.
          const unchanged = options.overwrite
            ? undefined
            : async (current: Uint8Array) =>
                expected !== undefined && (await sha256Hex(current)) === expected;
          const result = await ports.writeBack.write(
            target,
            textDocumentContents(text, tab.textBom),
            unchanged,
          );
          if (result.status === "written") {
            await markSaved(true);
            ports.notify({
              kind: "saved",
              name: target.kind === "desktopPath" ? target.path : tab.title,
            });
          } else if (result.status === "unsupported") {
            // Safari and Firefox implement only the read half of File System
            // Access. Not an error: save the other way.
            await saveAs();
          } else if (result.status === "changed") {
            // Another program (an editor, git) wrote the file since Shiori
            // read it. Replacing it silently would lose that version.
            ports.notify({
              kind: expected === undefined ? "saveSourceUnverified" : "saveSourceChanged",
              title: tab.title,
              overwrite: () => api.saveToSource(tabId, { overwrite: true }),
            });
          } else if (result.status === "permissionDenied") {
            ports.notify({ kind: "savePermissionDenied", title: tab.title });
          } else {
            ports.notify({ kind: "saveOriginMissing", title: tab.title });
          }
        } catch (error) {
          ports.notify({ kind: "saveFailed", title: tab.title, error });
        }
      });
    },
  };
  return api;
}

export type TextSources = ReturnType<typeof createTextSources>;
