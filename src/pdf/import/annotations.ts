import { nanoid } from "nanoid";
import type { PDFDocument } from "pdf-lib";
import type {
  CalloutOverlay,
  CalloutThreadEntry,
  NoteOverlay,
  Overlay,
  OverlayTextAnchor,
  PageModel,
  TextOverlay,
} from "../model/types";
import type { PdfLink } from "../engine/types";
import { pdfPointToPageLocal, pdfRectToPageLocal } from "../model/pageSpace";
import { freeTextRichTextStyle, freeTextStyle } from "./freeTextStyle";
import {
  ANNOT,
  alignFromNumber,
  annotationType,
  colorToHex,
  contentsText,
  importAnnotationByType,
  numberValue,
  parseDefaultAppearanceFontSize,
  recordValue,
  rectFromAnnot,
  type PdfjsAnnotation,
} from "./listingImporters";
import {
  MAX_UNINDEXED_RAW_CALLOUTS,
  loadRawPdf,
  readRawCallouts,
  type RawAnnotationData,
  type RawCallout,
  type RawReplyMeta,
} from "./rawAnnotations";
import { readSourceAnnotations } from "./sourceAnnotations";

const STABLE_PDFJS_ANNOTATION_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export type PdfAnnotationImportOptions = {
  /**
   * Every supplied page still participates in canvas-ownership suppression,
   * but only these pages return overlays for insertion into the model.
   * Omit this to import overlays from every supplied page.
   */
  overlayPageIds?: ReadonlySet<string>;
  /** Reports source properties discovered by the existing pdf-lib raw scan. */
  onSourceInfo?: (info: { encrypted: boolean | null }) => void;
  /**
   * Reports every source annotation Shiori takes over from the page raster,
   * so the engine can hide the same ones. `rect` is the annotation's /Rect,
   * normalized.
   */
  onSuppress?: (
    sourceIndex: number,
    annotation: { subtype: string; rect: [number, number, number, number] },
  ) => void;
  /**
   * Reports each page's links whose action is a named navigation action
   * (FirstPage, NextPage, …), read from the raw file: PDFium has no API for
   * them, so an engine drawing with it merges these into the page's links.
   */
  onNamedLinks?: (sourceIndex: number, links: PdfLink[]) => void;
  /**
   * The source rewritten without its encryption, from an engine that can
   * decrypt (PDFium). With it an encrypted file is read like any other; the
   * object numbers, and so the overlay ids, are the file's own.
   */
  decryptedBytes?: () => Promise<Uint8Array>;
  /**
   * Throw when the file's annotations cannot be read, instead of importing
   * them as none: pdf-lib cannot parse or decrypt the file, a page's /Annots
   * does not resolve to an array, or pdf-lib's page tree lacks the page. For
   * a caller that must tell "no annotations" from "unknown" (the CLI's
   * `extract`); the app stays lenient, so such a file still opens and draws.
   */
  strict?: boolean;
};

// Subtypes Shiori draws itself without importing them as overlays: links as
// real anchors (PdfLinkLayer), popups as its own note UI.
const SHIORI_DRAWN_SUBTYPES = new Set(["Link", "Popup"]);

/**
 * Turns the source PDF's annotations into editable overlays, read from the
 * file with pdf-lib (./sourceAnnotations, in the shape pdf.js listed them so
 * imports and draft ids carry over). An encrypted file is read through the
 * engine's decrypted copy (`decryptedBytes`); without one, or for a file
 * pdf-lib cannot parse, nothing is imported.
 *
 * Ownership is decided in exactly one place: every annotation Shiori takes
 * over, and so draws itself, is reported through `onSuppress`, and the
 * engine keeps it out of the page raster. Those left unclaimed — arrows,
 * ellipses, polygons, stamps, file attachments, form fields — are drawn from
 * their own appearance streams.
 */
