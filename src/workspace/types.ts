import type { ExportedSnapshot } from "../editor/export/exportStatus";
import type { HistoryEntry } from "../editor/store/store";
import type { DocumentModel, Overlay, PageModel } from "../pdf/model/types";
import type { WorkspaceTabMeta } from "../storage/workspace";

export type PendingRestore = {
  file: File;
  hash: string;
  pages: PageModel[];
  fileSize: number;
  lastTouched: number;
  draftModelOverlays: Overlay[];
  draftModelPages: PageModel[];
  // Persisted undo history groups (oldest first) restored beneath the draft model
  // so undo keeps working past the restore point across sessions.
  draftHistory: HistoryEntry[];
  completedLiveOperationIds: string[];
};

export type DraftRestoreDecision = {
  mode: "pending" | "deferred";
  draft: PendingRestore;
};

// After a silent draft restore: what the status bar needs to offer "open the
// original instead". `originalModel` is the as-opened baseline (source pages +
// annotations imported from the PDF itself), captured before the draft was
// committed on top. `committedModel` is the store model right after that
// commit: the offer is only valid while the model still IS that object —
// once the user edits, the on-disk draft moves past this snapshot, and
// swapping to the baseline would silently drop those newer edits (the
// baseline is one Undo away by then anyway).
export type RestoredDraftNotice = {
  draft: PendingRestore;
  originalModel: DocumentModel;
  committedModel: DocumentModel;
};

export type WorkspaceRuntimeTab = WorkspaceTabMeta & {
  status: "loaded" | "unloaded" | "loading" | "suspended" | "unavailable";
  text?: string;
  /**
   * The file was not valid UTF-8, so `text` is a lossy reading of it
   * (src/workspace/textSources/textEncoding.ts). Shown read-only and never
   * written back. Runtime only: it is re-derived from the bytes on every open.
   */
  textLossy?: boolean;
  /**
   * The file began with a UTF-8 byte order mark, which `text` leaves out and
   * every encode puts back. Runtime only: the working copy keeps the mark, so
   * a restore re-derives it from the bytes.
   */
  textBom?: boolean;
  /**
   * Binary non-PDF documents (`docx`) live here instead of `text`. There is no
   * working copy and no save-back path for them yet, so these bytes are read
   * only — the viewer renders them and nothing writes them.
   */
  bytes?: Uint8Array;
  exportBaselineSnapshot?: string | null;
  /** Runtime-only export marker retained while the full editor store is suspended. */
  suspendedSnapshotKey?: string;
  lastExport?: ExportedSnapshot | null;
  draftRestore?: DraftRestoreDecision;
  restoredDraft?: RestoredDraftNotice;
  unavailableDetail?: string;
};
