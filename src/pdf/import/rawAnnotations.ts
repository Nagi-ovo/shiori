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
  OverlayTextAnchor,
  PageModel,
  TextOverlay,
} from "../model/types";
import { CALLOUT_DEFAULT_COLOR } from "../model/callout";
import { isNamedAction } from "../engine/namedActions";
import type { PdfLink } from "../engine/types";
import {
  MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS,
  alignFromNumber,
  colorToHex,
} from "./listingImporters";
import { pdfjsRefId } from "./sourceAnnotations";
import { sourcePageDicts } from "./sourcePages";

export type RawCallout = {
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

// Direct annotation dictionaries have no stable pdf.js ref to index. Keep the
// geometry fallback deliberately small; beyond this, preserving responsive
// import is more important than upgrading every FreeText into callout chrome.
export const MAX_UNINDEXED_RAW_CALLOUTS = 2_048;

// Raw pdf-lib pass over the source bytes for the things pdf.js does not
// surface: FreeTextCallout semantics, Square/Circle interior colour, and
// Shiori's own anchor provenance.
export type RawAnnotationData = {
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

export type RawReplyMeta = {
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

export async function loadRawPdf(bytes: Uint8Array): Promise<PDFDocument | null> {
  try {
    return await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    return null;
  }
}

export function readRawCallouts(
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
  const pdfPages = sourcePageDicts(pdf);
  for (let pageIndex = 0; pageIndex < pdfPages.length; pageIndex += 1) {
    if (!selected.has(pageIndex)) continue;
    let annots: PDFArray | undefined;
    try {
      annots = pdfPages[pageIndex]?.lookupMaybe(PDFName.of("Annots"), PDFArray);
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
          const fill = interiorColorHex(dict);
          if (fill) pageInteriorColors.set(annotationId, fill);
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

// The raw pass reads colour components as the file stores them, 0–1;
// colorToHex takes the listing's bytes.
function pdfColorHex(components: number[], fallback: string): string {
  return colorToHex(components.map((component) => component * 255), fallback);
}

// /IC is an array of 0, 1, 3 or 4 numbers (transparent, gray, RGB, CMYK).
// Only the shapes Shiori can represent as a hex fill are honoured.
function interiorColorHex(dict: PDFDict): string | null {
  const array = dict.lookupMaybe(PDFName.of("IC"), PDFArray);
  if (!array) return null;
  const numbers = pdfArrayNumbers(array, 4);
  if (numbers.length === 1) {
    const gray = numbers[0]!;
    return pdfColorHex([gray, gray, gray], "#000000");
  }
  if (numbers.length === 3) return pdfColorHex(numbers, "#000000");
  if (numbers.length === 4) {
    const [c, m, y, k] = numbers as [number, number, number, number];
    return pdfColorHex(
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
    color: pdfColorHex(
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
