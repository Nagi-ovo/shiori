import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  pdfDocEncodingDecode,
} from "pdf-lib";
import { freeTextAppearance } from "./appearanceStream";
import { latin1, lookup, rgbColor } from "./pdfjsValues";
import { richTextRoot } from "./richText";
import { sourcePageDicts } from "./sourcePages";

/**
 * A page's annotations read straight from the file with pdf-lib, in the shape
 * pdf.js's `getAnnotations({ intent: "display" })` hands the importer
 * (docs/PLAN-RUST-PDF-CORE-2026-09.md, stage 4.4). Only the subtypes the
 * importer turns into overlays or draws itself are read, and of those only
 * the fields it consumes; each follows pdf.js 5.6's annotation.js so an
 * import reads as it did when pdf.js listed the annotations. The ids are
 * pdf.js's too (`12R` for an indirect annotation), so drafts keyed by them
 * carry over.
 *
 * pdf-lib cannot decrypt, so an encrypted file is not read here
 * (`readSourceAnnotations` returns null); the importer reads the engine's
 * decrypted copy instead.
 */

export type SourceAnnotation = Record<string, unknown>;

// pdf.js's AnnotationFlag.
const INVISIBLE = 0x01;
const HIDDEN = 0x02;
const NOVIEW = 0x20;
// The subtypes pdf.js builds its own class for. setFlags drops INVISIBLE for
// them; only the base class for an unknown subtype keeps it.
const KNOWN_SUBTYPES = new Set([
  "Link", "Text", "Widget", "Popup", "FreeText", "Line", "Square", "Circle",
  "PolyLine", "Polygon", "Caret", "Ink", "Highlight", "Underline", "Squiggly",
  "StrikeOut", "Stamp", "FileAttachment",
]);
const MARKUP_SUBTYPES = new Set(["Text", "FreeText", "Square", "Ink", "Highlight", "Underline", "StrikeOut"]);
const QUAD_SUBTYPES = new Set(["Highlight", "Underline", "StrikeOut"]);
/** What the importer reads: its overlay subtypes, and the ones Shiori draws. */
const READ_SUBTYPES = new Set([...MARKUP_SUBTYPES, "Link", "Popup"]);
const TEXT_ICON_SIZE = 22;

/**
 * One page's annotations as pdf.js lists them for display: the page's
 * /Annots in order, popups last, without those pdf.js would not show.
 * Null when the file is encrypted. A page pdf-lib does not have, or whose
 * /Annots is not an array, lists none; `strict` throws for those instead.
 */
export function readSourceAnnotations(
  pdf: PDFDocument,
  pageIndex: number,
  strict = false,
): SourceAnnotation[] | null {
  if (pdf.isEncrypted) return null;
  const page = sourcePageDicts(pdf)[pageIndex];
  if (!page) {
    if (strict) throw new Error(`pdf-lib finds no page ${pageIndex + 1} in the page tree`);
    return [];
  }
  let annots: PDFArray | undefined;
  try {
    annots = page.lookupMaybe(PDFName.of("Annots"), PDFArray);
  } catch (error) {
    if (strict) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`page ${pageIndex + 1}'s /Annots is not an array: ${detail}`);
    }
    return [];
  }
  if (!annots) return [];
  const acroFormDA = latin1(lookup(pdf.catalog, "AcroForm", PDFDict)?.lookup(PDFName.of("DA")));
  const ordered: SourceAnnotation[] = [];
  const popups: SourceAnnotation[] = [];
  // pdf.js names a direct annotation dictionary `annot_p<page>_<n>`, counting
  // the page's direct dictionaries in order.
  let directCount = 0;
  for (let index = 0; index < annots.size(); index += 1) {
    try {
      const raw = annots.get(index);
      const dict = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw;
      if (!(dict instanceof PDFDict)) continue;
      const id = raw instanceof PDFRef ? pdfjsRefId(raw) : `annot_p${pageIndex}_${++directCount}`;
      const subtype = lookup(dict, "Subtype", PDFName)?.decodeText() ?? null;
      if (!subtype || !READ_SUBTYPES.has(subtype)) continue;
      const annotation = readAnnotation(dict, subtype, id, acroFormDA);
      if (!annotation) continue;
      (subtype === "Popup" ? popups : ordered).push(annotation);
    } catch {
      // pdf.js skips an annotation it cannot build; so does this.
      continue;
    }
  }
  return [...ordered, ...popups];
}

