import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { cmykToRgb, grayToRgb, latin1, lookup, rgbToRgb } from "./pdfjsValues";

// A FreeText's text style as pdf.js 5.6 reads it for the annotation listing
// (./sourceAnnotations.ts): from /DA, and from the appearance stream when
// there is one.

type FreeTextAppearance = { fontSize: number; fontName: string; fontColor: Uint8ClampedArray };

/**
 * FreeText's /DA (inherited, else the AcroForm's), and when the annotation
 * has an appearance, the font size and colour its stream actually sets.
 */
export function freeTextAppearance(
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
