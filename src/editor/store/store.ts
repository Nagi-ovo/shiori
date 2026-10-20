import { createContext, useContext } from "react";
import {
  create,
  useStore as useZustandStore,
  type StoreApi,
  type UseBoundStore,
} from "zustand";
import { nanoid } from "nanoid";
import type {
  DocumentModel,
  FontFamily,
  Overlay,
  PageModel,
  Rotation,
  ToolId,
} from "../../pdf/model/types";
import type { PdfDocument } from "../../pdf/engine/types";
import {
  copySelectedOverlays,
  pasteOverlays,
} from "../overlays/clipboard";
import {
  filterExistingCollapsedCalloutIds,
  filterExistingCollapsedNoteIds,
  MAX_COLLAPSED_NOTE_IDS,
  normalizeCollapsedNoteIds,
} from "../overlays/notePresentation";
import { pageOrigin } from "../../pdf/model/pageSpace";
import { NOTE_DEFAULT_COLOR } from "../../pdf/model/note";
import { CALLOUT_DEFAULT_COLOR } from "../../pdf/model/callout";
import type { SavedSignature } from "../../storage/signatures";
import type { ExternalTerminalId } from "../../platform/externalTerminal";
import { normalizeHexColor } from "../../design/color";
import {
  DEFAULT_MARKDOWN_APPEARANCE,
  normalizeMarkdownAppearance,
  normalizeRecentMarkdownFonts,
  type MarkdownAppearance,
  type MarkdownFontChoice,
} from "../../documents/markdownAppearance";
import {
  prepareLiveOverlayRevealBatch,
  prepareMountedOverlayRevealBatch,
  prefersReducedLiveOverlayMotion,
  startLiveOverlayRevealBatch,
  type LiveOverlayRevealBatch,
  type LiveOverlayRevealItem,
  type PreparedLiveOverlayRevealBatch,
} from "../../live/overlayReveal";
import { LIVE_OPERATION_RECEIPT_MAX } from "../../live/liveReceiptPolicy";
import { selectedOverlayActions } from "./selectedOverlayActions";

export type OpenedPdf = {
  fileName: string;
  fileSize: number;
  doc: PdfDocument;
  bytes: Uint8Array;
  sourcePages: PageModel[];
  // Filesystem path on Tauri (and only there); web opens never have one.
  // Used as the recents-list key for last-viewed-page persistence so the
  // same physical file resumes correctly even if a rename changes name.
  path?: string;
  // Browser File System Access handle ID. Web-only, stored separately in
  // IndexedDB so Recent Documents can reopen without a file picker when the
  // browser still has permission to the original file.
  webFileHandleId?: string;
  // App-local cached copy used on mobile and other runtimes where the
  // platform cannot promise a stable reopenable filesystem path.
  cacheId?: string;
  // Password used by the engine to reopen an encrypted PDF during this process.
  password?: string;
  // pdf-lib cannot decrypt/rebuild encrypted sources. The editor surfaces this
  // before the reader invests work instead of waiting for export to fail.
  encrypted?: boolean;
  // Draft row observed when this source opened. Clean-baseline autosave uses
  // this as a compare-and-delete token, preventing another browser tab's newer
  // row from being removed.
  draftVersion?: {
    lastTouched: number;
    revision: string | null;
  } | null;
};

export type OverlayBatchHistoryEntry = {
  kind: "overlay-batch";
  operationId: string;
  /** Immutable copies in JSON/spec order. `cursor` of them are applied. */
  overlays: Overlay[];
  cursor: number;
};

export type HistoryEntry = DocumentModel | OverlayBatchHistoryEntry;

export type PreparedDocumentCommit = {
  expectedModel: DocumentModel;
  expectedUndoStack: HistoryEntry[];
  expectedRedoStack: HistoryEntry[];
  model: DocumentModel;
  undoStack: HistoryEntry[];
};

export type PreparedCommitUi = {
  liveOverlayReveal?: PreparedLiveOverlayRevealBatch | null;
  selectedIds?: string[];
};

export type PreparedOverlayBatchCommit = {
  expectedModel: DocumentModel;
  expectedUndoStack: HistoryEntry[];
  expectedRedoStack: HistoryEntry[];
  expectedCompletedLiveOperationIds: ReadonlySet<string>;
  model: DocumentModel;
  undoStack: HistoryEntry[];
  completedLiveOperationIds: ReadonlySet<string>;
};
export type PrefsColorMode = "Auto" | "Light" | "Dark";
export type PrefsTheme = "Default" | "Everforest";
export type PrefsTerminalTheme = "Auto" | PrefsTheme;
export type PrefsExternalTerminalId = ExternalTerminalId;
export type PrefsMargin = "Tight" | "Comfortable" | "Roomy";
export type RemoteImagePolicy = "ask" | "always" | "never";
export type RailTab = "outline" | "comments" | "terminal" | "browser";

// Zoom fit behavior. "width" re-derives scale so the widest page fills the
// viewport width; "none" is a fixed manual scale (e.g. actual size = 1).
// "width" recomputes on container resize; "none" does not.
//
// A third mode, "page" (fit the largest page entirely, width AND height),
// was removed: it earned two toolbar buttons and a menu item for a fit that
// leaves a reader zoomed too far out to read on any normal display, and
// "width" plus a manual zoom covers the same ground. Persisted tabs that
// still carry it are migrated to "width" on load — see storage/workspace.ts.
export type FitMode = "width" | "none";
export type PrefsPdfPaperTone = "Original" | "Everforest" | "Custom";

// Embedded Browser panel state. The actual web content lives in a native
// child webview owned by Rust (see src-tauri); this is only the chrome
// state the React address bar / nav buttons render. Rust pushes nav-state
// updates here via the `web-panel-nav` event; the UI never mutates `url`
// optimistically except when initiating an explicit open.
export type WebPanelState = {
  url: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
};

export type Prefs = {
  colorMode: PrefsColorMode;
  theme: PrefsTheme;
  accentColor: string | null;
  terminalColorMode: PrefsColorMode;
  terminalTheme: PrefsTerminalTheme;
  preferredExternalTerminalId: PrefsExternalTerminalId | null;
  serifAccents: boolean;
  pageMargin: PrefsMargin;
  pdfPaperTone: PrefsPdfPaperTone;
  pdfPaperCustomColor: string;
  preRenderThumbs: boolean;
  /**
   * The left navigator (documents / pages). A pref, not per-tab view state
   * like `showThumbs`: a navigator that forgot whether it was open every
   * launch would be a navigator nobody keeps open.
   *
   * `showThumbs` still drives the MOBILE thumbnails drawer, which the
   * navigator does not replace — the gutter it needs does not exist on a
   * phone.
   */
  showNavigator: boolean;
  navigatorView: "documents" | "outline" | "pages" | "marks";
  /** Gutter width in px, dragged by the reader. Clamped on read. */
  navigatorWidth: number;
  remoteImagePolicy: RemoteImagePolicy;
  browserPersistSession: boolean;
  /** Animate annotation creation/replay in every supported PDF workflow. */
  annotationAnimations: boolean;
  /** Show callout follow-up only when a supported local agent CLI is present. */
  showCalloutFollowUp: boolean;
  markdownAppearance: MarkdownAppearance;
  recentMarkdownFonts: MarkdownFontChoice[];
  // Most-recently used annotation colors, newest first. Shared across
  // the expandable color pickers on text / ink / rect so users don't
  // have to re-pick a custom hex every time.
  recentColors: string[];
  lastSeenChangelogVersion?: string;
};

const RECENT_COLORS_MAX = 6;

export type ErrorInfo = {
  title: string;
  file: string;
  message: string;
  code?: string;
  diagnosticReport?: string;
};

export type HistoryFeedback = {
  kind: "undo" | "redo";
  at: number;
};

export type PageJump = {
  pageId: string;
  index: number;
  offsetY: number | null;
};

export type AnnotationDefaults = {
  textMarkupTool: "highlight" | "underline" | "strikethrough";
  highlightColor: string;
  highlightOpacity: number;
  underlineColor: string;
  underlineOpacity: number;
  strikethroughColor: string;
  strikethroughOpacity: number;
  inkColor: string;
  inkWidth: number;
  stampKind: "check" | "cross";
  stampColor: string;
  stampStrokeWidth: number;
  rectColor: string;
  rectStrokeWidth: number;
  rectFill: string | null;
  noteColor: string;
  calloutColor: string;
};

