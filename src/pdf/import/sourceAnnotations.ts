import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
  pdfDocEncodingDecode,
} from "pdf-lib";

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
  const page = pdf.getPages()[pageIndex];
  if (!page) {
    if (strict) throw new Error(`pdf-lib finds no page ${pageIndex + 1} in the page tree`);
    return [];
  }
  let annots: PDFArray | undefined;
  try {
    annots = page.node.Annots();
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

  if (MARKUP_SUBTYPES.has(subtype)) readMarkup(dict, data);

  switch (subtype) {
    case "Text":
      if (!appearance) {
        rect[1] = rect[3]! - TEXT_ICON_SIZE;
        rect[2] = rect[0]! + TEXT_ICON_SIZE;
      }
      break;
    case "FreeText":
      data.defaultAppearanceData = freeTextAppearance(dict, appearance, acroFormDA);
      break;
    case "Square":
      // Without an appearance pdf.js draws one and sets the rect to its
      // bounds, taken through a Float32Array.
      if (!appearance && (borderWidthOf(data) !== 0 || rgbColor(dict.lookup(PDFName.of("IC")), null))) {
        data.rect = rect.map(Math.fround);
      }
      break;
    case "Ink":
      data.opacity = opacityOrOne(dict);
      data.inkLists = inkLists(dict);
      break;
    case "Highlight":
      data.opacity = opacityOrOne(dict);
      break;
  }
  if (QUAD_SUBTYPES.has(subtype)) data.quadPoints = quadPoints(dict);
  if (subtype === "Popup") {
    const parent = lookup(dict, "Parent", PDFDict);
    if (parent && !viewable(data, flags)) {
      const parentFlags = parent.lookup(PDFName.of("F"));
      const raw = parentFlags instanceof PDFNumber ? parentFlags.asNumber() : 0;
      if (!(raw & INVISIBLE) && !(raw & NOVIEW)) flags = annotationFlags(parent, subtype);
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

/** pdf.js's `viewable`: a markup without usable quads, or NoView, is not shown. */
function viewable(data: SourceAnnotation, flags: number): boolean {
  if (data.quadPoints === null) return false;
  if (flags === 0) return true;
  return !(flags & INVISIBLE) && !(flags & NOVIEW);
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

function lookup<T extends PDFObject>(
  dict: PDFDict,
  key: string,
  // pdf-lib's object classes have private constructors; instanceof only
  // needs the prototype.
  type: { prototype: T },
): T | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof (type as unknown as typeof PDFObject) ? (value as T) : undefined;
}

/** A PDF string's bytes as a JS string of char codes 0–255, as pdf.js holds it. */
function latin1(value: PDFObject | undefined): string | undefined {
  if (!(value instanceof PDFString || value instanceof PDFHexString)) return undefined;
  const bytes = value.asBytes();
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
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

/**
 * pdf.js's getRgbColor on /C: no array → the black default, none → null,
 * 1 / 3 / 4 components → gray / RGB / CMYK, into a Uint8ClampedArray.
 */
function rgbColor(
  value: PDFObject | undefined,
  fallback: Uint8ClampedArray | null = new Uint8ClampedArray(3),
): Uint8ClampedArray | null {
  if (!(value instanceof PDFArray)) return fallback;
  const components: number[] = [];
  for (let i = 0; i < value.size(); i += 1) {
    const item = value.lookup(i);
    components.push(item instanceof PDFNumber ? item.asNumber() : Number.NaN);
  }
  if (components.length === 0) return null;
  const rgb = fallback ?? new Uint8ClampedArray(3);
  if (components.length === 1) grayToRgb(components, rgb);
  else if (components.length === 3) rgbToRgb(components, rgb);
  else if (components.length === 4) cmykToRgb(components, rgb);
  return rgb;
}

function grayToRgb(src: readonly number[], dest: Uint8ClampedArray): void {
  const c = src[0]! * 255;
  dest[0] = dest[1] = dest[2] = c;
}

function rgbToRgb(src: readonly number[], dest: Uint8ClampedArray): void {
  dest[0] = src[0]! * 255;
  dest[1] = src[1]! * 255;
  dest[2] = src[2]! * 255;
}

/** pdf.js's DeviceCMYK polynomial (Apache-2.0, see THIRD_PARTY_NOTICES.md). */
function cmykToRgb(src: readonly number[], dest: Uint8ClampedArray): void {
  const [c, m, y, k] = src as [number, number, number, number];
  dest[0] = 255 + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004) + m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) + k * (-21.86122147463605 * k - 189.48180835922747);
  dest[1] = 255 + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548) + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) + k * (-20.737325471181034 * k - 187.80453709719578);
  dest[2] = 255 + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286) + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) + y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) + k * (-22.33816807309886 * k - 180.12613974708367);
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