export async function importFileAnnotations(
  pages: PageModel[],
  bytes: Uint8Array,
  now: number = Date.now(),
  options: PdfAnnotationImportOptions = {},
): Promise<Overlay[]> {
  const overlays: Overlay[] = [];
  // Thread replies whose parent callout may appear anywhere in its page's
  // annotation order; folded after the page finishes importing.
  const pendingThreadFolds: Array<{
    note: NoteOverlay;
    meta: RawReplyMeta;
  }> = [];
  let rawData: RawAnnotationData = {
    callouts: new Map(),
    namedLinks: new Map(),
    interiorColors: new Map(),
    anchors: new Map(),
    replies: new Map(),
    rects: new Map(),
    encrypted: null,
  };
  let rawPdf: PDFDocument | null = null;
  try {
    rawPdf = await loadRawPdf(bytes);
    const encrypted = rawPdf?.isEncrypted ?? null;
    if (rawPdf?.isEncrypted && options.decryptedBytes) {
      const clear = await loadRawPdf(await options.decryptedBytes()).catch(() => null);
      if (clear && !clear.isEncrypted) rawPdf = clear;
    }
    if (rawPdf) rawData = { ...readRawCallouts(rawPdf, pages), encrypted };
  } catch {
    // The raw pass (callouts, /IC, anchors, replies) is best effort: if it
    // fails, the annotations still import without what it adds. A file
    // pdf-lib cannot parse at all imports nothing; the engine still draws it.
  }
  // The file itself, read with pdf-lib (./sourceAnnotations), unless it is
  // still encrypted: pdf-lib cannot decrypt its strings.
  const fileReader = rawPdf && !rawPdf.isEncrypted ? rawPdf : null;
  if (options.strict && !fileReader) {
    throw new Error(
      rawPdf ? "pdf-lib cannot read an encrypted file's annotations" : "pdf-lib could not parse the file",
    );
  }
  options.onSourceInfo?.({ encrypted: rawData.encrypted });
  for (const [sourceIndex, links] of rawData.namedLinks) {
    options.onNamedLinks?.(sourceIndex, links);
  }
  for (const page of pages) {
    const returnPageOverlays =
      options.overlayPageIds === undefined ||
      options.overlayPageIds.has(page.id);
    const annotations = fileReader
      ? (readSourceAnnotations(fileReader, page.sourceIndex, options.strict) ?? [])
      : [];
    const pageCallouts = rawData.callouts.get(page.sourceIndex) ?? [];
    const pageInteriorColors = rawData.interiorColors.get(page.sourceIndex);
    const pageAnchors = rawData.anchors.get(page.sourceIndex);
    const pageReplies = rawData.replies.get(page.sourceIndex);
    const pageRects = rawData.rects.get(page.sourceIndex);
    const anchorFor = (id: unknown): OverlayTextAnchor | undefined =>
      typeof id === "string" ? pageAnchors?.get(id) : undefined;
    const calloutIndex = indexRawCallouts(pageCallouts);
    const suppress = (annot: PdfjsAnnotation) => {
      // The file's /Rect, which PDFium hides by: the listing, as pdf.js did,
      // swaps in the bounds of the appearance it draws for a markup that has
      // none.
      const rect = (typeof annot.id === "string" ? pageRects?.get(annot.id) : undefined) ?? (annot.rect as unknown);
      if (
        typeof annot.subtype === "string" &&
        Array.isArray(rect) &&
        rect.length === 4 &&
        rect.every((value) => typeof value === "number")
      ) {
        options.onSuppress?.(page.sourceIndex, {
          subtype: annot.subtype,
          rect: rect as [number, number, number, number],
        });
      }
    };
    for (const annot of annotations) {
      const rawCallout = matchingRawCallout(annot, calloutIndex);
      if (rawCallout) {
        const callout = importRawCallout(rawCallout, annot, page);
        if (callout) {
          // Its /T, dates and /F, as annotationToOverlay gives every other kind.
          withSourceProvenance(callout, annot, page);
          const anchor = anchorFor(annot.id);
          if (anchor) callout.anchor = anchor;
          if (returnPageOverlays) overlays.push(callout);
          suppress(annot);
        }
        continue;
      }
      const stableId = importedAnnotationOverlayId(annot, page);
      const overlay = annotationToOverlay(
        annot,
        page,
        stableId ? () => stableId : nanoid,
        now,
      );
      if (!overlay) {
        // Not an overlay, but still not the raster's to paint: PdfLinkLayer draws
        // links as real anchors and note popups are replaced by Shiori's UI.
        if (typeof annot.subtype === "string" && SHIORI_DRAWN_SUBTYPES.has(annot.subtype)) {
          suppress(annot);
        }
        continue;
      }
      // The listing drops /IC (as pdf.js did), so the fill comes from the raw
      // pass and is applied here where both the overlay and that pass's data
      // are in scope.
      if (overlay.type === "rect" && pageInteriorColors) {
        const annotId = typeof annot.id === "string" ? annot.id : null;
        const fill = annotId ? pageInteriorColors.get(annotId) : undefined;
        if (fill) overlay.fill = fill;
      }
      {
        // Same story for anchor provenance: the listing never exposes the
        // Shio developer dictionary, so it is joined from the raw pass here.
        const anchor = anchorFor(annot.id);
        if (anchor) overlay.anchor = anchor;
      }
      // A Shiori-exported thread reply arrives in the listing as a plain note.
      // Park it for folding into its parent callout once the page's other
      // annotations (the parent included) exist; the canvas copy is
      // suppressed either way.
      const replyMeta =
        typeof annot.id === "string" ? pageReplies?.get(annot.id) : undefined;
      if (replyMeta && overlay.type === "note" && overlay.sourceInReplyToId) {
        if (returnPageOverlays) {
          pendingThreadFolds.push({ note: overlay, meta: replyMeta });
        }
        suppress(annot);
        continue;
      }
      if (returnPageOverlays) overlays.push(overlay);
      // Done inline rather than from a list returned at the end: if the import
      // throws part-way through a document, the pages already imported stay
      // suppressed and cannot double-draw.
      suppress(annot);
    }
    for (const rawCallout of calloutIndex.unmatched) {
      // There is no pdf.js annotation id to suppress for an unmatched raw
      // callout. Base pages already own their model overlays, so avoid
      // rebuilding a duplicate object when this page is suppression-only.
      if (!returnPageOverlays) continue;
      const callout = importRawCallout(rawCallout, null, page);
      if (callout) {
        const anchor = anchorFor(rawCallout.pdfjsId ?? undefined);
        if (anchor) callout.anchor = anchor;
        overlays.push(callout);
      }
    }
  }
  // Fold Shiori-exported replies back into their parent callout's thread.
  // sourceInReplyToId already IS the parent's imported overlay id. A reply
  // whose parent vanished (deleted in another tool) stays a standalone note
  // so its content survives the round trip.
  const calloutsById = new Map<string, CalloutOverlay>();
  for (const overlay of overlays) {
    if (overlay.type === "callout") calloutsById.set(overlay.id, overlay);
  }
  for (const fold of pendingThreadFolds) {
    const parent = fold.note.sourceInReplyToId
      ? calloutsById.get(fold.note.sourceInReplyToId)
      : undefined;
    if (!parent) {
      overlays.push(fold.note);
      continue;
    }
    const entry: CalloutThreadEntry = {
      id: fold.meta.replyId ?? nanoid(),
      role: fold.meta.role,
      text: fold.note.text,
    };
    if (fold.note.sourceAuthor) entry.author = fold.note.sourceAuthor;
    if (fold.note.sourceCreatedAt !== undefined) {
      entry.at = fold.note.sourceCreatedAt;
    }
    (parent.thread ??= []).push(entry);
  }
  // Every overlay leaving this function came out of the file, whatever path
  // built it. Marked here rather than at each construction site because
  // there is more than one and the count is not obvious — raw callouts are
  // pushed from two separate loops above without touching
  // annotationToOverlay.
  //
  // Recorded, never inferred: importing rebuilds a sticky note through
  // createNoteOverlay(..., now) so it carries today's createdAt, and folds
  // source dates into reply turns, which makes an import look freshly
  // authored to anything reading timestamps.
  return overlays.map((overlay) => markImportedOverlay(overlay, now));
}