type State = {
  opened: OpenedPdf | null;
  model: DocumentModel;
  tool: ToolId;
  scale: number;
  fitMode: FitMode;
  selectedIds: string[];
  activePageId: string | null;
  pageJump: PageJump | null;
  outlineSelection: { pageId: string; pdfTop: number } | null;
  searchMatchHighlight: { pageId: string; charStart: number; charEnd: number } | null;
  overlayClipboard: Overlay[];
  editingOverlayId: string | null;
  // Per-document presentation only. Collapsing a note or a callout must never
  // dirty the PDF, enter Undo history, or affect exports.
  collapsedNoteIds: string[];
  collapsedCalloutIds: string[];
  // Callout ids whose conversation panel is folded to its summary line. Same
  // presentation-only contract: the turns stay in the document either way.
  collapsedThreadIds: string[];
  historyFeedback: HistoryFeedback | null;
  // Presentation-only Live CLI reveal receipts. Absolute timestamps prevent
  // Virtuoso remounts from replaying completed animation. Never persisted.
  liveOverlayReveals: LiveOverlayRevealBatch[];
  // Reveal intents wait here until their overlay page actually mounts. This
  // keeps virtualized/offscreen pages from consuming an absolute timeline
  // before the user can see it. Consumed once per document session.
  pendingOverlayReveals: ReadonlyMap<string, LiveOverlayRevealItem>;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  /** Idempotency receipts outlive overlays: Undo must never make a lost-response
   * retry look like a new logical operation. Scoped to the open PDF/draft. */
  completedLiveOperationIds: ReadonlySet<string>;
  // Normalized /BaseFont name → the FontFace family the engine loaded for it
  // THIS session ("EBGaramond-Regular" → "shiori-pdf-…"). Session-scoped and
  // never persisted: a family only names a face while that face is loaded.
  // Lets contentText edit boxes render in the document's own embedded font.
  pdfFontFaces: Record<string, string>;
  // Characters seen rendered in each font across visited pages — a cheap
  // proxy for the (subset) font's glyph coverage. Drives the "this
  // character may not exist in the source font" edit warning; the exact
  // oracle (inverted /ToUnicode) lives on the export path.
  pdfFontChars: Record<string, ReadonlySet<string>>;
  textDefaults: {
    fontSize: number;
    color: string;
    bold: boolean;
    italic: boolean;
    align: "left" | "center" | "right";
    fontFamily: FontFamily;
  };
  showThumbs: boolean;
  // Distraction-free reading: hides TopBar / ContextualToolbar /
  // StatusBar so the canvas takes the entire window. Drawers, modals,
  // and overlays still surface normally — only the persistent chrome
  // collapses. A small floating exit affordance comes back via
  // `App.tsx` while reader mode is active.
  readerMode: boolean;
  // Phones split reading from annotating: reading is the default and gives
  // the tool grid's ~85px back to the document, annotation mode floats the
  // grid over it. Leaving the mode pins the tool back to `select`, which is
  // what keeps select-text-then-mark working while reading — see
  // setAnnotationMode. Desktop and tablets never leave this false: their
  // toolbar has the room for the grid at all times.
  annotationMode: boolean;
};

type AppState = {
  // True while a chrome pane (right rail, navigator) is being drag-resized.
  // Expensive layout reactions (fit-scale recompute, canvas re-measure)
  // hold their fire until it flips back to false. Never persisted.
  chromeResizing: boolean;
  activeSignature: SavedSignature | null;
  annotDefaults: AnnotationDefaults;
  showRail: boolean;
  railTab: RailTab;
  webPanel: WebPanelState;
  // Imperative "navigate the native panel here" command, decoupled from
  // the display `webPanel.url` so Rust echoing the committed URL back never
  // re-triggers a navigation. The Browser panel serves the latest nonce.
  webPanelRequest: { url: string; nonce: number } | null;
  showExport: boolean;
  showSettings: boolean;
  showShortcuts: boolean;
  showGoToPage: boolean;
  showFind: boolean;
  isPrinting: boolean;
  showBetaDisclaimer: boolean;
  prefs: Prefs;
  errorInfo: ErrorInfo | null;
};

type Actions = {
  setOpened: (
    opened: Omit<OpenedPdf, "sourcePages">,
    pages: PageModel[],
    initialModel?: DocumentModel,
    options?: {
      initialPageIndex?: number;
      showThumbs?: boolean;
      readerMode?: boolean;
      completedLiveOperationIds?: Iterable<string>;
      initialOverlayReveal?: PreparedLiveOverlayRevealBatch | null;
      /**
       * Replace the physical PDF/runtime without severing the model timeline.
       * Safe only when every sourceIndex reachable from history still names the
       * same physical page in `pages`; page merges achieve that by appending
       * physical pages rather than inserting/rebuilding the base bytes.
       */
      preserveHistory?: boolean;
    },
  ) => void;
  activatePendingOverlayReveals: (overlayIds: readonly string[]) => void;
  closeDocument: () => void;
  setTool: (tool: ToolId) => void;
  setScale: (scale: number) => void;
  setScaleKeepFit: (scale: number) => void;
  setFitMode: (mode: FitMode) => void;
  setActivePage: (id: string | null) => void;
  goToPage: (pageId: string, index: number, offsetY?: number | null) => void;
  consumePageJump: (jump: PageJump) => void;
  setOutlineSelection: (
    selection: { pageId: string; pdfTop: number } | null,
  ) => void;
  setSearchMatchHighlight: (
    highlight: { pageId: string; charStart: number; charEnd: number } | null,
  ) => void;
  selectOnly: (id: string | null) => void;
  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  setEditingOverlayId: (id: string | null) => void;
  setNoteCollapsed: (id: string, collapsed: boolean) => void;
  setCollapsedNoteIds: (ids: string[]) => void;
  toggleNoteCollapsed: (id: string) => void;
  setCalloutCollapsed: (id: string, collapsed: boolean) => void;
  setThreadCollapsed: (id: string, collapsed: boolean) => void;
  setCollapsedCalloutIds: (ids: string[]) => void;
  toggleCalloutCollapsed: (id: string) => void;
  selectAllOnPage: (pageId: string | null) => void;

  commit: (next: Partial<DocumentModel>) => void;
  prepareCommit: (next: Partial<DocumentModel>) => PreparedDocumentCommit;
  commitPrepared: (
    prepared: PreparedDocumentCommit,
    ui?: PreparedCommitUi,
  ) => boolean;
  prepareOverlayBatchCommit: (
    overlays: Overlay[],
    operationId: string,
  ) => PreparedOverlayBatchCommit;
  commitPreparedOverlayBatch: (
    prepared: PreparedOverlayBatchCommit,
    ui?: PreparedCommitUi,
  ) => boolean;
  // Like commit, but seeds `history` (persisted undo snapshots from a restored
  // draft, oldest first) as the immediate undo targets, so stepping back walks
  // the draft's own edit timeline across sessions before reaching this
  // session's pre-restore state when both page topologies are compatible.
  commitRestoredDraft: (
    next: Partial<DocumentModel>,
    history: HistoryEntry[],
    completedLiveOperationIds?: Iterable<string>,
  ) => void;
  // Swap the document back to a pristine baseline (the as-opened model) with
  // fresh history, as if the file had just been opened. Used by "open the
  // original" after a silent draft restore: the set-aside draft stays on disk,
  // so this must NOT leave the draft state reachable via Undo — an undo into
  // the draft would immediately re-raise the overwrite conflict.
  restoreBaselineModel: (model: DocumentModel) => void;
  undo: () => void;
  redo: () => void;

  // Explicit history control for multi-step interactions (drag, resize).
  // Call beginHistoryStep() once at the start, then use *NoHistory mutators
  // during the interaction — the single snapshot captures the entire edit.
  beginHistoryStep: () => void;

  addOverlay: (o: Overlay) => void;
  addOverlayNoHistory: (o: Overlay) => void;
  updateOverlay: (id: string, patch: Partial<Overlay>) => void;
  updateOverlayNoHistory: (id: string, patch: Partial<Overlay>) => void;
  removeOverlay: (id: string) => void;
  removeSelected: () => void;
  duplicateSelected: () => void;
  copySelected: () => void;
  pasteClipboard: (pageId: string | null) => void;
  nudgeSelected: (dxDisplayPt: number, dyDisplayPt: number) => void;
  nudgeSelectedNoHistory: (dxDisplayPt: number, dyDisplayPt: number) => void;
  setSelectedLocked: (locked: boolean) => void;

  movePage: (fromIndex: number, toIndex: number) => void;
  deletePage: (id: string) => void;
  rotatePage: (id: string, delta: 90 | -90) => void;
  duplicatePage: (id: string) => void;
  insertBlankPage: (afterPageId: string | null) => void;

  setTextDefaults: (patch: Partial<State["textDefaults"]>) => void;

  setShowThumbs: (v: boolean) => void;
  toggleThumbs: () => void;
  setReaderMode: (v: boolean) => void;
  toggleReaderMode: () => void;
  setAnnotationMode: (v: boolean) => void;
  registerPdfFontFaces: (
    entries: Array<{ baseFontName: string; faceFamily: string; chars?: string }>,
  ) => void;
};

type AppActions = {
  setChromeResizing: (resizing: boolean) => void;
  setActiveSignature: (signature: SavedSignature | null) => void;
  setAnnotDefaults: (patch: Partial<AnnotationDefaults>) => void;
  setShowRail: (v: boolean) => void;
  toggleRail: () => void;
  setRailTab: (t: RailTab) => void;
  // Open `url` in the embedded Browser panel: reveal the rail, switch to
  // the browser tab, and reset nav-state for the fresh load. The native
  // navigation itself is triggered by the caller via the platform layer.
  openBrowserPanel: (url: string) => void;
  setWebPanel: (patch: Partial<WebPanelState>) => void;
  resetWebPanel: () => void;
  setShowExport: (v: boolean) => void;
  setShowSettings: (v: boolean) => void;
  setShowShortcuts: (v: boolean) => void;
  setShowGoToPage: (v: boolean) => void;
  setShowFind: (v: boolean) => void;
  setIsPrinting: (v: boolean) => void;
  setShowBetaDisclaimer: (v: boolean) => void;
  acknowledgeBetaDisclaimer: () => void;
  setPrefs: (patch: Partial<Prefs>) => void;
  pushRecentColor: (hex: string) => void;
  setError: (info: ErrorInfo | null) => void;
};