function opacityOrOne(dict: PDFDict): number {
  const ca = dict.lookup(PDFName.of("CA"));
  const value = ca instanceof PDFNumber ? ca.asNumber() : 0;
  return value || 1;
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

type FreeTextAppearance = { fontSize: number; fontName: string; fontColor: Uint8ClampedArray };

/**
 * FreeText's /DA (inherited, else the AcroForm's), and when the annotation
 * has an appearance, the font size and colour its stream actually sets.
 */
function freeTextAppearance(
  dict: PDFDict,
  appearance: PDFRawStream | null,
  acroFormDA: string | undefined,
): FreeTextAppearance {
  let da: string | undefined;
  const seen = new Set<PDFDict>();
  for (let node: PDFDict | undefined = dict; node && !seen.has(node); node = lookup(node, "Parent", PDFDict)) {
    seen.add(node);
    const value = node.lookup(PDFName.of("DA"));
    if (value !== undefined) {
      da = latin1(value);
      break;
    }
  }
  da ??= acroFormDA;
  const result = parseDefaultAppearance(da ?? "");
  if (appearance) {
    const drawn = parseAppearanceStream(appearance);
    result.fontColor = drawn.fontColor;
    result.fontSize = drawn.fontSize || 10;
  } else {
    result.fontSize ||= 10;
  }
  return result;
}

type Operation = { op: string; args: unknown[] };
type NameToken = { name: string };

// Operand counts of the operators read here (pdf.js's OP_MAP); pdf.js skips
// an operator given too few and keeps the last ones when given too many.
const ARITY: Record<string, number> = {
  Tf: 2, rg: 3, g: 1, k: 4, cs: 1, Tm: 6, q: 0, Q: 0,
  Tj: 1, TJ: 1, "'": 1, '"': 3,
};
const VARIABLE_ARITY: Record<string, number> = { sc: 4, scn: 33 };

/** The operators of a content stream, operands attached; strings, arrays and dicts opaque. */
function* operations(source: string): Generator<Operation> {
  let args: unknown[] = [];
  let i = 0;
  const n = source.length;
  const isWhite = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
  const isDelim = (c: string) => "()<>[]{}/%".includes(c);
  while (i < n) {
    const c = source[i]!;
    if (isWhite(c)) {
      i += 1;
    } else if (c === "%") {
      while (i < n && source[i] !== "\n" && source[i] !== "\r") i += 1;
    } else if (c === "/") {
      let j = i + 1;
      while (j < n && !isWhite(source[j]!) && !isDelim(source[j]!)) j += 1;
      args.push({ name: source.slice(i + 1, j).replaceAll(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) } satisfies NameToken);
      i = j;
    } else if (c === "(") {
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "(") depth += 1;
        else if (source[i] === ")") depth -= 1;
        i += 1;
      }
      args.push("");
    } else if (c === "<" && source[i + 1] === "<") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (source[i] === "<" && source[i + 1] === "<") { depth += 1; i += 2; }
        else if (source[i] === ">" && source[i + 1] === ">") { depth -= 1; i += 2; }
        else i += 1;
      }
      args.push({});
    } else if (c === "<") {
      const end = source.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      args.push("");
    } else if (c === "[") {
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        if (source[i] === "(") {
          let d = 1;
          i += 1;
          while (i < n && d > 0) {
            if (source[i] === "\\") i += 1;
            else if (source[i] === "(") d += 1;
            else if (source[i] === ")") d -= 1;
            i += 1;
          }
          continue;
        }
        if (source[i] === "[") depth += 1;
        else if (source[i] === "]") depth -= 1;
        i += 1;
      }
      args.push([]);
    } else if (c === "]" || c === ">" || c === ")" || c === "{" || c === "}") {
      i += 1;
    } else {
      let j = i;
      while (j < n && !isWhite(source[j]!) && !isDelim(source[j]!)) j += 1;
      const word = source.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
        args.push(Number(word));
      } else if (word === "true" || word === "false" || word === "null") {
        args.push(word === "true" ? true : word === "false" ? false : null);
      } else if (word === "BI") {
        // An inline image: skip its data to EI.
        const end = source.indexOf("EI", i);
        i = end < 0 ? n : end + 2;
        args = [];
      } else {
        const fixed = ARITY[word];
        const variable = VARIABLE_ARITY[word];
        if (fixed !== undefined) {
          if (args.length >= fixed) yield { op: word, args: args.slice(args.length - fixed) };
        } else if (variable !== undefined) {
          yield { op: word, args: args.slice(-variable) };
        } else {
          yield { op: word, args };
        }
        args = [];
      }
    }
  }
}