/** Stamp an overlay as having come from the source document. */
export function markImportedOverlay<T extends Overlay>(
  overlay: T,
  importedAt: number,
): T {
  return { ...overlay, origin: "imported", importedAt };
}

type RawCalloutIndex = {
  byId: Map<string, RawCallout>;
  unmatched: Set<RawCallout>;
};

function importRawCallout(
  raw: RawCallout,
  annot: PdfjsAnnotation | null,
  page: PageModel,
): CalloutOverlay | null {
  const appearance = annot ? recordValue(annot.defaultAppearanceData) : null;
  const appearanceStyle = freeTextStyle(appearance);
  const richTextStyle = annot ? freeTextRichTextStyle(annot) : {};
  const text = annot ? contentsText(annot) || raw.text : raw.text;
  const id =
    (annot ? importedAnnotationOverlayId(annot, page) : null) ??
    (raw.pdfjsId
      ? `pdf-annotation-${page.sourceIndex}-${raw.pdfjsId}`
      : nanoid());
  const targetRects = raw.targetRects.map((rect) =>
    pdfRectToPageLocal(page, rect),
  );
  if (targetRects.length === 0) return null;
  return {
    type: "callout",
    id,
    pageId: page.id,
    rect: pdfRectToPageLocal(page, raw.labelRect),
    targetRects,
    leader: raw.leader.map((point) => pdfPointToPageLocal(page, point)),
    leaderKind: raw.leaderKind,
    text,
    fontSize: annot
      ? parseDefaultAppearanceFontSize(
          { ...annot, defaultAppearance: raw.defaultAppearance },
          appearance,
        )
      : raw.fontSize,
    color: annot
      ? colorToHex(appearance?.fontColor ?? annot.color, raw.color)
      : raw.color,
    bold: richTextStyle.bold ?? appearanceStyle.bold,
    ...((richTextStyle.italic ?? appearanceStyle.italic)
      ? { italic: true }
      : {}),
    align:
      richTextStyle.align ??
      (annot
        ? alignFromNumber(numberValue(annot.textAlignment, rawAlignNumber(raw.align)))
        : raw.align),
    fontFamily: richTextStyle.fontFamily ?? appearanceStyle.fontFamily,
  };
}