export type Store = State & Actions;
export type AppStore = AppState & AppActions;
export type PdfEditorStoreApi = UseBoundStore<StoreApi<Store>>;
export type AppStoreApi = UseBoundStore<StoreApi<AppStore>>;

export type PdfEditorSessionState = {
  opened: OpenedPdf;
  model: DocumentModel;
  tool: ToolId;
  scale: number;
  fitMode: FitMode;
  selectedIds: string[];
  activePageId: string | null;
  outlineSelection: State["outlineSelection"];
  searchMatchHighlight: State["searchMatchHighlight"];
  overlayClipboard: Overlay[];
  editingOverlayId: string | null;
  collapsedNoteIds: string[];
  collapsedCalloutIds: string[];
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  completedLiveOperationIds: ReadonlySet<string>;
  pendingOverlayReveals: ReadonlyMap<string, LiveOverlayRevealItem>;
  showThumbs: boolean;
  readerMode: boolean;
};

function isEmptyEditingOverlay(overlay: Overlay): boolean {
  if (
    overlay.type === "text" ||
    overlay.type === "note" ||
    overlay.type === "callout"
  ) {
    return overlay.text.trim() === "";
  }
  if (overlay.type === "contentText") {
    return overlay.text.trim() === "" || overlay.text === overlay.originalText;
  }
  return false;
}

function isOverlayBatchHistoryEntry(
  entry: HistoryEntry,
): entry is OverlayBatchHistoryEntry {
  return "kind" in entry && entry.kind === "overlay-batch";
}

function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  if (!isOverlayBatchHistoryEntry(entry)) return cloneModel(entry);
  return {
    ...entry,
    overlays: cloneOverlays(entry.overlays),
  };
}

function hasSamePageSourceTopology(
  left: readonly PageModel[],
  right: readonly PageModel[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((page, index) => {
    const other = right[index];
    if (!other) return false;
    const pageIsBlank = page.blank === true || page.sourceIndex < 0;
    const otherIsBlank = other.blank === true || other.sourceIndex < 0;
    return (
      pageIsBlank === otherIsBlank &&
      (pageIsBlank || page.sourceIndex === other.sourceIndex)
    );
  });
}

function canJoinPreRestoreHistory(
  snapshot: DocumentModel,
  restored: DocumentModel,
  history: readonly HistoryEntry[],
): boolean {
  // History can be empty either because this is a legacy draft or because its
  // newest snapshot exceeded the persistence byte budget. Only a matching
  // source topology proves that the freshly opened model is a real older
  // state; otherwise Undo could expose physical append order as user history.
  if (history.length === 0) {
    return hasSamePageSourceTopology(snapshot.pages, restored.pages);
  }
  const oldestSnapshot = history.find(
    (entry): entry is DocumentModel => !isOverlayBatchHistoryEntry(entry),
  );
  // A compact overlay batch does not carry pages and cannot change their
  // order, so the restored model is its page-topology anchor.
  const pageTimelineAnchor = oldestSnapshot ?? restored;
  return hasSamePageSourceTopology(
    snapshot.pages,
    pageTimelineAnchor.pages,
  );
}

function selectedIdsPresentInModel(
  selectedIds: string[],
  model: DocumentModel,
): string[] {
  if (selectedIds.length === 0) return selectedIds;
  const existing = new Set(model.overlays.map((overlay) => overlay.id));
  return selectedIds.filter((id) => existing.has(id));
}

function activePageIdAfterPageReplacement(
  activePageId: string | null,
  previousPages: PageModel[],
  nextPages: PageModel[],
): string | null {
  if (activePageId && nextPages.some((page) => page.id === activePageId)) {
    return activePageId;
  }
  const previousIndex = previousPages.findIndex(
    (page) => page.id === activePageId,
  );
  const previousPage = previousPages[previousIndex];
  if (previousPage) {
    const sameSourcePages = nextPages.filter(
      (page) =>
        page.sourceIndex === previousPage.sourceIndex &&
        Boolean(page.blank) === Boolean(previousPage.blank),
    );
    const sourceOccurrence = previousPages
      .slice(0, previousIndex + 1)
      .filter(
        (page) =>
          page.sourceIndex === previousPage.sourceIndex &&
          Boolean(page.blank) === Boolean(previousPage.blank),
      ).length;
    const sameSourcePage =
      sameSourcePages[Math.min(sourceOccurrence - 1, sameSourcePages.length - 1)];
    if (sameSourcePage) return sameSourcePage.id;
  }
  const fallbackIndex = Math.max(
    0,
    Math.min(previousIndex, nextPages.length - 1),
  );
  return nextPages[fallbackIndex]?.id ?? null;
}

function startPreparedLiveReveal(
  activeReveals: readonly LiveOverlayRevealBatch[],
  ui?: PreparedCommitUi,
): {
  retainedReveals: LiveOverlayRevealBatch[];
  startedReveal: LiveOverlayRevealBatch | null;
} {
  const preparedReveal = ui?.liveOverlayReveal;
  if (!preparedReveal) {
    return {
      retainedReveals: [...activeReveals],
      startedReveal: null,
    };
  }
  const now = Date.now();
  let retainedReveals = activeReveals.filter(
    (reveal) => reveal.endsAtMs > now,
  );
  const lastReveal = retainedReveals.at(-1);
  let startedAtMs = Math.max(
    now + 16,
    lastReveal ? lastReveal.endsAtMs + 36 : 0,
  );
  // Backpressure is deliberately presentation-only. Normal Agent calls stay
  // strictly sequential across batches. If a burst would push the visible
  // queue beyond 45 seconds, finish the older paint immediately and give the
  // newest call a fresh human-paced window instead of accumulating minutes of
  // stale animation. The annotations/history themselves are already atomic.
  const queueHorizonMs = now + 45_000;
  if (startedAtMs + preparedReveal.totalDurationMs > queueHorizonMs) {
    retainedReveals = [];
    startedAtMs = now + 16;
  }
  const startedReveal = startLiveOverlayRevealBatch(
    preparedReveal,
    startedAtMs,
  );
  return { retainedReveals, startedReveal };
}

function scheduleLiveRevealCleanup(
  reveal: LiveOverlayRevealBatch | null,
  remove: (batchId: string) => void,
): void {
  if (!reveal || typeof globalThis.setTimeout !== "function") return;
  const delayMs = Math.max(0, reveal.endsAtMs - Date.now() + 80);
  globalThis.setTimeout(() => remove(reveal.id), delayMs);
}

function modelsEqual(a: DocumentModel, b: DocumentModel): boolean {
  if (a.pages.length !== b.pages.length || a.overlays.length !== b.overlays.length) {
    return false;
  }
  for (let i = 0; i < a.pages.length; i += 1) {
    const left = a.pages[i]!;
    const right = b.pages[i]!;
    if (
      left.id !== right.id ||
      left.sourceIndex !== right.sourceIndex ||
      left.rotation !== right.rotation ||
      pageOrigin(left).x !== pageOrigin(right).x ||
      pageOrigin(left).y !== pageOrigin(right).y ||
      left.widthPt !== right.widthPt ||
      left.heightPt !== right.heightPt ||
      left.blank !== right.blank
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.overlays.length; i += 1) {
    if (JSON.stringify(a.overlays[i]) !== JSON.stringify(b.overlays[i])) {
      return false;
    }
  }
  return true;
}

function clearEditingOverlay(state: Store): Partial<State> {
  const editingId = state.editingOverlayId;
  if (!editingId) return { editingOverlayId: null };
  const editingOverlay = state.model.overlays.find((o) => o.id === editingId);
  if (!editingOverlay || !isEmptyEditingOverlay(editingOverlay)) {
    return { editingOverlayId: null };
  }
  const nextModel = {
    pages: state.model.pages,
    overlays: state.model.overlays.filter((o) => o.id !== editingId),
  };
  const undoTop = state.undoStack[state.undoStack.length - 1];
  const undoStack =
    undoTop && !isOverlayBatchHistoryEntry(undoTop) && modelsEqual(undoTop, nextModel)
      ? state.undoStack.slice(0, -1)
      : state.undoStack;
  return {
    model: nextModel,
    selectedIds: state.selectedIds.filter((id) => id !== editingId),
    editingOverlayId: null,
    undoStack,
  };
}

const INIT_MODEL: DocumentModel = { pages: [], overlays: [] };

const PREFS_KEY = "shiori:prefs:v1";
const ANNOT_DEFAULTS_KEY = "shiori:annot-defaults:v1";
const BETA_DISCLAIMER_KEY = "shiori:beta-disclaimer:v1";
let webPanelRequestNonce = 0;

function loadBetaDisclaimerPending(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(BETA_DISCLAIMER_KEY) !== "acknowledged";
  } catch {
    return true;
  }
}

function saveBetaDisclaimerAcknowledged() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(BETA_DISCLAIMER_KEY, "acknowledged");
  } catch {
    // ignore
  }
}