export function pdfjsRefId(ref: PDFRef): string {
  return ref.generationNumber === 0
    ? `${ref.objectNumber}R`
    : `${ref.objectNumber}R${ref.generationNumber}`;
}

function readAnnotation(
  dict: PDFDict,
  subtype: string,
  id: string,
  acroFormDA: string | undefined,
): SourceAnnotation | null {
  let flags = annotationFlags(dict);
  const rect = normalRect(lookup(dict, "Rect", PDFArray)) ?? [0, 0, 0, 0];
  const data: SourceAnnotation = {
    id,
    subtype,
    rect,
    color: rgbColor(dict.lookup(PDFName.of("C"))),
    borderStyle: { width: borderWidth(dict, rect) },
    contentsObj: textObject(dict.lookup(PDFName.of("Contents"))),
    modificationDate: latin1(dict.lookup(PDFName.of("M"))) ?? null,
  };
  const appearance = normalAppearance(dict);
  // The /F as written, so export can write it back. None is 0, as pdf.js
  // reads it: shown, never printed.
  const sourceFlags = dict.lookup(PDFName.of("F"));
  if (sourceFlags === undefined) data.annotationFlags = 0;
  else if (sourceFlags instanceof PDFNumber && Number.isSafeInteger(sourceFlags.asNumber()) && sourceFlags.asNumber() >= 0) {
    data.annotationFlags = sourceFlags.asNumber();
  }

  if (MARKUP_SUBTYPES.has(subtype)) readMarkup(dict, data);

  switch (subtype) {
    case "Text":
      readNoteState(dict, data);
      if (!appearance) {
        rect[1] = rect[3]! - TEXT_ICON_SIZE;
        rect[2] = rect[0]! + TEXT_ICON_SIZE;
      }
      break;
    case "FreeText":
      data.defaultAppearanceData = freeTextAppearance(dict, appearance, acroFormDA);
      data.rotation = annotationRotation(dict);
      break;
    case "Square":
      // Without an appearance pdf.js draws one and sets the rect to its
      // bounds, taken through a Float32Array.
      if (!appearance && (borderWidthOf(data) !== 0 || rgbColor(dict.lookup(PDFName.of("IC")), null))) {
        data.rect = rect.map(Math.fround);
      }
      break;
    case "Ink":
      data.opacity = opacityAsWritten(dict);
      data.inkLists = inkLists(dict);
      break;
    case "Highlight":
      data.opacity = opacityOrOne(dict);
      break;
    // pdf.js reads /CA only for Ink and Highlight, where its `|| 1` turns 0
    // into 1. Shiori draws the others with it too, and keeps it as written,
    // 0 included, as PDFium and Acrobat draw it.
    case "Underline":
    case "StrikeOut":
      data.opacity = opacityAsWritten(dict);
      break;
  }
  if (subtype === "Square" || subtype === "FreeText") {
    data.opacity = opacityAsWritten(dict);
    const turn = appearanceTurn(appearance, rect);
    if (turn) data.appearanceTurn = turn;
  }
  if (QUAD_SUBTYPES.has(subtype)) data.quadPoints = quadPoints(dict);
  if (subtype === "Popup") {
    const parent = lookup(dict, "Parent", PDFDict);
    if (parent && !viewable(data, flags)) {
      const parentFlags = parent.lookup(PDFName.of("F"));
      const raw = parentFlags instanceof PDFNumber ? parentFlags.asNumber() : 0;
      if (!(raw & (INVISIBLE | HIDDEN | NOVIEW))) flags = annotationFlags(parent, subtype);
    }
  }
  return viewable(data, flags) ? data : null;
}

/**
 * Whether the importer is handed this annotation at all: pdf.js's display
 * filter. Export asks the same question before replacing a source
 * annotation, since only those the importer saw became overlays.
 */
export function isListedForImport(dict: PDFDict, subtype: string): boolean {
  const data: SourceAnnotation = QUAD_SUBTYPES.has(subtype) ? { quadPoints: quadPoints(dict) } : {};
  return viewable(data, annotationFlags(dict, subtype));
}

