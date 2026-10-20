import { nanoid } from "nanoid";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";
import type {
  CalloutOverlay,
  CalloutThreadEntry,
  HighlightOverlay,
  InkOverlay,
  NoteOverlay,
  Overlay,
  OverlayTextAnchor,
  PageModel,
  RectOverlay,
  StampOverlay,
  StrikeOutOverlay,
  TextOverlay,
  UnderlineOverlay,
} from "../model/types";
import { CALLOUT_DEFAULT_COLOR } from "../model/callout";
import {
  createNoteOverlay,
  NOTE_DEFAULT_COLOR,
  NOTE_DEFAULT_HEIGHT_PT,
  NOTE_DEFAULT_WIDTH_PT,
} from "../model/note";
import { isNamedAction } from "../engine/namedActions";
import type { PdfLink } from "../engine/types";
import { coalescePdfRects } from "../geometry/rectCoalesce";
import { pdfPointToPageLocal, pdfRectToPageLocal } from "../model/pageSpace";
import { freeTextRichTextStyle, freeTextStyle } from "./freeTextStyle";
import { pdfjsRefId, readSourceAnnotations } from "./sourceAnnotations";

const IMPORTED_HIGHLIGHT_MAX_OPACITY = 0.45;
const STABLE_PDFJS_ANNOTATION_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

const ANNOT = {
  TEXT: 1,
  FREETEXT: 3,
  SQUARE: 5,
  HIGHLIGHT: 9,
  UNDERLINE: 10,
  STRIKEOUT: 12,
  INK: 15,
} as const;

type PdfjsAnnotation = Record<string, unknown>;

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

type RawCallout = {
  pdfjsId: string | null;
  outerRect: { x: number; y: number; w: number; h: number };
  labelRect: { x: number; y: number; w: number; h: number };
  targetRects: Array<{ x: number; y: number; w: number; h: number }>;
  leader: Array<{ x: number; y: number }>;
  leaderKind: CalloutOverlay["leaderKind"];
  text: string;
  color: string;
  fontSize: number;
  align: TextOverlay["align"];
  defaultAppearance: string;
};

type RawCalloutIndex = {
  byId: Map<string, RawCallout>;
  unmatched: Set<RawCallout>;
};

// Direct annotation dictionaries have no stable pdf.js ref to index. Keep the
// geometry fallback deliberately small; beyond this, preserving responsive
// import is more important than upgrading every FreeText into callout chrome.
const MAX_UNINDEXED_RAW_CALLOUTS = 2_048;
const MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS = 65_536;
const MAX_IMPORTED_NUMBER_ARRAY_VALUES = 200_000;

// Raw pdf-lib pass over the source bytes for the things pdf.js does not
// surface: FreeTextCallout semantics, Square/Circle interior colour, and
// Shiori's own anchor provenance.
type RawAnnotationData = {
  callouts: Map<number, RawCallout[]>;
  // page index -> links whose /A is a Named action
  namedLinks: Map<number, PdfLink[]>;
  // page index -> pdf.js annotation id -> "#rrggbb"
  interiorColors: Map<number, Map<string, string>>;
  // page index -> pdf.js annotation id -> text-anchor provenance from the
  // Shio developer dictionary (written by Shiori's own export).
  anchors: Map<number, Map<string, OverlayTextAnchor>>;
  // page index -> pdf.js annotation id of a Shiori-exported thread reply ->
  // its role metadata. pdf.js surfaces the reply as an ordinary Text
  // annotation; this map is what lets import fold it back into the parent
  // callout's thread instead of leaving a stray note.
  replies: Map<number, Map<string, RawReplyMeta>>;
  // page index -> pdf.js annotation id -> the file's /Rect, normalized
  rects: Map<number, Map<string, [number, number, number, number]>>;
  encrypted: boolean | null;
};

type RawReplyMeta = {
  role: CalloutThreadEntry["role"];
  replyId: string | null;
};