const DEFAULT_PREFS: Prefs = {
  colorMode: "Light",
  theme: "Default",
  accentColor: null,
  terminalColorMode: "Auto",
  terminalTheme: "Auto",
  preferredExternalTerminalId: null,
  serifAccents: true,
  pageMargin: "Comfortable",
  pdfPaperTone: "Original",
  pdfPaperCustomColor: "#efebd4",
  preRenderThumbs: true,
  showNavigator: false,
  navigatorView: "pages",
  navigatorWidth: 236,
  remoteImagePolicy: "ask",
  browserPersistSession: true,
  annotationAnimations: true,
  showCalloutFollowUp: true,
  markdownAppearance: { ...DEFAULT_MARKDOWN_APPEARANCE },
  recentMarkdownFonts: [],
  recentColors: [],
};

const DEFAULT_ANNOT_DEFAULTS: AnnotationDefaults = {
  textMarkupTool: "highlight",
  highlightColor: "#f4d674",
  highlightOpacity: 0.45,
  underlineColor: "#b13a2e",
  underlineOpacity: 1,
  strikethroughColor: "#b13a2e",
  strikethroughOpacity: 1,
  inkColor: "#b13a2e",
  inkWidth: 2,
  stampKind: "check",
  stampColor: "#1a1815",
  stampStrokeWidth: 1.8,
  rectColor: "#b13a2e",
  rectStrokeWidth: 2,
  rectFill: null,
  noteColor: NOTE_DEFAULT_COLOR,
  calloutColor: CALLOUT_DEFAULT_COLOR,
};

function loadPrefs(): Prefs {
  if (typeof localStorage === "undefined") return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs> & {
      markdownHeadingColor?: unknown;
      /** v1 compatibility: this setting used to apply only to Live CLI. */
      liveOverlayAnimations?: unknown;
    };
    const prefs = { ...DEFAULT_PREFS, ...parsed };
    const legacyTheme = migrateLegacyTheme(parsed.theme);
    const legacyTerminalTheme = migrateLegacyTerminalTheme(parsed.terminalTheme);
    return {
      ...prefs,
      colorMode: isPrefsColorMode(parsed.colorMode)
        ? parsed.colorMode
        : legacyTheme.colorMode,
      theme: isPrefsTheme(parsed.theme) ? parsed.theme : legacyTheme.theme,
      accentColor: normalizeAccentColor(parsed.accentColor),
      terminalColorMode: isPrefsColorMode(parsed.terminalColorMode)
        ? parsed.terminalColorMode
        : legacyTerminalTheme.terminalColorMode,
      terminalTheme: isPrefsTerminalTheme(parsed.terminalTheme)
        ? parsed.terminalTheme
        : legacyTerminalTheme.terminalTheme,
      preferredExternalTerminalId: isPrefsExternalTerminalId(
        parsed.preferredExternalTerminalId,
      )
        ? parsed.preferredExternalTerminalId
        : null,
      pdfPaperTone: isPrefsPdfPaperTone(parsed.pdfPaperTone)
        ? parsed.pdfPaperTone
        : DEFAULT_PREFS.pdfPaperTone,
      pdfPaperCustomColor:
        normalizeHexColor(parsed.pdfPaperCustomColor) ??
        DEFAULT_PREFS.pdfPaperCustomColor,
      remoteImagePolicy: isRemoteImagePolicy(parsed.remoteImagePolicy)
        ? parsed.remoteImagePolicy
        : DEFAULT_PREFS.remoteImagePolicy,
      browserPersistSession:
        typeof parsed.browserPersistSession === "boolean"
          ? parsed.browserPersistSession
          : DEFAULT_PREFS.browserPersistSession,
      annotationAnimations:
        typeof parsed.annotationAnimations === "boolean"
          ? parsed.annotationAnimations
          : typeof parsed.liveOverlayAnimations === "boolean"
            ? parsed.liveOverlayAnimations
            : DEFAULT_PREFS.annotationAnimations,
      showCalloutFollowUp:
        typeof parsed.showCalloutFollowUp === "boolean"
          ? parsed.showCalloutFollowUp
          : DEFAULT_PREFS.showCalloutFollowUp,
      markdownAppearance: normalizeStoredMarkdownAppearance(
        parsed.markdownAppearance,
        parsed.markdownHeadingColor,
      ),
      recentMarkdownFonts: normalizeRecentMarkdownFonts(
        parsed.recentMarkdownFonts,
      ),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function normalizeAccentColor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return normalizeHexColor(value);
}

function normalizeStoredMarkdownAppearance(
  value: unknown,
  legacyHeadingColor: unknown,
): MarkdownAppearance {
  const appearance = normalizeMarkdownAppearance(value);
  const hasNestedHeadingColor =
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "headingColor");
  if (hasNestedHeadingColor) return appearance;
  const migrated = normalizeHexColor(legacyHeadingColor);
  return migrated ? { ...appearance, headingColor: migrated } : appearance;
}

function migrateLegacyTheme(value: unknown): Pick<Prefs, "colorMode" | "theme"> {
  if (value === "Auto") return { colorMode: "Auto", theme: "Default" };
  if (value === "Paper") return { colorMode: "Light", theme: "Default" };
  if (value === "Night") return { colorMode: "Dark", theme: "Default" };
  if (value === "Everforest") return { colorMode: "Auto", theme: "Everforest" };
  return { colorMode: DEFAULT_PREFS.colorMode, theme: DEFAULT_PREFS.theme };
}

function migrateLegacyTerminalTheme(
  value: unknown,
): Pick<Prefs, "terminalColorMode" | "terminalTheme"> {
  if (value === "Paper") return { terminalColorMode: "Light", terminalTheme: "Default" };
  if (value === "Night") return { terminalColorMode: "Dark", terminalTheme: "Default" };
  if (value === "Everforest") return { terminalColorMode: "Auto", terminalTheme: "Everforest" };
  if (value === "Auto") return { terminalColorMode: "Auto", terminalTheme: "Auto" };
  return {
    terminalColorMode: DEFAULT_PREFS.terminalColorMode,
    terminalTheme: DEFAULT_PREFS.terminalTheme,
  };
}

function isPrefsColorMode(value: unknown): value is PrefsColorMode {
  return value === "Auto" || value === "Light" || value === "Dark";
}

function isPrefsTheme(value: unknown): value is PrefsTheme {
  return value === "Default" || value === "Everforest";
}

function isPrefsPdfPaperTone(value: unknown): value is PrefsPdfPaperTone {
  return value === "Original" || value === "Everforest" || value === "Custom";
}

function isPrefsTerminalTheme(value: unknown): value is PrefsTerminalTheme {
  return value === "Auto" || isPrefsTheme(value);
}

function isRemoteImagePolicy(value: unknown): value is RemoteImagePolicy {
  return value === "ask" || value === "always" || value === "never";
}

function isPrefsExternalTerminalId(
  value: unknown,
): value is PrefsExternalTerminalId {
  return (
    value === "terminal" ||
    value === "ghostty" ||
    value === "iterm2" ||
    value === "wezterm" ||
    value === "windowsTerminal" ||
    value === "systemTerminal"
  );
}

// Exposed for main.tsx — needed to prime CSS variables synchronously
// before the first paint, so the app doesn't flash with unresolved
// `var(--opx-*)` references.
export function loadInitialPrefs(): Prefs {
  return loadPrefs();
}

function savePrefs(p: Prefs) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

function loadAnnotDefaults(): AnnotationDefaults {
  if (typeof localStorage === "undefined") return DEFAULT_ANNOT_DEFAULTS;
  try {
    const raw = localStorage.getItem(ANNOT_DEFAULTS_KEY);
    if (!raw) return DEFAULT_ANNOT_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AnnotationDefaults>;
    return { ...DEFAULT_ANNOT_DEFAULTS, ...parsed };
  } catch {
    return DEFAULT_ANNOT_DEFAULTS;
  }
}

function saveAnnotDefaults(defaults: AnnotationDefaults) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      ANNOT_DEFAULTS_KEY,
      JSON.stringify({
        textMarkupTool: defaults.textMarkupTool,
        highlightColor: defaults.highlightColor,
        underlineColor: defaults.underlineColor,
        strikethroughColor: defaults.strikethroughColor,
        inkColor: defaults.inkColor,
        noteColor: defaults.noteColor,
        calloutColor: defaults.calloutColor,
        rectFill: defaults.rectFill,
      } satisfies Partial<AnnotationDefaults>),
    );
  } catch {
    // ignore
  }
}

const EDITOR_INIT_STATE: State = {
  opened: null,
  model: INIT_MODEL,
  tool: "select",
  scale: 1,
  fitMode: "width",
  selectedIds: [],
  activePageId: null,
  pageJump: null,
  outlineSelection: null,
  searchMatchHighlight: null,
  overlayClipboard: [],
  editingOverlayId: null,
  collapsedNoteIds: [],
  collapsedCalloutIds: [],
  collapsedThreadIds: [],
  historyFeedback: null,
  liveOverlayReveals: [],
  pendingOverlayReveals: new Map<string, LiveOverlayRevealItem>(),
  undoStack: [],
  redoStack: [],
  completedLiveOperationIds: new Set<string>(),
  pdfFontFaces: {},
  pdfFontChars: {},
  textDefaults: {
    fontSize: 14,
    // Must stay the first entry of the text tool's swatch row in
    // ContextualToolbar — the picker only draws a selection ring on a colour
    // that is present in the row, so a default outside it showed the Text
    // tool with four blank circles and no indication of what it would write.
    // The vintage-stationery retune moved the row to #2b2620 and left this
    // behind at #1a1815; the two are indistinguishable at 22px.
    color: "#2b2620",
    bold: false,
    italic: false,
    align: "left",
    fontFamily: "sans",
  },
  showThumbs: true,
  readerMode: false,
  annotationMode: false,
};