const nameOf = (value: unknown): string | null =>
  value && typeof value === "object" && "name" in value ? (value as NameToken).name : null;

function setFillColor(op: string, args: unknown[], dest: Uint8ClampedArray, space: number): void {
  const values = args.map((arg) => (typeof arg === "number" ? arg : Number.NaN));
  if (op === "rg") rgbToRgb(values, dest);
  else if (op === "g") grayToRgb(values, dest);
  else if (op === "k") cmykToRgb(values, dest);
  else if (space === 1) grayToRgb(values, dest);
  else if (space === 3) rgbToRgb(values, dest);
  else if (space === 4) cmykToRgb(values, dest);
}

/** pdf.js's parseDefaultAppearance: the last font, size and fill colour outside q … Q. */
function parseDefaultAppearance(da: string): FreeTextAppearance {
  const result: FreeTextAppearance = { fontSize: 0, fontName: "", fontColor: new Uint8ClampedArray(3) };
  let depth = 0;
  for (const { op, args } of operations(da)) {
    if (op === "q") depth += 1;
    else if (op === "Q") depth = Math.max(0, depth - 1);
    if (depth !== 0 || op === "q" || op === "Q") continue;
    if (op === "Tf") {
      const name = nameOf(args[0]);
      if (name !== null) result.fontName = name;
      if (typeof args[1] === "number" && args[1] > 0) result.fontSize = args[1];
    } else if (op === "rg" || op === "g" || op === "k") {
      setFillColor(op, args, result.fontColor, 0);
    }
  }
  return result;
}

/**
 * pdf.js's parseAppearanceStream: the font size (through the text matrix)
 * and fill colour in force when the first text is shown.
 */