/** A Link annotation whose /A is a Named navigation action, or null. */
function namedLinkFromDict(dict: PDFDict): PdfLink | null {
  const action = dict.lookupMaybe(PDFName.of("A"), PDFDict);
  if (action?.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText() !== "Named") return null;
  const name = action.lookupMaybe(PDFName.of("N"), PDFName)?.decodeText();
  if (!isNamedAction(name)) return null;
  const rect = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
  if (!rect || rect.size() !== 4) return null;
  const values = [0, 1, 2, 3].map((i) => rect.lookupMaybe(i, PDFNumber)?.asNumber());
  if (values.some((value) => value === undefined)) return null;
  const [x1, y1, x2, y2] = values as number[];
  return {
    rect: [Math.min(x1!, x2!), Math.min(y1!, y2!), Math.max(x1!, x2!), Math.max(y1!, y2!)],
    destination: null,
    url: null,
    action: name,
  };
}

async function loadRawPdf(bytes: Uint8Array): Promise<PDFDocument | null> {
  try {
    return await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    return null;
  }
}

function readRawCallouts(
  pdf: PDFDocument,
  pages: PageModel[],
): RawAnnotationData {
  const selected = new Set(pages.map((page) => page.sourceIndex));
  const output = new Map<number, RawCallout[]>();
  const namedLinks = new Map<number, PdfLink[]>();
  const interiorColors = new Map<number, Map<string, string>>();
  const anchors = new Map<number, Map<string, OverlayTextAnchor>>();
  const replies = new Map<number, Map<string, RawReplyMeta>>();
  const rects = new Map<number, Map<string, [number, number, number, number]>>();
  const pdfPages = pdf.getPages();
  for (let pageIndex = 0; pageIndex < pdfPages.length; pageIndex += 1) {
    if (!selected.has(pageIndex)) continue;
    let annots: PDFArray | undefined;
    try {
      annots = pdfPages[pageIndex]!.node.Annots();
    } catch {
      continue;
    }
    if (!annots) continue;
    const callouts: RawCallout[] = [];
    const pageNamedLinks: PdfLink[] = [];
    const pageInteriorColors = new Map<string, string>();
    const pageAnchors = new Map<string, OverlayTextAnchor>();
    const pageReplies = new Map<string, RawReplyMeta>();
    const pageRects = new Map<string, [number, number, number, number]>();
    // pdf.js names a direct annotation dictionary by its place among the
    // page's direct ones (sourceAnnotations.ts).
    let directCount = 0;
    for (let index = 0; index < annots.size(); index += 1) {
      try {
        const rawObject = annots.get(index);
        const dict = annots.lookupMaybe(index, PDFDict);
        if (!dict) continue;
        const subtype = dict
          .lookupMaybe(PDFName.of("Subtype"), PDFName)
          ?.decodeText();

        // Anchor provenance can sit on any Shiori-exported annotation; pdf.js
        // never surfaces developer dictionaries, so it is read here and joined
        // back to the imported overlay by pdf.js annotation id.
        const annotationId =
          rawObject instanceof PDFRef ? pdfjsIdForRef(rawObject) : `annot_p${pageIndex}_${++directCount}`;
        const bounds = pdfBoundsRect(pdfArrayNumbers(dict.lookupMaybe(PDFName.of("Rect"), PDFArray), 4));
        if (bounds) {
          pageRects.set(annotationId, [bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h]);
        }
        if (rawObject instanceof PDFRef) {
          const anchor = anchorFromShioDict(dict);
          if (anchor) pageAnchors.set(pdfjsIdForRef(rawObject), anchor);
          const replyMeta = replyMetaFromShioDict(dict);
          if (replyMeta) pageReplies.set(pdfjsIdForRef(rawObject), replyMeta);
        }

        // /IC (interior colour) is the fill of a Square or Circle. pdf.js
        // parses it into a local variable and never puts it on `data`, so a
        // filled rectangle imported as outline-only and the fill was gone from
        // the file for good after the next export.
        if (subtype === "Square" || subtype === "Circle") {
          const id =
            rawObject instanceof PDFRef ? pdfjsIdForRef(rawObject) : null;
          const fill = interiorColorHex(dict);
          if (id && fill) pageInteriorColors.set(id, fill);
        }

        if (subtype === "Link") {
          const named = namedLinkFromDict(dict);
          if (named) pageNamedLinks.push(named);
          continue;
        }

        const intent = dict.lookupMaybe(PDFName.of("IT"), PDFName)?.decodeText();
        if (subtype !== "FreeText" || intent !== "FreeTextCallout") continue;
        const descriptor = rawCalloutFromDict(
          dict,
          rawObject instanceof PDFRef ? pdfjsIdForRef(rawObject) : null,
        );
        if (descriptor) callouts.push(descriptor);
      } catch {
        // One malformed annotation must not suppress every valid annotation
        // already imported from the same document.
        continue;
      }
    }
    if (callouts.length > 0) {
      const indexed = callouts.filter((callout) => callout.pdfjsId !== null);
      const unindexed = callouts
        .filter((callout) => callout.pdfjsId === null)
        .slice(0, MAX_UNINDEXED_RAW_CALLOUTS);
      output.set(pageIndex, [...indexed, ...unindexed]);
    }
    if (pageNamedLinks.length > 0) namedLinks.set(pageIndex, pageNamedLinks);
    if (pageInteriorColors.size > 0) {
      interiorColors.set(pageIndex, pageInteriorColors);
    }
    if (pageAnchors.size > 0) anchors.set(pageIndex, pageAnchors);
    if (pageReplies.size > 0) replies.set(pageIndex, pageReplies);
    if (pageRects.size > 0) rects.set(pageIndex, pageRects);
  }
  return {
    callouts: output,
    namedLinks,
    interiorColors,
    anchors,
    replies,
    rects,
    encrypted: pdf.isEncrypted,
  };
}