const APP_INIT_STATE: AppState = {
  chromeResizing: false,
  activeSignature: null,
  annotDefaults: loadAnnotDefaults(),
  showRail: false,
  railTab: "outline",
  webPanel: {
    url: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  },
  webPanelRequest: null,
  showExport: false,
  showSettings: false,
  showShortcuts: false,
  showGoToPage: false,
  showFind: false,
  isPrinting: false,
  showBetaDisclaimer: loadBetaDisclaimerPending(),
  prefs: loadPrefs(),
  errorInfo: null,
};

function cloneModel(m: DocumentModel): DocumentModel {
  return {
    pages: m.pages, // immutable; shared
    overlays: m.overlays.map((o) => ({
      ...o,
      ...("rect" in o ? { rect: { ...o.rect } } : null),
      ...("rects" in o ? { rects: o.rects.map((r) => ({ ...r })) } : null),
      ...("targetRects" in o
        ? { targetRects: o.targetRects.map((r) => ({ ...r })) }
        : null),
      ...("leader" in o && o.leader
        ? { leader: o.leader.map((point) => ({ ...point })) }
        : null),
      ...("coverRects" in o
        ? { coverRects: o.coverRects.map((r) => ({ ...r })) }
        : null),
      ...("paths" in o
        ? { paths: o.paths.map((path) => path.map((pt) => ({ ...pt }))) }
        : null),
      ...("thread" in o && o.thread
        ? { thread: o.thread.map((entry) => ({ ...entry })) }
        : null),
    })) as Overlay[],
  };
}

function normalizeRotation(r: number): Rotation {
  const mod = ((r % 360) + 360) % 360;
  return mod as Rotation;
}

/**
 * Apply a patch and record that the reader touched this annotation.
 *
 * Only notes carry an updatedAt of their own, so editing a callout's or a
 * text overlay's body left no evidence at all — an imported annotation the
 * reader had just rewritten still looked like untouched imported content to
 * anything ranking by recency, and was dropped first when a budget was
 * tight. Stamped here rather than at each call site because every overlay
 * mutation in the app funnels through these two.
 */
function withLocalActivity(overlay: Overlay, patch: Partial<Overlay>): Overlay {
  return { ...overlay, ...patch, localActivityAt: Date.now() } as Overlay;
}