function parseAppearanceStream(stream: PDFRawStream): { fontSize: number; fontColor: Uint8ClampedArray } {
  let bytes: Uint8Array;
  try {
    bytes = decodePDFRawStream(stream).decode();
  } catch {
    return { fontSize: 0, fontColor: new Uint8ClampedArray(3) };
  }
  let source = "";
  for (let i = 0; i < bytes.length; i += 1) source += String.fromCharCode(bytes[i]!);
  const resources = lookup(stream.dict, "Resources", PDFDict);
  type State = { scale: number; fontSize: number; fontColor: Uint8ClampedArray; space: number };
  let state: State = { scale: 1, fontSize: 0, fontColor: new Uint8ClampedArray(3), space: 1 };
  const stack: State[] = [];
  for (const { op, args } of operations(source)) {
    if (op === "q") stack.push({ ...state, fontColor: state.fontColor.slice() });
    else if (op === "Q") state = stack.pop() ?? state;
    else if (op === "Tm") state.scale *= Math.hypot(args[0] as number, args[1] as number);
    else if (op === "Tf") {
      if (typeof args[1] === "number" && args[1] > 0) state.fontSize = args[1] * state.scale;
    } else if (op === "cs") {
      state.space = colorSpaceComponents(nameOf(args[0]), resources);
    } else if (op === "sc" || op === "scn" || op === "rg" || op === "g" || op === "k") {
      setFillColor(op, args, state.fontColor, state.space);
    } else if (op === "Tj" || op === "TJ" || op === "'" || op === '"') {
      break;
    }
  }
  return { fontSize: state.fontSize, fontColor: state.fontColor };
}

/** Components of a fill colour space: device spaces by name, others by /N. */
function colorSpaceComponents(name: string | null, resources: PDFDict | undefined): number {
  if (name === "DeviceGray" || name === "G") return 1;
  if (name === "DeviceRGB" || name === "RGB") return 3;
  if (name === "DeviceCMYK" || name === "CMYK") return 4;
  if (!name || !resources) return 1;
  const spaces = lookup(resources, "ColorSpace", PDFDict);
  const space = spaces?.lookup(PDFName.of(name));
  if (space instanceof PDFName) return colorSpaceComponents(space.decodeText(), undefined);
  if (space instanceof PDFArray) {
    const family = space.lookup(0);
    const familyName = family instanceof PDFName ? family.decodeText() : null;
    if (familyName === "ICCBased") {
      const profile = space.lookup(1);
      const components = profile instanceof PDFRawStream ? profile.dict.lookup(PDFName.of("N")) : undefined;
      if (components instanceof PDFNumber) return components.asNumber();
    }
    if (familyName === "CalGray") return 1;
    if (familyName === "CalRGB" || familyName === "Lab") return 3;
  }
  return 1;
}

// pdf.js keeps only these CSS properties of rich text (xhtml.js VALID_STYLES).
const RICH_TEXT_STYLES = new Set([
  "color", "font", "font-family", "font-size", "font-stretch", "font-style", "font-weight",
  "margin", "margin-bottom", "margin-left", "margin-right", "margin-top", "letter-spacing",
  "line-height", "orphans", "page-break-after", "page-break-before", "page-break-inside",
  "tab-interval", "tab-stop", "text-align", "text-decoration", "text-indent", "vertical-align",
  "widows", "kerning-mode",
]);

/**
 * The root style of /RC, the one part of pdf.js's rich-text tree the importer
 * reads. pdf.js has no font finder for annotation rich text, so it drops
 * `font-family` and keeps the `font` shorthand; so does this.
 */
function richTextRoot(rc: string | undefined): { html: { attributes: { style: Record<string, string> } } } | null {
  if (!rc) return null;
  const body = rc.replace(/^\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i, "");
  const tag = /^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/.exec(body);
  if (!tag) return null;
  const style: Record<string, string> = {};
  if (tag[2] === "body" || tag[2] === "xhtml") {
    const attribute = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag[3] ?? "");
    const css = xmlUnescape(attribute?.[1] ?? attribute?.[2] ?? "");
    for (const declaration of css.split(";")) {
      const [rawKey, rawValue] = declaration.split(":", 2);
      const key = rawKey?.trim();
      if (!key || rawValue === undefined || !RICH_TEXT_STYLES.has(key) || key === "font-family") continue;
      style[key.replaceAll(/-([a-zA-Z])/g, (_, x: string) => x.toUpperCase())] = rawValue.trim();
    }
  }
  return { html: { attributes: { style } } };
}

function xmlUnescape(text: string): string {
  return text.replaceAll(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}