const MAX_IMPORTED_REPLY_ID_CHARACTERS = 128;

// Recognizes a thread reply Shiori itself exported: Shio { V:1, Kind:
// "Reply", Role, ReplyId }. Anything else — including replies written by
// other PDF tools — returns undefined and keeps today's standalone-note
// import behaviour.
function replyMetaFromShioDict(dict: PDFDict): RawReplyMeta | undefined {
  const shio = dict.lookupMaybe(PDFName.of("Shio"), PDFDict);
  if (!shio) return undefined;
  const version = shio.lookupMaybe(PDFName.of("V"), PDFNumber)?.asNumber();
  const kind = shio.lookupMaybe(PDFName.of("Kind"), PDFName)?.decodeText();
  if (version !== 1 || kind !== "Reply") return undefined;
  const role =
    shio.lookupMaybe(PDFName.of("Role"), PDFName)?.decodeText() === "Agent"
      ? ("agent" as const)
      : ("user" as const);
  const replyIdRaw = shio
    .lookupMaybe(PDFName.of("ReplyId"), PDFString, PDFHexString)
    ?.decodeText();
  const replyId =
    replyIdRaw &&
    replyIdRaw.length <= MAX_IMPORTED_REPLY_ID_CHARACTERS
      ? replyIdRaw
      : null;
  return { role, replyId };
}

// Imported quotes are bounded so a hostile file cannot balloon the model;
// anything oversized or malformed degrades to "no anchor", never to a
// failed import.
const MAX_IMPORTED_ANCHOR_QUOTE_CHARACTERS = 8192;