function indexRawCallouts(candidates: readonly RawCallout[]): RawCalloutIndex {
  const byId = new Map<string, RawCallout>();
  for (const candidate of candidates) {
    if (candidate.pdfjsId) byId.set(candidate.pdfjsId, candidate);
  }
  return { byId, unmatched: new Set(candidates) };
}

function matchingRawCallout(
  annot: PdfjsAnnotation,
  index: RawCalloutIndex,
): RawCallout | null {
  if (annotationType(annot) !== ANNOT.FREETEXT) return null;
  const id = typeof annot.id === "string" ? annot.id : null;
  if (id) {
    const exact = index.byId.get(id);
    if (exact && index.unmatched.delete(exact)) return exact;
  }
  const rect = rectFromAnnot(annot);
  const text = contentsText(annot);
  if (!rect || index.unmatched.size > MAX_UNINDEXED_RAW_CALLOUTS) return null;
  for (const candidate of index.unmatched) {
    if (
      nearlySameRect(candidate.outerRect, rect) &&
      (!text || !candidate.text || text === candidate.text)
    ) {
      index.unmatched.delete(candidate);
      return candidate;
    }
  }
  return null;
}

function rawAlignNumber(align: TextOverlay["align"]): number {
  return align === "center" ? 1 : align === "right" ? 2 : 0;
}

function nearlySameRect(
  a: RawCallout["outerRect"],
  b: RawCallout["outerRect"],
): boolean {
  return (
    Math.abs(a.x - b.x) < 0.05 &&
    Math.abs(a.y - b.y) < 0.05 &&
    Math.abs(a.w - b.w) < 0.05 &&
    Math.abs(a.h - b.h) < 0.05
  );
}

/**
 * pdf.js exposes the annotation object's stable PDF reference as `id`.
 * Namespacing it by source page makes imported overlay IDs survive a reopen,
 * which in turn lets presentation-only note disclosure state survive an app
 * restart. Unknown/unbounded IDs deliberately fall back to nanoid().
 */