export function createPdfEditorStore(): PdfEditorStoreApi {
  return create<Store>((set, get) => ({
    ...EDITOR_INIT_STATE,

  setOpened: (opened, pages, initialModel, options) => {
    const current = get();
    if (options?.preserveHistory) {
      if (!current.opened || initialModel !== current.model) {
        throw new Error(
          "preserveHistory requires the live model from the currently opened PDF",
        );
      }
      if (pages.length < current.opened.sourcePages.length) {
        throw new Error(
          "preserveHistory cannot remove physical pages reachable from history",
        );
      }
    }
    const model = initialModel
      ? cloneModel(initialModel)
      : { pages: pages.map((page) => ({ ...page })), overlays: [] };
    const initialPageIndex =
      options?.initialPageIndex !== undefined
        ? Math.max(
            0,
            Math.min(options.initialPageIndex, Math.max(0, model.pages.length - 1)),
          )
        : 0;
    const pendingOverlayReveals = new Map(
      options?.initialOverlayReveal?.itemsById ?? [],
    );
    set({
      opened: { ...opened, sourcePages: pages.map((page) => ({ ...page })) },
      model,
      ...(options?.preserveHistory
        ? {}
        : {
            undoStack: [],
            redoStack: [],
          }),
      ...(options?.preserveHistory && options.completedLiveOperationIds === undefined
        ? {}
        : {
            completedLiveOperationIds: new Set(
              options?.completedLiveOperationIds ?? [],
            ),
          }),
      selectedIds: [],
      liveOverlayReveals: [],
      pendingOverlayReveals,
      editingOverlayId: null,
      collapsedNoteIds: [],
      collapsedCalloutIds: [],
      collapsedThreadIds: [],
      activePageId: model.pages[initialPageIndex]?.id ?? model.pages[0]?.id ?? null,
      pageJump: null,
      outlineSelection: null,
      searchMatchHighlight: null,
      ...(options?.showThumbs === undefined
        ? {}
        : { showThumbs: options.showThumbs }),
      ...(options?.readerMode === undefined
        ? {}
        : { readerMode: options.readerMode }),
    });
  },

  activatePendingOverlayReveals: (overlayIds) => {
    if (overlayIds.length === 0) return;
    if (
      !useAppStore.getState().prefs.annotationAnimations ||
      prefersReducedLiveOverlayMotion()
    ) {
      set({
        liveOverlayReveals: [],
        pendingOverlayReveals: new Map<string, LiveOverlayRevealItem>(),
      });
      return;
    }
    let startedReveal: LiveOverlayRevealBatch | null = null;
    set((state) => {
      const requestedIds = new Set(overlayIds);
      const overlays = state.model.overlays.filter(
        (overlay) =>
          requestedIds.has(overlay.id) &&
          state.pendingOverlayReveals.has(overlay.id),
      );
      const pendingItems = overlays.flatMap((overlay) => {
        const item = state.pendingOverlayReveals.get(overlay.id);
        return item ? [item] : [];
      });
      const nextPending = new Map(state.pendingOverlayReveals);
      for (const id of requestedIds) nextPending.delete(id);
      const prepared = prepareMountedOverlayRevealBatch(
        `mounted-${nanoid()}`,
        pendingItems,
      );
      if (!prepared) {
        return { pendingOverlayReveals: nextPending };
      }
      const revealQueue = startPreparedLiveReveal(state.liveOverlayReveals, {
        liveOverlayReveal: prepared,
      });
      startedReveal = revealQueue.startedReveal;
      return {
        pendingOverlayReveals: nextPending,
        ...(startedReveal
          ? {
              liveOverlayReveals: [
                ...revealQueue.retainedReveals,
                startedReveal,
              ],
            }
          : {}),
      };
    });
    scheduleLiveRevealCleanup(startedReveal, (batchId) => {
      set((state) => ({
        liveOverlayReveals: state.liveOverlayReveals.filter(
          (batch) => batch.id !== batchId,
        ),
      }));
    });
  },

  closeDocument: () => set({ ...EDITOR_INIT_STATE }),

  setTool: (tool) =>
    set((state) => ({
      ...clearEditingOverlay(state),
      tool,
      selectedIds: [],
    })),
  setScale: (scale) => set({ scale, fitMode: "none" }),
  setScaleKeepFit: (scale) => set({ scale }),
  setFitMode: (mode) => set({ fitMode: mode }),
  setActivePage: (id) => set({ activePageId: id }),
  // Navigation is the only way to move the viewport to a page: the page is
  // the active page from the moment it is asked for, and the canvas scrolls
  // to it. Writing activePageId alone (a press on a page) never scrolls.
  goToPage: (pageId, index, offsetY = null) =>
    set({
      activePageId: pageId,
      pageJump: { pageId, index, offsetY },
    }),
  consumePageJump: (jump) =>
    set((state) => (state.pageJump === jump ? { pageJump: null } : {})),
  setOutlineSelection: (selection) => set({ outlineSelection: selection }),
  setSearchMatchHighlight: (highlight) => set({ searchMatchHighlight: highlight }),
  selectOnly: (id) => {
    set({ selectedIds: id ? [id] : [] });
  },
  toggleSelected: (id) => {
    const { selectedIds } = get();
    if (selectedIds.includes(id)) {
      set({ selectedIds: selectedIds.filter((x) => x !== id) });
    } else {
      set({ selectedIds: [...selectedIds, id] });
    }
  },
  setSelected: (ids) => {
    // De-dup while preserving the provided order — callers typically
    // pass the result of a hit-test and want the first element to be
    // the "primary" selection for subsequent single-target operations.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    set({ selectedIds: unique });
  },
  setEditingOverlayId: (id) =>
    set((state) => {
      if (id === null) return clearEditingOverlay(state);
      if (id === state.editingOverlayId) return { editingOverlayId: id };
      return {
        ...clearEditingOverlay(state),
        editingOverlayId: id,
      };
    }),
  setNoteCollapsed: (id, collapsed) =>
    set((state) => {
      const hasId = state.collapsedNoteIds.includes(id);
      if (collapsed === hasId) return state;
      return {
        collapsedNoteIds: collapsed
          ? normalizeCollapsedNoteIds(
              [...state.collapsedNoteIds, id].slice(-MAX_COLLAPSED_NOTE_IDS),
            )
          : state.collapsedNoteIds.filter((noteId) => noteId !== id),
      };
    }),
  setCollapsedNoteIds: (ids) =>
    // Workspace state can arrive before the user accepts a recoverable draft.
    // Keep bounded stale IDs temporarily so draft-owned notes recover their
    // disclosure state after the model is restored; App prunes them once the
    // restore/discard decision is final.
    set({ collapsedNoteIds: normalizeCollapsedNoteIds(ids) }),
  toggleNoteCollapsed: (id) =>
    set((state) => ({
      collapsedNoteIds: state.collapsedNoteIds.includes(id)
        ? state.collapsedNoteIds.filter((noteId) => noteId !== id)
        : normalizeCollapsedNoteIds(
            [...state.collapsedNoteIds, id].slice(-MAX_COLLAPSED_NOTE_IDS),
          ),
    })),
  setCalloutCollapsed: (id, collapsed) =>
    set((state) => {
      const hasId = state.collapsedCalloutIds.includes(id);
      if (collapsed === hasId) return state;
      return {
        collapsedCalloutIds: collapsed
          ? normalizeCollapsedNoteIds(
              [...state.collapsedCalloutIds, id].slice(-MAX_COLLAPSED_NOTE_IDS),
            )
          : state.collapsedCalloutIds.filter(
              (calloutId) => calloutId !== id,
            ),
      };
    }),
  setThreadCollapsed: (id, collapsed) =>
    set((state) => {
      const hasId = state.collapsedThreadIds.includes(id);
      if (collapsed === hasId) return state;
      return {
        collapsedThreadIds: collapsed
          ? normalizeCollapsedNoteIds(
              [...state.collapsedThreadIds, id].slice(-MAX_COLLAPSED_NOTE_IDS),
            )
          : state.collapsedThreadIds.filter((calloutId) => calloutId !== id),
      };
    }),
  setCollapsedCalloutIds: (ids) =>
    // Same draft-restore caveat as setCollapsedNoteIds: keep bounded stale IDs
    // until App has resolved the restore/discard decision.
    set({ collapsedCalloutIds: normalizeCollapsedNoteIds(ids) }),
  toggleCalloutCollapsed: (id) =>
    set((state) => ({
      collapsedCalloutIds: state.collapsedCalloutIds.includes(id)
        ? state.collapsedCalloutIds.filter((calloutId) => calloutId !== id)
        : normalizeCollapsedNoteIds(
            [...state.collapsedCalloutIds, id].slice(-MAX_COLLAPSED_NOTE_IDS),
          ),
    })),
  selectAllOnPage: (pageId) => {
    if (!pageId) {
      set({ selectedIds: [] });
      return;
    }
    const ids = get()
      .model.overlays.filter((o) => o.pageId === pageId)
      .map((o) => o.id);
    set({ selectedIds: ids });
  },

  commit: (next) => {
    const state = get();
    const prev = state.model;
    const snapshot = cloneModel(prev);
    const merged: DocumentModel = {
      pages: next.pages ?? prev.pages,
      overlays: next.overlays ?? prev.overlays,
    };
    set({
      model: merged,
      activePageId: activePageIdAfterPageReplacement(
        state.activePageId,
        prev.pages,
        merged.pages,
      ),
      undoStack: [...state.undoStack, snapshot].slice(-100),
      redoStack: [],
    });
  },

  prepareCommit: (next) => {
    const state = get();
    const snapshot = cloneModel(state.model);
    return {
      expectedModel: state.model,
      expectedUndoStack: state.undoStack,
      expectedRedoStack: state.redoStack,
      model: {
        pages: next.pages ?? state.model.pages,
        overlays: next.overlays ?? state.model.overlays,
      },
      undoStack: [...state.undoStack, snapshot].slice(-100),
    };
  },

  commitPrepared: (prepared, ui) => {
    let committed = false;
    set((state) => {
      if (
        state.model !== prepared.expectedModel ||
        state.undoStack !== prepared.expectedUndoStack ||
        state.redoStack !== prepared.expectedRedoStack
      ) {
        return {};
      }
      committed = true;
      const pendingOverlayReveals = ui?.liveOverlayReveal
        ? new Map([
            ...state.pendingOverlayReveals,
            ...ui.liveOverlayReveal.itemsById,
          ])
        : state.pendingOverlayReveals;
      return {
        model: prepared.model,
        activePageId: activePageIdAfterPageReplacement(
          state.activePageId,
          state.model.pages,
          prepared.model.pages,
        ),
        undoStack: prepared.undoStack,
        redoStack: [],
        ...(ui?.selectedIds !== undefined
          ? { selectedIds: ui.selectedIds }
          : {}),
        pendingOverlayReveals,
      };
    });
    return committed;
  },

  prepareOverlayBatchCommit: (overlays, operationId) => {
    if (overlays.length === 0) {
      throw new Error("A Live overlay batch must contain at least one overlay");
    }
    const state = get();
    const historyOverlays = cloneOverlays(overlays);
    const historyEntry: OverlayBatchHistoryEntry = {
      kind: "overlay-batch",
      operationId,
      overlays: historyOverlays,
      cursor: historyOverlays.length,
    };
    const completedLiveOperationIds = new Set(
      state.completedLiveOperationIds,
    );
    completedLiveOperationIds.add(operationId);
    while (completedLiveOperationIds.size > LIVE_OPERATION_RECEIPT_MAX) {
      const oldest = completedLiveOperationIds.values().next().value;
      if (typeof oldest !== "string") break;
      completedLiveOperationIds.delete(oldest);
    }
    return {
      expectedModel: state.model,
      expectedUndoStack: state.undoStack,
      expectedRedoStack: state.redoStack,
      expectedCompletedLiveOperationIds: state.completedLiveOperationIds,
      model: {
        pages: state.model.pages,
        overlays: [...state.model.overlays, ...overlays],
      },
      undoStack: [...state.undoStack, historyEntry].slice(-100),
      completedLiveOperationIds,
    };
  },

  commitPreparedOverlayBatch: (prepared, ui) => {
    let committed = false;
    set((state) => {
      if (
        state.model !== prepared.expectedModel ||
        state.undoStack !== prepared.expectedUndoStack ||
        state.redoStack !== prepared.expectedRedoStack ||
        state.completedLiveOperationIds !==
          prepared.expectedCompletedLiveOperationIds
      ) {
        return {};
      }
      committed = true;
      const pendingOverlayReveals = ui?.liveOverlayReveal
        ? new Map([
            ...state.pendingOverlayReveals,
            ...ui.liveOverlayReveal.itemsById,
          ])
        : state.pendingOverlayReveals;
      return {
        model: prepared.model,
        undoStack: prepared.undoStack,
        redoStack: [],
        completedLiveOperationIds: prepared.completedLiveOperationIds,
        ...(ui?.selectedIds !== undefined
          ? { selectedIds: ui.selectedIds }
          : {}),
        pendingOverlayReveals,
      };
    });
    return committed;
  },

  commitRestoredDraft: (next, history, completedLiveOperationIds = []) => {
    const state = get();
    const prev = state.model;
    const snapshot = cloneModel(prev);
    const merged: DocumentModel = {
      pages: next.pages ?? prev.pages,
      overlays: next.overlays ?? prev.overlays,
    };
    const shouldRevealRestoredCallouts =
      useAppStore.getState().prefs.annotationAnimations &&
      !prefersReducedLiveOverlayMotion();
    const restoredReveal = shouldRevealRestoredCallouts
      ? prepareLiveOverlayRevealBatch(
          `draft-callouts-${nanoid()}`,
          merged.overlays.filter((overlay) => overlay.type === "callout"),
        )
      : null;
    const pendingOverlayReveals = restoredReveal
      ? new Map([
          ...get().pendingOverlayReveals,
          ...restoredReveal.itemsById,
        ])
      : get().pendingOverlayReveals;
    const joinPreRestoreHistory = canJoinPreRestoreHistory(
      snapshot,
      merged,
      history,
    );
    set({
      model: merged,
      activePageId: activePageIdAfterPageReplacement(
        state.activePageId,
        prev.pages,
        merged.pages,
      ),
      // Undo must walk the restored draft's own timeline first. A normal
      // source can then rejoin this session's pre-restore states. Replacement
      // PDFs are different: page insertion physically appends pages while its
      // persisted history presents them at a logical position, so the fresh
      // physical model is not an older state in that timeline. In that case,
      // discard the whole incompatible session leg instead of letting a later
      // Undo resurrect an inserted page at the physical tail. History-free
      // legacy drafts still keep the original restore-step semantics.
      undoStack: [
        ...(joinPreRestoreHistory ? [...state.undoStack, snapshot] : []),
        ...history.map(cloneHistoryEntry),
      ].slice(-100),
      redoStack: [],
      liveOverlayReveals: [],
      pendingOverlayReveals,
      completedLiveOperationIds: new Set(completedLiveOperationIds),
    });
  },

  restoreBaselineModel: (model) => {
    const state = get();
    set({
      model,
      activePageId: activePageIdAfterPageReplacement(
        state.activePageId,
        state.model.pages,
        model.pages,
      ),
      undoStack: [],
      redoStack: [],
      selectedIds: [],
      liveOverlayReveals: [],
      pendingOverlayReveals: new Map(),
    });
  },

  undo: () => {
    const { undoStack, model, redoStack, selectedIds, activePageId } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1]!;
    if (isOverlayBatchHistoryEntry(prev)) {
      if (prev.cursor <= 0) return;
      const nextCursor = prev.cursor - 1;
      const removed = prev.overlays[nextCursor]!;
      const nextModel = {
        pages: model.pages,
        overlays: model.overlays.filter((overlay) => overlay.id !== removed.id),
      };
      const nextEntry = { ...prev, cursor: nextCursor };
      const redoTop = redoStack[redoStack.length - 1];
      const nextRedo =
        redoTop &&
        isOverlayBatchHistoryEntry(redoTop) &&
        redoTop.operationId === prev.operationId
          ? [...redoStack.slice(0, -1), nextEntry]
          : [...redoStack, nextEntry];
      set({
        model: nextModel,
        undoStack:
          nextCursor === 0
            ? undoStack.slice(0, -1)
            : [...undoStack.slice(0, -1), nextEntry],
        redoStack: nextRedo,
        selectedIds: selectedIdsPresentInModel(selectedIds, nextModel),
        editingOverlayId: null,
        historyFeedback: { kind: "undo", at: Date.now() },
        liveOverlayReveals: [],
      });
      return;
    }
    set({
      model: prev,
      activePageId: activePageIdAfterPageReplacement(
        activePageId,
        model.pages,
        prev.pages,
      ),
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, cloneModel(model)],
      selectedIds: selectedIdsPresentInModel(selectedIds, prev),
      editingOverlayId: null,
      historyFeedback: { kind: "undo", at: Date.now() },
      liveOverlayReveals: [],
    });
  },

  redo: () => {
    const { redoStack, model, undoStack, selectedIds, activePageId } = get();
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1]!;
    if (isOverlayBatchHistoryEntry(next)) {
      if (next.cursor >= next.overlays.length) return;
      const restored = next.overlays[next.cursor]!;
      const nextCursor = next.cursor + 1;
      const nextEntry = { ...next, cursor: nextCursor };
      const nextModel = {
        pages: model.pages,
        overlays: [...model.overlays, cloneOverlays([restored])[0]!],
      };
      const undoTop = undoStack[undoStack.length - 1];
      const nextUndo =
        undoTop &&
        isOverlayBatchHistoryEntry(undoTop) &&
        undoTop.operationId === next.operationId
          ? [...undoStack.slice(0, -1), nextEntry]
          : [...undoStack, nextEntry].slice(-100);
      set({
        model: nextModel,
        redoStack:
          nextCursor === next.overlays.length
            ? redoStack.slice(0, -1)
            : [...redoStack.slice(0, -1), nextEntry],
        undoStack: nextUndo,
        selectedIds: selectedIdsPresentInModel(selectedIds, nextModel),
        editingOverlayId: null,
        historyFeedback: { kind: "redo", at: Date.now() },
        liveOverlayReveals: [],
      });
      return;
    }
    set({
      model: next,
      activePageId: activePageIdAfterPageReplacement(
        activePageId,
        model.pages,
        next.pages,
      ),
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, cloneModel(model)],
      selectedIds: selectedIdsPresentInModel(selectedIds, next),
      editingOverlayId: null,
      historyFeedback: { kind: "redo", at: Date.now() },
      liveOverlayReveals: [],
    });
  },

  beginHistoryStep: () => {
    const snapshot = cloneModel(get().model);
    set({
      undoStack: [...get().undoStack, snapshot].slice(-100),
      redoStack: [],
    });
  },

  addOverlay: (o) => {
    const m = get().model;
    get().commit({ overlays: [...m.overlays, o] });
  },

  addOverlayNoHistory: (o) => {
    const m = get().model;
    set({ model: { pages: m.pages, overlays: [...m.overlays, o] } });
  },

  updateOverlay: (id, patch) => {
    const m = get().model;
    get().commit({
      overlays: m.overlays.map((o) =>
        o.id === id ? withLocalActivity(o, patch) : o,
      ),
    });
  },

  updateOverlayNoHistory: (id, patch) => {
    const m = get().model;
    set({
      model: {
        pages: m.pages,
        overlays: m.overlays.map((o) =>
          o.id === id ? withLocalActivity(o, patch) : o,
        ),
      },
    });
  },

  removeOverlay: (id) => {
    const m = get().model;
    if (!m.overlays.some((o) => o.id === id)) {
      if (get().editingOverlayId === id) set({ editingOverlayId: null });
      return;
    }
    get().commit({ overlays: m.overlays.filter((o) => o.id !== id) });
    if (get().editingOverlayId === id) set({ editingOverlayId: null });
  },

  ...selectedOverlayActions(set, get),

  copySelected: () => {
    const { selectedIds, model } = get();
    set({ overlayClipboard: copySelectedOverlays(model.overlays, selectedIds) });
  },

  pasteClipboard: (pageId) => {
    if (!pageId) return;
    const { overlayClipboard, model } = get();
    if (overlayClipboard.length === 0) return;
    const pasted = pasteOverlays(overlayClipboard, pageId, nanoid);
    get().commit({ overlays: [...model.overlays, ...pasted] });
    set({ selectedIds: pasted.map((o) => o.id) });
  },

  movePage: (from, to) => {
    const m = get().model;
    if (from === to || from < 0 || to < 0 || from >= m.pages.length) return;
    const pages = [...m.pages];
    const [moved] = pages.splice(from, 1);
    if (!moved) return;
    pages.splice(to, 0, moved);
    get().commit({ pages });
  },

  deletePage: (id) => {
    const m = get().model;
    if (m.pages.length <= 1) return;
    const pages = m.pages.filter((p) => p.id !== id);
    const overlays = m.overlays.filter((o) => o.pageId !== id);
    get().commit({ pages, overlays });
    if (get().activePageId === id) {
      set({ activePageId: pages[0]?.id ?? null });
    }
  },

  rotatePage: (id, delta) => {
    const m = get().model;
    const pages = m.pages.map((p) =>
      p.id === id
        ? { ...p, rotation: normalizeRotation(p.rotation + delta) }
        : p,
    );
    get().commit({ pages });
  },

  duplicatePage: (id) => {
    const m = get().model;
    const idx = m.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const src = m.pages[idx]!;
    const newPage: PageModel = { ...src, id: nanoid() };
    const pages = [...m.pages];
    pages.splice(idx + 1, 0, newPage);
    get().commit({ pages });
  },

  insertBlankPage: (afterPageId) => {
    const m = get().model;
    const reference =
      m.pages.find((p) => p.id === afterPageId) ?? m.pages.at(-1);
    const blank: PageModel = {
      id: nanoid(),
      sourceIndex: -1,
      rotation: 0,
      widthPt: reference?.widthPt ?? 612,
      heightPt: reference?.heightPt ?? 792,
      blank: true,
    };
    const pages = [...m.pages];
    const idx = afterPageId
      ? pages.findIndex((p) => p.id === afterPageId)
      : pages.length - 1;
    pages.splice(idx >= 0 ? idx + 1 : pages.length, 0, blank);
    get().commit({ pages });
    set({ activePageId: blank.id });
  },

  setTextDefaults: (patch) =>
    set({ textDefaults: { ...get().textDefaults, ...patch } }),
  setShowThumbs: (v) => set({ showThumbs: v }),
  toggleThumbs: () => set({ showThumbs: !get().showThumbs }),
  setReaderMode: (v) => set({ readerMode: v }),
  toggleReaderMode: () => set({ readerMode: !get().readerMode }),
  setAnnotationMode: (v) =>
    set((state) =>
      v
        ? { annotationMode: true }
        : {
            // Reading mode has no tool grid, so an armed markup tool would be
            // both unreachable and invisible — and `select` is the tool the
            // select-text-then-mark popover requires (see TextHighlightLayer,
            // which only offers it under the select tool). Leaving the mode
            // therefore returns the tool, not just the chrome.
            ...clearEditingOverlay(state),
            annotationMode: false,
            tool: "select" as ToolId,
            selectedIds: [],
          },
    ),

  registerPdfFontFaces: (entries) => {
    const { pdfFontFaces, pdfFontChars } = get();
    let facesChanged = false;
    let charsChanged = false;
    const nextFaces = { ...pdfFontFaces };
    const nextChars = { ...pdfFontChars };
    for (const { baseFontName, faceFamily, chars } of entries) {
      if (nextFaces[baseFontName] !== faceFamily) {
        nextFaces[baseFontName] = faceFamily;
        facesChanged = true;
      }
      if (chars) {
        const seen = nextChars[baseFontName];
        const merged = new Set(seen ?? []);
        const before = merged.size;
        for (const ch of chars) merged.add(ch);
        if (merged.size !== before) {
          nextChars[baseFontName] = merged;
          charsChanged = true;
        }
      }
    }
    // No-op when nothing moved — page re-renders re-register the same
    // faces and must not churn subscribers.
    if (facesChanged || charsChanged) {
      set({
        ...(facesChanged ? { pdfFontFaces: nextFaces } : {}),
        ...(charsChanged ? { pdfFontChars: nextChars } : {}),
      });
    }
    },
  }));
}

