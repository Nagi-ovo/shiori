import type { DraftSaveError } from "../../storage/drafts";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export type DraftSyncState = {
  status: SaveStatus;
  hash: string | null;
  lastTouched: number | null;
  error: string | null;
  errorKind: DraftSaveError["kind"] | null;
  usedBytes: number;
  realUsedBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
  // Cancel the debounce timer and synchronously flush the current model to
  // IndexedDB. Awaiting this before closing the document guarantees no
  // last-moment edits (within the 800ms debounce window) are lost.
  flushNow: () => Promise<void>;
  // Close/exit paths use the strict variant so a failed durable write keeps
  // the document and window alive. Normal autosave still reports through
  // `status`/`error` without creating unhandled promise rejections. A save
  // refused for another window's newer draft passes once `isExported` holds.
  flushNowOrThrow: () => Promise<void>;
  // The reader chose to drop the copy such a refusal left unsaved, so the
  // strict flush lets the blocked leave go on. False when no copy was refused.
  discardRefusedEdits: () => boolean;
  // A save of this copy was refused that way, and it is neither discarded nor
  // saved since: on the web, closing the tab asks first (useDraftPersistence).
  holdsRefusedEdits: boolean;
};