function anchorFromShioDict(dict: PDFDict): OverlayTextAnchor | undefined {
  const shio = dict.lookupMaybe(PDFName.of("Shio"), PDFDict);
  if (!shio) return undefined;
  const version = shio.lookupMaybe(PDFName.of("V"), PDFNumber)?.asNumber();
  if (version !== 1) return undefined;
  const anchor = shio.lookupMaybe(PDFName.of("Anchor"), PDFDict);
  if (!anchor) return undefined;
  const quote = anchor
    .lookupMaybe(PDFName.of("Q"), PDFString, PDFHexString)
    ?.decodeText();
  const page = anchor.lookupMaybe(PDFName.of("Pg"), PDFNumber)?.asNumber();
  if (
    !quote ||
    quote.length > MAX_IMPORTED_ANCHOR_QUOTE_CHARACTERS ||
    !Number.isSafeInteger(page) ||
    page! < 1
  ) {
    return undefined;
  }
  // Occ is optional (in-app capture omits it), but when the key IS present
  // its value must be sane — a corrupt count poisons re-anchoring, so the
  // whole anchor degrades rather than surviving half-trusted.
  if (anchor.has(PDFName.of("Occ"))) {
    const occurrence = anchor
      .lookupMaybe(PDFName.of("Occ"), PDFNumber)
      ?.asNumber();
    if (!Number.isSafeInteger(occurrence) || occurrence! < 1) {
      return undefined;
    }
    return { quote, page: page!, occurrence: occurrence! };
  }
  return { quote, page: page! };
}

// /IC is an array of 0, 1, 3 or 4 numbers (transparent, gray, RGB, CMYK).
// Only the shapes Shiori can represent as a hex fill are honoured.
function interiorColorHex(dict: PDFDict): string | null {
  const array = dict.lookupMaybe(PDFName.of("IC"), PDFArray);
  if (!array) return null;
  const numbers = pdfArrayNumbers(array, 4);
  if (numbers.length === 1) {
    const gray = numbers[0]!;
    return colorToHex([gray, gray, gray], "#000000");
  }
  if (numbers.length === 3) return colorToHex(numbers, "#000000");
  if (numbers.length === 4) {
    const [c, m, y, k] = numbers as [number, number, number, number];
    return colorToHex(
      [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)],
      "#000000",
    );
  }
  // Length 0 means explicitly no interior colour.
  return null;
}

function rawCalloutFromDict(
  dict: PDFDict,
  pdfjsId: string | null,
): RawCallout | null {
  const outerValues = pdfArrayNumbers(
    dict.lookupMaybe(PDFName.of("Rect"), PDFArray),
    4,
  );
  const outerRect = pdfBoundsRect(outerValues);
  const standardLeader = pdfLeader(
    pdfArrayNumbers(dict.lookupMaybe(PDFName.of("CL"), PDFArray), 6),
  );
  // A malformed callout remains importable through the ordinary FreeText
  // path. Returning null here intentionally leaves it to that fallback.
  if (!outerRect || !standardLeader) return null;

  const shio = dict.lookupMaybe(PDFName.of("Shio"), PDFDict);
  const shioVersion = shio
    ?.lookupMaybe(PDFName.of("V"), PDFNumber)
    ?.asNumber();
  const shioKind = shio
    ?.lookupMaybe(PDFName.of("Kind"), PDFName)
    ?.decodeText();
  const validShio = shioVersion === 1 && shioKind === "Callout";
  const shioLabel = validShio
    ? pdfStoredRect(
        pdfArrayNumbers(shio!.lookupMaybe(PDFName.of("LabelRect"), PDFArray), 4),
      )
    : null;
  const shioTargets = validShio ? shioTargetRects(shio!) : null;
  const shioLeader = validShio
    ? pdfLeader(
        pdfArrayNumbers(shio!.lookupMaybe(PDFName.of("Leader"), PDFArray), 6),
      )
    : null;
  const shioLeaderKind = validShio
    ? shio!
        .lookupMaybe(PDFName.of("LeaderKind"), PDFName)
        ?.decodeText()
    : null;
  const rd = pdfArrayNumbers(dict.lookupMaybe(PDFName.of("RD"), PDFArray), 4);
  // Standard fields are authoritative after an external editor touches the
  // annotation. Unknown developer dictionaries are commonly preserved, so
  // preferring Shio here would resurrect stale pre-edit geometry.
  const labelRect =
    labelRectFromDifferences(outerRect, rd) ?? shioLabel ?? outerRect;
  const leader = standardLeader;
  const metadataMatchesLeader =
    shioLeader !== null && sameLeader(shioLeader, standardLeader);
  const targetRects =
    shioTargets && metadataMatchesLeader
      ? shioTargets
      : [targetRectAroundPoint(leader[0]!, outerRect)];
  const defaultAppearance = decodePdfText(
    dict.lookupMaybe(PDFName.of("DA"), PDFString, PDFHexString),
  );
  return {
    pdfjsId,
    outerRect,
    labelRect,
    targetRects,
    leader,
    leaderKind:
      metadataMatchesLeader && shioLeaderKind === "Quadratic"
        ? "quadratic"
        : "polyline",
    text: decodePdfText(
      dict.lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString),
    ).slice(0, MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS),
    color: colorToHex(
      pdfArrayNumbers(dict.lookupMaybe(PDFName.of("C"), PDFArray), 4),
      CALLOUT_DEFAULT_COLOR,
    ),
    fontSize: fontSizeFromDefaultAppearance(defaultAppearance),
    align: alignFromNumber(
      dict.lookupMaybe(PDFName.of("Q"), PDFNumber)?.asNumber() ?? 0,
    ),
    defaultAppearance,
  };
}

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

