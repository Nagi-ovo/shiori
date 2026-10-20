export type PdfPoint = { x: number; y: number };
export type PdfRect = { x: number; y: number; w: number; h: number };
export type Rotation = 0 | 90 | 180 | 270;

/**
 * Where an annotation was textually anchored when it was created.
 *
 * Geometry (rects/targetRects/at) stays the sole authority for rendering and
 * export; the anchor is provenance. It exists so the annotation can later be
 * re-anchored when the SAME logical document's text moves (a re-export, a
 * cross-version import) — the thing coordinates alone can never recover.
 * `quote` is the exact matched document text (not the possibly-fuzzier
 * requested quote), so a future re-resolution searches for what was actually
 * hit. Never re-resolved silently mid-session.
 */
export type OverlayTextAnchor = {
  quote: string;
  /** 1-based page number the quote resolved on at creation time. */
  page: number;
  /**
   * 1-based occurrence of the quote on that page (page-local). Anchor
   * resolution always records it; in-app selection capture omits it — an
   * honest count is not available at selection time, and a wrong one is
   * worse than none. A re-anchor pass without it disambiguates repeats by
   * proximity to the stored geometry.
   */
  occurrence?: number;
};

type OverlayCommon = {
  locked?: boolean;
  // Where this annotation came from. Set once, at the single point every
  // imported annotation passes through (annotationToOverlay), and absent on
  // everything the reader creates here.
  //
  // Recorded rather than inferred because inference does not work: importing
  // a sticky note rebuilds it through createNoteOverlay(..., now), so it
  // arrives carrying today's createdAt, and an imported reply copies the
  // source /CreationDate into thread.at. PDF metadata is all optional, so
  // "has an author or a date" misses annotations that have neither. Anything
  // reading this must still tolerate it being absent — overlays written by
  // older builds have no origin, and fall back to the old inference.
  origin?: "imported";
  // When the import happened, epoch ms. Activity after this point is the
  // reader's own; anything at or before it came in with the file.
  importedAt?: number;
  // Last time the reader changed this annotation here, epoch ms. Written by
  // the store's mutation paths, so it covers every overlay shape — only
  // notes carry their own updatedAt, which left an edited callout or text
  // overlay with no evidence it had been touched at all.
  localActivityAt?: number;
  // Review provenance carried over from an imported source annotation.
  //
  // Export replaces every source annotation it owns with a freshly built one,
  // so anything not captured here is lost on the first round trip: a PDF
  // reviewed in Acrobat came back with every comment anonymous, dated today,
  // and with its reply threads flattened into unrelated notes.
  //
  // All of these stay undefined for overlays the user creates in Shiori. That
  // is deliberate — Shiori does not know who the user is, and writing a /T it
  // invented would be worse than letting the reader supply its own default.
  sourceAuthor?: string;
  // Epoch milliseconds, parsed from the annotation's /CreationDate and /M.
  sourceCreatedAt?: number;
  sourceModifiedAt?: number;
  // Overlay id of the annotation this one replies to (/IRT), in the same
  // `pdf-annotation-<pageIndex>-<ref>` space as imported overlay ids.
  sourceInReplyToId?: string;
  // /RT: "R" for a reply, "Group" for grouped annotations.
  sourceReplyType?: "R" | "Group";
  // Text-anchor provenance captured at creation (anchored CLI/Live specs).
  // Meaningful for highlight/underline/strikethrough/note/callout; carried in
  // OverlayCommon because it must survive generic clone/round-trip paths.
  anchor?: OverlayTextAnchor;
};

export type PageModel = {
  id: string;
  sourceIndex: number;
  rotation: Rotation;
  // Lower-left corner of the visible PDF view box in the source page's
  // native user space. Overlay geometry is stored relative to that visible
  // page box; import/export adds or subtracts this origin at the boundary.
  originXPt?: number;
  originYPt?: number;
  widthPt: number;
  heightPt: number;
  blank?: boolean;
};

export function isBlankPage(page: PageModel): boolean {
  return page.blank === true || page.sourceIndex < 0;
}

// The comment a reviewer attached to a markup, shape or ink annotation in
// another reader (its /Contents: Zotero, Preview and Acrobat keep a
// highlight's note there). Carried so export writes it back instead of
// blanking it; notes, text and callouts hold their body in `text`.
type SourceComment = {
  comment?: string;
};

export type HighlightOverlay = OverlayCommon & SourceComment & {
  type: "highlight";
  id: string;
  pageId: string;
  rects: PdfRect[];
  color: string;
  opacity: number;
};

export type UnderlineOverlay = OverlayCommon & SourceComment & {
  type: "underline";
  id: string;
  pageId: string;
  rects: PdfRect[];
  color: string;
  opacity: number;
};

export type StrikeOutOverlay = OverlayCommon & SourceComment & {
  type: "strikethrough";
  id: string;
  pageId: string;
  rects: PdfRect[];
  color: string;
  opacity: number;
};

export type InkOverlay = OverlayCommon & SourceComment & {
  type: "ink";
  id: string;
  pageId: string;
  paths: PdfPoint[][];
  color: string;
  width: number;
  source?: "signature";
};

export type ImageOverlay = OverlayCommon & {
  type: "image";
  id: string;
  pageId: string;
  rect: PdfRect;
  dataUrl: string;
  mimeType: "image/png" | "image/jpeg";
  source?: "signature";
  angle?: number;
};