let resolveActiveEditorStore: (() => PdfEditorStoreApi) | null = null;

/** Keep global preference side effects scoped to the editor currently on screen. */
export function setActivePdfEditorStoreResolver(
  resolver: (() => PdfEditorStoreApi) | null,
): void {
  resolveActiveEditorStore = resolver;
}

/** The editor store on screen, as App last activated it. */
export function activePdfEditorStore(): PdfEditorStoreApi | null {
  return resolveActiveEditorStore?.() ?? null;
}

export function createAppStore(): AppStoreApi {
  return create<AppStore>((set, get) => ({
    ...APP_INIT_STATE,
    setChromeResizing: (resizing) => set({ chromeResizing: resizing }),
    setActiveSignature: (signature) => set({ activeSignature: signature }),
    setAnnotDefaults: (patch) => {
      const next = { ...get().annotDefaults, ...patch };
      saveAnnotDefaults(next);
      set({ annotDefaults: next });
    },
    setShowRail: (v) => set({ showRail: v }),
    toggleRail: () => set({ showRail: !get().showRail }),
    setRailTab: (t) => set({ railTab: t }),
    openBrowserPanel: (url) =>
      set({
        showRail: true,
        railTab: "browser",
        webPanel: {
          url,
          loading: true,
          canGoBack: false,
          canGoForward: false,
          error: null,
        },
        webPanelRequest: {
          url,
          nonce: (webPanelRequestNonce += 1),
        },
      }),
    setWebPanel: (patch) =>
      set({ webPanel: { ...get().webPanel, ...patch } }),
    resetWebPanel: () =>
      set({
        webPanel: {
          url: null,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: null,
        },
        webPanelRequest: null,
      }),
    setShowExport: (v) => set({ showExport: v }),
    setShowSettings: (v) => set({ showSettings: v }),
    setShowShortcuts: (v) => set({ showShortcuts: v }),
    setShowGoToPage: (v) => set({ showGoToPage: v }),
    setShowFind: (v) => set({ showFind: v }),
    setIsPrinting: (v) => set({ isPrinting: v }),
    setShowBetaDisclaimer: (v) => set({ showBetaDisclaimer: v }),
    acknowledgeBetaDisclaimer: () => {
      saveBetaDisclaimerAcknowledged();
      set({ showBetaDisclaimer: false });
    },
    setPrefs: (patch) => {
      const next = { ...get().prefs, ...patch };
      if (Object.hasOwn(patch, "accentColor")) {
        next.accentColor = normalizeAccentColor(patch.accentColor);
      }
      if (Object.hasOwn(patch, "pdfPaperCustomColor")) {
        next.pdfPaperCustomColor =
          normalizeHexColor(patch.pdfPaperCustomColor) ??
          get().prefs.pdfPaperCustomColor;
      }
      savePrefs(next);
      set({ prefs: next });
      if (patch.annotationAnimations === false) {
        resolveActiveEditorStore?.().setState({
          liveOverlayReveals: [],
          pendingOverlayReveals: new Map<string, LiveOverlayRevealItem>(),
        });
      }
    },
    pushRecentColor: (hex) => {
      // Reload before merging so another tab or an HMR update cannot be
      // overwritten by stale in-memory preferences.
      const normalized = hex.toLowerCase();
      const freshPrefs = loadPrefs();
      const filtered = freshPrefs.recentColors.filter(
        (c) => c.toLowerCase() !== normalized,
      );
      const recentColors = [normalized, ...filtered].slice(
        0,
        RECENT_COLORS_MAX,
      );
      const nextPrefs = { ...freshPrefs, recentColors };
      savePrefs(nextPrefs);
      set({ prefs: nextPrefs });
    },
    setError: (info) => set({ errorInfo: info }),
  }));
}