const pdfjsIdForRef = pdfjsRefId;

function pdfArrayNumbers(array: PDFArray | undefined, maxLength: number): number[] {
  if (!array || array.size() > maxLength) return [];
  const values: number[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    const value = array.lookupMaybe(index, PDFNumber)?.asNumber();
    if (value === undefined || !Number.isFinite(value)) return [];
    values.push(value);
  }
  return values;
}

function pdfBoundsRect(values: number[]): RawCallout["outerRect"] | null {
  if (values.length !== 4) return null;
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  const rect = {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
  return rect.w > 0 && rect.h > 0 ? rect : null;
}

function pdfStoredRect(values: number[]): RawCallout["labelRect"] | null {
  if (values.length !== 4) return null;
  const [x, y, w, h] = values as [number, number, number, number];
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function pdfLeader(values: number[]): RawCallout["leader"] | null {
  if (values.length !== 4 && values.length !== 6) return null;
  const points = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    points.push({ x: values[index]!, y: values[index + 1]! });
  }
  return points;
}

function shioTargetRects(shio: PDFDict): RawCallout["targetRects"] | null {
  const array = shio.lookupMaybe(PDFName.of("TargetRects"), PDFArray);
  if (!array || array.size() === 0 || array.size() > 10_000) return null;
  const rects = [];
  for (let index = 0; index < array.size(); index += 1) {
    const rect = pdfStoredRect(
      pdfArrayNumbers(array.lookupMaybe(index, PDFArray), 4),
    );
    if (!rect) return null;
    rects.push(rect);
  }
  return rects;
}

function labelRectFromDifferences(
  outer: RawCallout["outerRect"],
  values: number[],
): RawCallout["labelRect"] | null {
  if (values.length !== 4) return null;
  const [left, top, right, bottom] = values as [number, number, number, number];
  if (values.some((value) => value < 0)) return null;
  const rect = {
    x: outer.x + left,
    y: outer.y + bottom,
    w: outer.w - left - right,
    h: outer.h - top - bottom,
  };
  return rect.w > 0 && rect.h > 0 ? rect : null;
}

function sameLeader(
  a: RawCallout["leader"],
  b: RawCallout["leader"],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (point, index) =>
        Math.abs(point.x - b[index]!.x) < 0.05 &&
        Math.abs(point.y - b[index]!.y) < 0.05,
    )
  );
}

function targetRectAroundPoint(
  point: { x: number; y: number },
  outer: RawCallout["outerRect"],
): RawCallout["outerRect"] {
  const size = Math.max(4, Math.min(12, Math.min(outer.w, outer.h) * 0.08));
  return { x: point.x - size / 2, y: point.y - size / 2, w: size, h: size };
}