export function importedAnnotationOverlayId(
  annot: PdfjsAnnotation,
  page: PageModel,
): string | null {
  const id = annot.id;
  if (
    !Number.isSafeInteger(page.sourceIndex) ||
    page.sourceIndex < 0 ||
    typeof id !== "string" ||
    !STABLE_PDFJS_ANNOTATION_ID.test(id)
  ) {
    return null;
  }
  return `pdf-annotation-${page.sourceIndex}-${id}`;
}

export function annotationToOverlay(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
  now: number = Date.now(),
): Overlay | null {
  const overlay = importAnnotationByType(annot, page, makeId, now);
  if (!overlay) return null;
  // Applied once here rather than in each importer: provenance is a property
  // of the source annotation, not of the shape it became.
  //
  // origin/importedAt are NOT set here. This function looked like the single
  // producer of imported overlays and is not — raw FreeText callouts are
  // built by importRawCallout and pushed directly. They are stamped at the
  // importer's actual exit instead, where nothing can bypass them.
  return withSourceProvenance(overlay, annot, page);
}

// Copies /T, /CreationDate, /M, /IRT, /RT and /F off the pdf.js annotation so
// export can write them back. Without this, a document reviewed elsewhere
// loses every reviewer name and timestamp the first time it is exported, and
// reply threads collapse into unrelated top-level notes.
export function withSourceProvenance<T extends Overlay>(
  overlay: T,
  annot: PdfjsAnnotation,
  page: PageModel,
): T {
  const author = pdfjsTitle(annot);
  if (author) overlay.sourceAuthor = author;

  const created = parsePdfDateString(stringValue(annot.creationDate));
  if (created !== undefined) overlay.sourceCreatedAt = created;

  const modified = parsePdfDateString(stringValue(annot.modificationDate));
  if (modified !== undefined) overlay.sourceModifiedAt = modified;

  const inReplyTo = stringValue(annot.inReplyTo);
  if (inReplyTo && STABLE_PDFJS_ANNOTATION_ID.test(inReplyTo)) {
    overlay.sourceInReplyToId = `pdf-annotation-${page.sourceIndex}-${inReplyTo}`;
  }
  const replyType = stringValue(annot.replyType);
  if (replyType === "R" || replyType === "Group") {
    overlay.sourceReplyType = replyType;
  }
  if (typeof annot.annotationFlags === "number") overlay.sourceFlags = annot.annotationFlags;
  return overlay;
}

// pdf.js reports /T as `titleObj: { str, dir }` on markup annotations, and
// older shapes sometimes carry a plain `title`.
function pdfjsTitle(annot: PdfjsAnnotation): string | undefined {
  const titleObj = recordValue(annot.titleObj);
  const fromObj = stringValue(titleObj?.str);
  if (fromObj) return fromObj.slice(0, 512);
  const plain = stringValue(annot.title);
  return plain ? plain.slice(0, 512) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// PDF date strings look like D:YYYYMMDDHHmmSSOHH'mm'. Everything after the
// year is optional, and real files are frequently sloppy about the offset, so
// parse defensively and give up rather than inventing a date.
export function parsePdfDateString(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match =
    /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+\-Z])(\d{2})'?(\d{2})?'?)?/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, sign, offH, offM] = match;
  const year = Number(y);
  if (!Number.isFinite(year) || year < 1000 || year > 9999) return undefined;

  let ms = Date.UTC(
    year,
    mo ? Number(mo) - 1 : 0,
    d ? Number(d) : 1,
    h ? Number(h) : 0,
    mi ? Number(mi) : 0,
    s ? Number(s) : 0,
  );
  if (!Number.isFinite(ms)) return undefined;
  if (sign && sign !== "Z") {
    const offsetMinutes = Number(offH ?? 0) * 60 + Number(offM ?? 0);
    if (!Number.isFinite(offsetMinutes)) return undefined;
    // The offset states the local zone, so undo it to reach UTC.
    ms += (sign === "+" ? -1 : 1) * offsetMinutes * 60_000;
  }
  return ms;
}