// Compatibility singleton for tests and non-provider call sites while the
// workspace registry completes its one-time cutover.
export const useStore = createPdfEditorStore();
/** Empty/home-screen editor state; production code must not use the legacy hook name. */
export const emptyPdfEditorStore = useStore;
export const useAppStore = createAppStore();
resolveActiveEditorStore = () => useStore;
export const EditorStoreContext = createContext<PdfEditorStoreApi | null>(null);

function useEditorStoreHook<T>(selector: (state: Store) => T): T {
  const store = useContext(EditorStoreContext) ?? useStore;
  return useZustandStore(store, selector);
}

/** The StoreApi for imperative work scoped to the currently rendered tab. */
export function useEditorStoreApi(): PdfEditorStoreApi {
  return useContext(EditorStoreContext) ?? useStore;
}

// Static methods remain temporarily for compatibility tests and are backed by
// the legacy singleton. Production imperative consumers migrate to
// useEditorStoreApi() or an explicit PdfEditorStoreApi before per-tab cutover.
export const useEditorStore = Object.assign(
  useEditorStoreHook,
  useStore,
) as PdfEditorStoreApi;

export function newPageId(): string {
  return nanoid();
}

function cloneOpenedPdf(opened: OpenedPdf): OpenedPdf {
  return {
    ...opened,
    sourcePages: opened.sourcePages.map((page) => ({ ...page })),
  };
}

function cloneOverlays(overlays: Overlay[]): Overlay[] {
  return cloneModel({ pages: [], overlays }).overlays;
}

export function capturePdfEditorSession(options?: {
  preserveUnmatchedCollapsedNoteIds?: boolean;
  store?: PdfEditorStoreApi;
}): PdfEditorSessionState | null {
  const state = (options?.store ?? useStore).getState();
  if (!state.opened) return null;
  return {
    opened: cloneOpenedPdf(state.opened),
    model: cloneModel(state.model),
    tool: state.tool,
    scale: state.scale,
    fitMode: state.fitMode,
    selectedIds: [...state.selectedIds],
    activePageId: state.activePageId,
    outlineSelection: state.outlineSelection
      ? { ...state.outlineSelection }
      : null,
    searchMatchHighlight: state.searchMatchHighlight
      ? { ...state.searchMatchHighlight }
      : null,
    overlayClipboard: cloneOverlays(state.overlayClipboard),
    editingOverlayId: state.editingOverlayId,
    collapsedNoteIds: options?.preserveUnmatchedCollapsedNoteIds
      ? normalizeCollapsedNoteIds(state.collapsedNoteIds)
      : filterExistingCollapsedNoteIds(
          state.collapsedNoteIds,
          state.model.overlays,
        ),
    collapsedCalloutIds: options?.preserveUnmatchedCollapsedNoteIds
      ? normalizeCollapsedNoteIds(state.collapsedCalloutIds)
      : filterExistingCollapsedCalloutIds(
          state.collapsedCalloutIds,
          state.model.overlays,
        ),
    undoStack: state.undoStack.map(cloneHistoryEntry),
    redoStack: state.redoStack.map(cloneHistoryEntry),
    completedLiveOperationIds: new Set(state.completedLiveOperationIds),
    pendingOverlayReveals: new Map(state.pendingOverlayReveals),
    showThumbs: state.showThumbs,
    readerMode: state.readerMode,
  };
}

export function restorePdfEditorSession(
  session: PdfEditorSessionState,
  options?: {
    preserveUnmatchedCollapsedNoteIds?: boolean;
    store?: PdfEditorStoreApi;
    annotationAnimationsEnabled?: boolean;
  },
): void {
  const animationsEnabled =
    (options?.annotationAnimationsEnabled ??
      useAppStore.getState().prefs.annotationAnimations) &&
    !prefersReducedLiveOverlayMotion();
  (options?.store ?? useStore).setState({
    opened: cloneOpenedPdf(session.opened),
    model: cloneModel(session.model),
    tool: session.tool,
    scale: session.scale,
    fitMode: session.fitMode,
    selectedIds: [...session.selectedIds],
    activePageId: session.activePageId,
    pageJump: null,
    outlineSelection: session.outlineSelection
      ? { ...session.outlineSelection }
      : null,
    searchMatchHighlight: session.searchMatchHighlight
      ? { ...session.searchMatchHighlight }
      : null,
    overlayClipboard: cloneOverlays(session.overlayClipboard),
    editingOverlayId: session.editingOverlayId,
    collapsedNoteIds: options?.preserveUnmatchedCollapsedNoteIds
      ? normalizeCollapsedNoteIds(session.collapsedNoteIds ?? [])
      : filterExistingCollapsedNoteIds(
          session.collapsedNoteIds ?? [],
          session.model.overlays,
        ),
    collapsedCalloutIds: options?.preserveUnmatchedCollapsedNoteIds
      ? normalizeCollapsedNoteIds(session.collapsedCalloutIds ?? [])
      : filterExistingCollapsedCalloutIds(
          session.collapsedCalloutIds ?? [],
          session.model.overlays,
        ),
    historyFeedback: null,
    liveOverlayReveals: [],
    pendingOverlayReveals: animationsEnabled
      ? new Map(session.pendingOverlayReveals)
      : new Map(),
    undoStack: session.undoStack.map(cloneHistoryEntry),
    redoStack: session.redoStack.map(cloneHistoryEntry),
    completedLiveOperationIds: new Set(session.completedLiveOperationIds),
    showThumbs: session.showThumbs,
    readerMode: session.readerMode,
    // The mode is implied by the tool, so it is derived rather than stored:
    // `tool` comes back with the session, and a tab that returned in reading
    // mode with a markup tool armed would be the one state that silently
    // disables select-text-then-mark, with no visible grid to change it
    // from. Desktop and tablets never read this flag.
    annotationMode: session.tool !== "select",
  });
  useAppStore.setState({
    showExport: false,
    showSettings: false,
    showShortcuts: false,
    showGoToPage: false,
    showFind: false,
    isPrinting: false,
    errorInfo: null,
  });
}