/**
 * pdf.js's `viewable`: a markup without usable quads, or NoView, is not
 * shown. Hidden too, unlike pdf.js, which lists a hidden annotation and
 * leaves it to its layer to hide: Shiori would import it as a visible
 * overlay, and export would replace it with a visible one.
 */
function viewable(data: SourceAnnotation, flags: number): boolean {
  if (data.quadPoints === null) return false;
  if (flags === 0) return true;
  return !(flags & (INVISIBLE | HIDDEN | NOVIEW));
}

function annotationFlags(dict: PDFDict, subtype = lookup(dict, "Subtype", PDFName)?.decodeText()): number {
  const value = dict.lookup(PDFName.of("F"));
  const raw = value instanceof PDFNumber ? value.asNumber() : 0;
  let flags = Number.isInteger(raw) && raw > 0 ? raw : 0;
  if (flags & INVISIBLE && subtype && KNOWN_SUBTYPES.has(subtype)) flags ^= INVISIBLE;
  return flags;
}

/** MarkupAnnotation: author, dates, reply links, rich text; a group reply takes its parent's. */
function readMarkup(dict: PDFDict, data: SourceAnnotation): void {
  const hasColor = dict.has(PDFName.of("C"));
  if (dict.has(PDFName.of("IRT"))) {
    const irt = dict.get(PDFName.of("IRT"));
    data.inReplyTo = irt instanceof PDFRef ? pdfjsRefId(irt) : null;
    data.replyType = lookup(dict, "RT", PDFName)?.decodeText() ?? "R";
  }
  if (data.replyType === "Group") {
    const parent = lookup(dict, "IRT", PDFDict);
    if (!parent) throw new Error("group reply without a parent");
    data.titleObj = textObject(parent.lookup(PDFName.of("T")));
    data.contentsObj = textObject(parent.lookup(PDFName.of("Contents")));
    data.creationDate = parent.has(PDFName.of("CreationDate"))
      ? (latin1(parent.lookup(PDFName.of("CreationDate"))) ?? null)
      : null;
    data.modificationDate = parent.has(PDFName.of("M"))
      ? (latin1(parent.lookup(PDFName.of("M"))) ?? null)
      : null;
    data.color = parent.has(PDFName.of("C")) ? rgbColor(parent.lookup(PDFName.of("C"))) : null;
  } else {
    data.titleObj = textObject(dict.lookup(PDFName.of("T")));
    data.creationDate = latin1(dict.lookup(PDFName.of("CreationDate"))) ?? null;
    if (!hasColor) data.color = null;
  }
  if (dict.has(PDFName.of("RC"))) {
    data.richText = richTextRoot(latin1(dict.lookup(PDFName.of("RC"))));
  }
}

/** A sticky note's icon, whether its pop-up opens, and its review state. */
function readNoteState(dict: PDFDict, data: SourceAnnotation): void {
  const name = lookup(dict, "Name", PDFName)?.decodeText();
  if (name) data.name = name;
  const open = dict.lookup(PDFName.of("Open"));
  if (open instanceof PDFBool) data.open = open.asBoolean();
  for (const key of ["State", "StateModel"] as const) {
    const value = dict.lookup(PDFName.of(key));
    const decoded = value === undefined ? "" : textObject(value).str;
    if (decoded) data[key === "State" ? "state" : "stateModel"] = decoded;
  }
}

/** pdf.js's `_parseStringHelper`: a text string, decoded; "" when absent. */
function textObject(value: PDFObject | undefined): { str: string; dir: string } {
  const raw = latin1(value);
  return { str: raw === undefined ? "" : stringToPdfString(raw), dir: "ltr" };
}