export type StampOverlay = OverlayCommon & {
  type: "stamp";
  id: string;
  pageId: string;
  kind: "check" | "cross";
  rect: PdfRect;
  color: string;
  strokeWidth: number;
  // Free rotation about the rect center, degrees clockwise. Missing = 0
  // (unrotated). Composes on top of the page's /Rotate. See coords.ts.
  angle?: number;
};

export type RectOverlay = OverlayCommon & SourceComment & {
  type: "rect";
  id: string;
  pageId: string;
  rect: PdfRect;
  color: string;
  strokeWidth: number;
  fill: string | null;
  // Free rotation about the rect center, degrees clockwise. Missing = 0.
  angle?: number;
};

export type NoteOverlay = OverlayCommon & {
  type: "note";
  id: string;
  pageId: string;
  rect: PdfRect;
  text: string;
  color: string;
  createdAt?: number;
  updatedAt?: number;
  // Free rotation about the rect center, degrees clockwise. Missing = 0.
  angle?: number;
};

export type FontFamily =
  | "sans"
  | "serif"
  | "mono"
  | "notoSansSc"
  | "notoSansJp";

export type TextOverlay = OverlayCommon & {
  type: "text";
  id: string;
  pageId: string;
  rect: PdfRect;
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic?: boolean;
  align: "left" | "center" | "right";
  fontFamily: FontFamily;
  // Free rotation about the rect center, degrees clockwise. Missing = 0.
  angle?: number;
};

/**
 * One turn of the conversation attached to a callout. The root callout's own
 * `text` is the opening message; `thread` holds every turn after it, in
 * order. Exports as a chain of /IRT Text replies (Acrobat renders that as a
 * native comment thread) with role carried in the Shio developer dictionary,
 * because standard PDF only has a free-form /T author field.
 */
export type CalloutThreadEntry = {
  /** Stable within the callout; survives export/import round trips. */
  id: string;
  role: "user" | "agent";
  /** Display name for agent turns (e.g. "Claude Code"); becomes /T. User
   * turns omit it — Shiori does not know who the user is, and inventing a
   * /T would be worse than letting readers supply their own default. */
  author?: string;
  text: string;
  /** Epoch milliseconds. */
  at?: number;
};

/**
 * A semantic callout: one or more source rectangles remain anchored to the
 * document while a separate, movable label points back to them. Keeping the
 * two geometries distinct is important for editing, PDF FreeText callout
 * round-trips, and deterministic reveal animation.
 */
export type CalloutOverlay = OverlayCommon & {
  type: "callout";
  id: string;
  pageId: string;
  targetRects: PdfRect[];
  /**
   * Optional PDF-style leader points in target -> knee -> label order.
   * Two points represent a straight leader; three preserve an imported
   * FreeTextCallout elbow. Newly-created callouts derive this geometry until
   * the user/importer supplies an explicit path.
   */
  leader?: PdfPoint[];
  /** Imported PDF elbows stay angular; Shiori-authored leaders are curved. */
  leaderKind?: "polyline" | "quadratic";
  rect: PdfRect;
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic?: boolean;
  align: "left" | "center" | "right";
  fontFamily: FontFamily;
  /** Conversation turns after the root message; absent = plain callout. */
  thread?: CalloutThreadEntry[];
};

export type ContentTextOverlay = OverlayCommon & {
  type: "contentText";
  id: string;
  pageId: string;
  rect: PdfRect;
  coverRects: PdfRect[];
  // Baseline y of each covered source line (same page space as rect/coverRects,
  // top line first). Captured from the text item's transform at edit time — the
  // single source of truth for vertical placement; render and export derive
  // from it instead of re-deriving from rect edges. Missing = overlay predates
  // baseline capture (or came from the DOM-fallback selection path): consumers
  // fall back to the legacy rect-edge math.
  sourceBaselinesPt?: number[];
  // Horizontal start of the FIRST covered line relative to rect.x, in
  // points. Non-zero when the selection began mid-line: its first line then
  // starts right of the following full lines, and the first replacement
  // line must render at the source start instead of flush against the box.
  // Relative, so page-space translation leaves it untouched. Missing = 0.
  firstLineIndentPt?: number;
  originalText: string;
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic?: boolean;
  align: "left" | "center" | "right";
  fontFamily: FontFamily;
  renderedFont?: string;
  // Normalized /BaseFont name (subset tag stripped) of the dominant font
  // under the edit — e.g. "EBGaramond-Regular". Stable across sessions;
  // the renderer maps it to the embedded-font FontFace loaded in the CURRENT
  // session (store.pdfFontFaces) so the edit box shows the document's own
  // font. Missing = predates capture or the font never resolved to a
  // stable name; renderedFont/fontFamily then style the box as before.
  sourceFontName?: string;
  backgroundColor: string;
  // Free rotation about the rect center, degrees clockwise. Missing = 0.
  angle?: number;
};

export type Overlay =
  | HighlightOverlay
  | UnderlineOverlay
  | StrikeOutOverlay
  | InkOverlay
  | ImageOverlay
  | StampOverlay
  | RectOverlay
  | NoteOverlay
  | CalloutOverlay
  | TextOverlay
  | ContentTextOverlay;

export type OverlayType = Overlay["type"];

export type ToolId =
  | "select"
  | "highlight"
  | "underline"
  | "strikethrough"
  | "stamp"
  | "rect"
  | "ink"
  | "signature"
  | "note"
  | "callout"
  | "text";

export type DocumentModel = {
  pages: PageModel[];
  overlays: Overlay[];
};