function decodePdfText(value: PDFString | PDFHexString | undefined): string {
  try {
    return value?.decodeText() ?? "";
  } catch {
    return "";
  }
}

function fontSizeFromDefaultAppearance(value: string): number {
  const match = value.match(/\S+\s+(\d+(?:\.\d+)?)\s+Tf/);
  const size = match ? Number(match[1]) : NaN;
  return Number.isFinite(size) && size > 0 ? size : 12;
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

function importAnnotationByType(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
  now: number,
): Overlay | null {
  const type = annotationType(annot);
  if (type === ANNOT.HIGHLIGHT) return importHighlight(annot, page, makeId);
  if (type === ANNOT.UNDERLINE) return importUnderline(annot, page, makeId);
  if (type === ANNOT.STRIKEOUT) return importStrikeOut(annot, page, makeId);
  if (type === ANNOT.TEXT) return importStickyNote(annot, page, makeId, now);
  if (type === ANNOT.SQUARE) return importSquare(annot, page, makeId);
  if (type === ANNOT.INK) return importInk(annot, page, makeId);
  if (type === ANNOT.FREETEXT) return importFreeText(annot, page, makeId);
  return null;
}

// Copies /T, /CreationDate, /M, /IRT and /RT off the pdf.js annotation so
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

type TextMarkupOverlay = HighlightOverlay | UnderlineOverlay | StrikeOutOverlay;

function importHighlight(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): HighlightOverlay | null {
  return importTextMarkup({
    type: "highlight",
    annot,
    page,
    makeId,
    fallbackColor: "#f4d674",
    opacity: Math.min(
      IMPORTED_HIGHLIGHT_MAX_OPACITY,
      numberValue(annot.opacity, IMPORTED_HIGHLIGHT_MAX_OPACITY),
    ),
  }) as HighlightOverlay | null;
}

function importUnderline(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): UnderlineOverlay | null {
  return importTextMarkup({
    type: "underline",
    annot,
    page,
    makeId,
    fallbackColor: "#b13a2e",
    opacity: numberValue(annot.opacity, 1),
  }) as UnderlineOverlay | null;
}

function importStrikeOut(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): StrikeOutOverlay | null {
  return importTextMarkup({
    type: "strikethrough",
    annot,
    page,
    makeId,
    fallbackColor: "#b13a2e",
    opacity: numberValue(annot.opacity, 1),
  }) as StrikeOutOverlay | null;
}

function importTextMarkup({
  type,
  annot,
  page,
  makeId,
  fallbackColor,
  opacity,
}: {
  type: TextMarkupOverlay["type"];
  annot: PdfjsAnnotation;
  page: PageModel;
  makeId: () => string;
  fallbackColor: string;
  opacity: number;
}): TextMarkupOverlay | null {
  const quads = toNumberArray(annot.quadPoints);
  const fallbackRect = rectFromAnnot(annot);
  const sourceRects = quads.length >= 8
    ? quadPointsToRects(quads)
    : fallbackRect
      ? [fallbackRect]
      : [];
  const coalescedRects = coalescePdfRects(
    sourceRects.map((rect) => pdfRectToPageLocal(page, rect)),
  );
  if (coalescedRects.length === 0) return null;
  return {
    type,
    id: makeId(),
    pageId: page.id,
    rects: coalescedRects,
    color: colorToHex(annot.color, fallbackColor),
    opacity: clampOpacity(opacity),
  } as TextMarkupOverlay;
}

function importStickyNote(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
  now: number,
): NoteOverlay | null {
  const rect = rectFromAnnot(annot);
  if (!rect) return null;
  const localRect = pdfRectToPageLocal(page, rect);
  return createNoteOverlay({
    id: makeId(),
    pageId: page.id,
    rect: {
      x: localRect.x,
      y: localRect.y + localRect.h - NOTE_DEFAULT_HEIGHT_PT,
      w: NOTE_DEFAULT_WIDTH_PT,
      h: NOTE_DEFAULT_HEIGHT_PT,
    },
    text: contentsText(annot),
    color: colorToHex(annot.color, NOTE_DEFAULT_COLOR),
    now,
  });
}

function importSquare(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): RectOverlay | null {
  const rect = rectFromAnnot(annot);
  if (!rect) return null;
  const border = recordValue(annot.borderStyle);
  return {
    type: "rect",
    id: makeId(),
    pageId: page.id,
    rect: pdfRectToPageLocal(page, rect),
    color: colorToHex(annot.color, "#b13a2e"),
    strokeWidth: numberValue(border?.width, 2),
    fill: null,
  };
}

function importInk(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): InkOverlay | null {
  const rawLists = Array.isArray(annot.inkLists) ? annot.inkLists : [];
  const paths = rawLists
    .map(toNumberArray)
    .map((list) => {
      const points = [];
      for (let i = 0; i + 1 < list.length; i += 2) {
        points.push({ x: list[i]!, y: list[i + 1]! });
      }
      return points.map((point) => pdfPointToPageLocal(page, point));
    })
    .filter((path) => path.length > 0);
  if (paths.length === 0) return null;
  const border = recordValue(annot.borderStyle);
  return {
    type: "ink",
    id: makeId(),
    pageId: page.id,
    paths,
    color: colorToHex(annot.color, "#b13a2e"),
    width: numberValue(border?.width, 2),
  };
}

function importFreeText(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): StampOverlay | TextOverlay | null {
  const rect = rectFromAnnot(annot);
  if (!rect) return null;
  const localRect = pdfRectToPageLocal(page, rect);
  const appearance = recordValue(annot.defaultAppearanceData);
  const text = contentsText(annot);
  const stampKind = stampKindFromText(text);
  if (stampKind && isZapfDingbatsAppearance(annot, appearance)) {
    const border = recordValue(annot.borderStyle);
    return {
      type: "stamp",
      id: makeId(),
      pageId: page.id,
      kind: stampKind,
      rect: localRect,
      color: colorToHex(annot.color ?? appearance?.fontColor, "#1a1815"),
      strokeWidth: numberValue(border?.width, 1.8),
    };
  }
  const appearanceStyle = freeTextStyle(appearance);
  const richTextStyle = freeTextRichTextStyle(annot);
  const bold = richTextStyle.bold ?? appearanceStyle.bold;
  const italic = richTextStyle.italic ?? appearanceStyle.italic;
  return {
    type: "text",
    id: makeId(),
    pageId: page.id,
    rect: localRect,
    text,
    fontSize: parseDefaultAppearanceFontSize(annot, appearance),
    color: colorToHex(appearance?.fontColor ?? annot.color, "#1a1815"),
    bold,
    ...(italic ? { italic: true } : {}),
    align:
      richTextStyle.align ??
      alignFromNumber(numberValue(annot.textAlignment, 0)),
    fontFamily: richTextStyle.fontFamily ?? appearanceStyle.fontFamily,
  };
}

function stampKindFromText(text: string): StampOverlay["kind"] | null {
  const trimmed = text.trim();
  if (trimmed === "✓") return "check";
  if (trimmed === "✗") return "cross";
  return null;
}

function isZapfDingbatsAppearance(
  annot: PdfjsAnnotation,
  appearance: Record<string, unknown> | null,
): boolean {
  const fontName = String(appearance?.fontName ?? "").toLowerCase();
  if (fontName.includes("zapf")) return true;
  return defaultAppearanceString(annot).toLowerCase().includes("zapf");
}

function parseDefaultAppearanceFontSize(
  annot: PdfjsAnnotation,
  appearance: Record<string, unknown> | null,
): number {
  const fromAppearance = numberValue(appearance?.fontSize, NaN);
  if (fromAppearance > 0) return fromAppearance;

  const match = defaultAppearanceString(annot).match(/\S+\s+(\d+(?:\.\d+)?)\s+Tf/);
  const fromDefaultAppearance = match ? Number(match[1]) : NaN;
  return Number.isFinite(fromDefaultAppearance) && fromDefaultAppearance > 0
    ? fromDefaultAppearance
    : 14;
}

function defaultAppearanceString(annot: PdfjsAnnotation): string {
  if (typeof annot.defaultAppearance === "string") return annot.defaultAppearance;
  if (typeof annot.defaultAppearanceString === "string") {
    return annot.defaultAppearanceString;
  }
  return "";
}

function annotationType(annot: PdfjsAnnotation): number | null {
  const numeric = numberValue(annot.annotationType, NaN);
  if (Number.isFinite(numeric)) return numeric;
  switch (annot.subtype) {
    case "Text":
      return ANNOT.TEXT;
    case "FreeText":
      return ANNOT.FREETEXT;
    case "Square":
      return ANNOT.SQUARE;
    case "Highlight":
      return ANNOT.HIGHLIGHT;
    case "Underline":
      return ANNOT.UNDERLINE;
    case "StrikeOut":
      return ANNOT.STRIKEOUT;
    case "Ink":
      return ANNOT.INK;
    default:
      return null;
  }
}

function rectFromAnnot(annot: PdfjsAnnotation) {
  const raw = toNumberArray(annot.rect);
  if (raw.length < 4) return null;
  const x1 = raw[0]!;
  const y1 = raw[1]!;
  const x2 = raw[2]!;
  const y2 = raw[3]!;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function quadPointsToRects(points: number[]) {
  const rects = [];
  for (let i = 0; i + 7 < points.length; i += 8) {
    const xs = [points[i]!, points[i + 2]!, points[i + 4]!, points[i + 6]!];
    const ys = [points[i + 1]!, points[i + 3]!, points[i + 5]!, points[i + 7]!];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    rects.push({
      x,
      y,
      w: Math.max(...xs) - x,
      h: Math.max(...ys) - y,
    });
  }
  return rects;
}

function colorToHex(value: unknown, fallback: string): string {
  const parts = toNumberArray(value);
  if (parts.length < 3) return fallback;
  const hex = parts
    .slice(0, 3)
    .map((part) => {
      const channel = part <= 1 ? Math.round(part * 255) : Math.round(part);
      return Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0");
    })
    .join("");
  return `#${hex}`;
}

function contentsText(annot: PdfjsAnnotation): string {
  const contents = recordValue(annot.contentsObj);
  if (typeof contents?.str === "string") {
    return contents.str.slice(0, MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS);
  }
  if (Array.isArray(annot.textContent)) {
    let text = "";
    for (const part of annot.textContent) {
      if (typeof part !== "string") continue;
      const remaining = MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS - text.length;
      if (remaining <= 0) break;
      if (text) text += "\n";
      text += part.slice(0, remaining);
    }
    return text.slice(0, MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS);
  }
  return "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function toNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    if (value.length > MAX_IMPORTED_NUMBER_ARRAY_VALUES) return [];
    return value.filter((n): n is number => typeof n === "number");
  }
  if (ArrayBuffer.isView(value) && "length" in value) {
    if ((value as unknown as ArrayLike<number>).length > MAX_IMPORTED_NUMBER_ARRAY_VALUES) {
      return [];
    }
    return Array.from(value as unknown as ArrayLike<number>);
  }
  const record = recordValue(value);
  if (!record) return [];
  const numericKeys: string[] = [];
  for (const key in record) {
    if (!/^\d+$/.test(key) || typeof record[key] !== "number") continue;
    numericKeys.push(key);
    if (numericKeys.length > MAX_IMPORTED_NUMBER_ARRAY_VALUES) return [];
  }
  return numericKeys
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => record[key] as number);
}

function alignFromNumber(q: number): TextOverlay["align"] {
  if (q === 1) return "center";
  if (q === 2) return "right";
  return "left";
}