/** pdf.js's stringToPDFString: a BOM picks UTF-16 or UTF-8, else PDFDocEncoding. */
export function stringToPdfString(str: string): string {
  if (str[0]! >= "\xEF") {
    let encoding: string | undefined;
    if (str[0] === "\xFE" && str[1] === "\xFF") {
      encoding = "utf-16be";
      if (str.length % 2 === 1) str = str.slice(0, -1);
    } else if (str[0] === "\xFF" && str[1] === "\xFE") {
      encoding = "utf-16le";
      if (str.length % 2 === 1) str = str.slice(0, -1);
    } else if (str[0] === "\xEF" && str[1] === "\xBB" && str[2] === "\xBF") {
      encoding = "utf-8";
    }
    if (encoding) {
      try {
        const bytes = Uint8Array.from(str, (ch) => ch.charCodeAt(0));
        const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        // A language escape (ESC … ESC) is metadata, not text.
        // eslint-disable-next-line no-control-regex
        return decoded.includes("\x1b") ? decoded.replaceAll(/\x1b[^\x1b]*(?:\x1b|$)/g, "") : decoded;
      } catch {
        // Falls through to PDFDocEncoding, as pdf.js does.
      }
    }
  }
  let out = "";
  for (let i = 0; i < str.length; i += 1) {
    if (str.charCodeAt(i) === 0x1b) {
      while (++i < str.length && str.charCodeAt(i) !== 0x1b) {
        // skip the escape sequence
      }
      continue;
    }
    out += pdfDocEncodingDecode(Uint8Array.of(str.charCodeAt(i)));
  }
  return out;
}

function numbers(array: PDFArray | undefined): number[] | null {
  if (!array) return null;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i += 1) {
    const value = array.lookup(i);
    if (!(value instanceof PDFNumber)) return null;
    out.push(value.asNumber());
  }
  return out;
}

function normalRect(array: PDFArray | undefined): number[] | null {
  const values = numbers(array);
  if (!values || values.length !== 4) return null;
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/** pdf.js's AnnotationBorderStyle width, from /BS, else /Border, else 0. */
function borderWidth(dict: PDFDict, rect: readonly number[]): number {
  const clamp = (width: number) => {
    if (width > 0) {
      const maxWidth = (rect[2]! - rect[0]!) / 2;
      const maxHeight = (rect[3]! - rect[1]!) / 2;
      if (maxWidth > 0 && maxHeight > 0 && (width > maxWidth || width > maxHeight)) return 1;
    }
    return width;
  };
  const dashes = (value: PDFObject | undefined, width: number): number => {
    if (value instanceof PDFArray) {
      const items = Array.from({ length: value.size() }, (_, i) => value.lookup(i));
      const valid = items.every((item) => item instanceof PDFNumber && item.asNumber() >= 0);
      const allZeros = items.every((item) => !(item instanceof PDFNumber) || item.asNumber() <= 0);
      return items.length === 0 || (valid && !allZeros) ? width : 0;
    }
    return value ? 0 : width;
  };
  if (dict.has(PDFName.of("BS"))) {
    const bs = dict.lookup(PDFName.of("BS"));
    if (!(bs instanceof PDFDict)) return 1;
    const type = lookup(bs, "Type", PDFName)?.decodeText();
    if (type && type !== "Border") return 1;
    const w = bs.lookup(PDFName.of("W"));
    let width = w instanceof PDFName ? 0 : w instanceof PDFNumber ? clamp(w.asNumber()) : 1;
    const d = bs.lookup(PDFName.of("D"));
    if (d instanceof PDFArray) width = dashes(d, width);
    return width;
  }
  if (dict.has(PDFName.of("Border"))) {
    const border = lookup(dict, "Border", PDFArray);
    if (!border) return 1;
    if (border.size() >= 3) {
      const w = border.lookup(2);
      let width = w instanceof PDFName ? 0 : w instanceof PDFNumber ? clamp(w.asNumber()) : 1;
      if (border.size() === 4) width = dashes(border.lookup(3), width);
      return width;
    }
    return border.size() === 0 ? 0 : 1;
  }
  return 0;
}

function borderWidthOf(data: SourceAnnotation): number {
  return (data.borderStyle as { width: number }).width;
}

/** pdf.js's setRotation: /Rotate as 0, 90, 180 or 270; anything else is 0. */
function annotationRotation(dict: PDFDict): number {
  const value = dict.lookup(PDFName.of("Rotate"));
  const angle = value instanceof PDFNumber ? value.asNumber() : 0;
  if (!Number.isInteger(angle) || angle % 90 !== 0) return 0;
  return ((angle % 360) + 360) % 360;
}

/**
 * The turn an appearance's /Matrix gives a box (Shiori's own) when it is a
 * rotation, and its unturned size: the BBox, scaled as the viewer scales it
 * to fit the turned box into /Rect. Undefined when the matrix does not turn,
 * or does more than turn and scale evenly, so such a box imports as before.
 */
function appearanceTurn(
  appearance: PDFRawStream | null,
  rect: readonly number[],
): { angle: number; w: number; h: number } | undefined {
  if (!appearance) return undefined;
  const m = numbers(lookup(appearance.dict, "Matrix", PDFArray));
  const box = normalRect(lookup(appearance.dict, "BBox", PDFArray));
  if (!m || m.length !== 6 || !box) return undefined;
  const [a, b, c, d] = m as [number, number, number, number];
  const scale = Math.hypot(a, b);
  if (!(scale > 0) || Math.abs(a - d) > 1e-4 * scale || Math.abs(b + c) > 1e-4 * scale) return undefined;
  // Clockwise as seen: the matrix turns by the negative angle in y-up space.
  const angle = Number(((((Math.atan2(-b, a) * 180) / Math.PI) % 360 + 360) % 360).toFixed(6)) % 360;
  if (angle === 0) return undefined;
  const [cos, sin] = [Math.abs(a / scale), Math.abs(b / scale)];
  const w = box[2]! - box[0]!;
  const h = box[3]! - box[1]!;
  const turnedW = scale * (w * cos + h * sin);
  const turnedH = scale * (w * sin + h * cos);
  if (!(turnedW > 0 && turnedH > 0)) return undefined;
  const fitX = (rect[2]! - rect[0]!) / turnedW;
  const fitY = (rect[3]! - rect[1]!) / turnedH;
  if (Math.abs(fitX - fitY) > 0.01 * Math.max(fitX, fitY)) return undefined;
  const k = scale * ((fitX + fitY) / 2);
  return { angle, w: w * k, h: h * k };
}

function opacityOrOne(dict: PDFDict): number {
  const ca = dict.lookup(PDFName.of("CA"));
  const value = ca instanceof PDFNumber ? ca.asNumber() : 0;
  return value || 1;
}

function opacityAsWritten(dict: PDFDict): number {
  const ca = dict.lookup(PDFName.of("CA"));
  const value = ca instanceof PDFNumber ? ca.asNumber() : 1;
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

/** pdf.js's getQuadPoints: each quad as its axis-aligned box, or null if unusable. */
function quadPoints(dict: PDFDict): Float32Array | null {
  const values = numbers(lookup(dict, "QuadPoints", PDFArray));
  if (!values || values.length === 0 || values.length % 8 > 0) return null;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 8) {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = values.slice(i, i + 8) as number[];
    const minX = Math.min(x1!, x2!, x3!, x4!);
    const maxX = Math.max(x1!, x2!, x3!, x4!);
    const minY = Math.min(y1!, y2!, y3!, y4!);
    const maxY = Math.max(y1!, y2!, y3!, y4!);
    out.set([minX, maxY, maxX, maxY, minX, minY, maxX, minY], i);
  }
  return out;
}

function inkLists(dict: PDFDict): Float32Array[] {
  const lists = lookup(dict, "InkList", PDFArray);
  if (!lists) return [];
  const out: Float32Array[] = [];
  for (let i = 0; i < lists.size(); i += 1) {
    const list = lists.lookup(i);
    if (!(list instanceof PDFArray)) continue;
    const points = new Float32Array(list.size());
    for (let j = 0; j + 1 < list.size(); j += 2) {
      const x = list.lookup(j);
      const y = list.lookup(j + 1);
      if (x instanceof PDFNumber && y instanceof PDFNumber) {
        points[j] = x.asNumber();
        points[j + 1] = y.asNumber();
      }
    }
    out.push(points);
  }
  return out;
}

/** pdf.js's setAppearance: /AP /N, or the state /AS names in it. */
function normalAppearance(dict: PDFDict): PDFRawStream | null {
  const ap = lookup(dict, "AP", PDFDict);
  if (!ap) return null;
  const normal = ap.lookup(PDFName.of("N"));
  if (normal instanceof PDFRawStream) return normal;
  if (!(normal instanceof PDFDict)) return null;
  const state = lookup(dict, "AS", PDFName)?.decodeText();
  if (!state) return null;
  const chosen = normal.lookup(PDFName.of(state));
  return chosen instanceof PDFRawStream ? chosen : null;
}
