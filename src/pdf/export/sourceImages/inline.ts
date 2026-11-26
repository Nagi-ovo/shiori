import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, type PDFObject } from "pdf-lib";
import type { ContentOperand } from "../contentStreamEdit/tokenizer";
import { flateInlineEnd } from "./inlineFlate";

export type InlineEntries = ReadonlyMap<string, ContentOperand>;

function entry(entries: InlineEntries, full: string, abbreviation: string) {
  return entries.get(abbreviation) ?? entries.get(full);
}

function positiveInt(operand: ContentOperand | undefined): number {
  if (operand?.kind !== "number" || !Number.isSafeInteger(operand.value) || operand.value < 1) {
    throw Error("invalid inline image dimensions or sample depth");
  }
  return operand.value;
}

export function inlineImageProperties(entries: InlineEntries) {
  return {
    widthPx: positiveInt(entry(entries, "Width", "W")),
    heightPx: positiveInt(entry(entries, "Height", "H")),
    masked: entry(entries, "ImageMask", "IM") !== undefined || entries.has("Mask") || entries.has("SMask"),
  };
}

type ColorSpaceLookup = (name: string) => PDFObject | undefined;

function deviceComponents(name: string): number | undefined {
  switch (name) {
    case "G": case "DeviceGray": return 1;
    case "RGB": case "DeviceRGB": return 3;
    case "CMYK": case "DeviceCMYK": return 4;
  }
}

function namedComponents(name: string, lookup: ColorSpaceLookup, seen: Set<string>): number | undefined {
  const device = deviceComponents(name);
  if (device !== undefined) return device;
  if (seen.has(name)) return undefined;
  seen.add(name);
  const space = lookup(name);
  if (space instanceof PDFName) return namedComponents(space.decodeText(), lookup, seen);
  if (!(space instanceof PDFArray)) return undefined;
  const family = space.lookup(0);
  if (!(family instanceof PDFName)) return undefined;
  const arg = space.lookup(1);
  switch (family.decodeText()) {
    case "CalGray": case "Indexed": case "Separation": return 1;
    case "CalRGB": case "Lab": return 3;
    case "DeviceN": return arg instanceof PDFArray ? arg.size() : undefined;
    case "ICCBased": {
      const dict = arg instanceof PDFRawStream ? arg.dict : arg;
      const n = dict instanceof PDFDict ? dict.lookup(PDFName.of("N")) : undefined;
      return n instanceof PDFNumber ? n.asNumber() : undefined;
    }
  }
}

function rawLength(entries: InlineEntries, lookup: ColorSpaceLookup): number {
  const { widthPx, heightPx } = inlineImageProperties(entries);
  const mask = entry(entries, "ImageMask", "IM");
  if (mask?.kind === "boolean" && mask.value) return Math.ceil(widthPx / 8) * heightPx;
  const depth = positiveInt(entry(entries, "BitsPerComponent", "BPC"));
  if (![1, 2, 4, 8, 16].includes(depth)) throw Error("unsupported inline image sample depth");
  const color = entry(entries, "ColorSpace", "CS");
  let components: number | undefined;
  if (color?.kind === "name") components = namedComponents(color.value, lookup, new Set());
  if (color?.kind === "array") {
    const family = color.items[0];
    if (family?.kind === "name" && (family.value === "I" || family.value === "Indexed")) components = 1;
  }
  if (!components || !Number.isSafeInteger(components)) throw Error("unknown inline image color space");
  return Math.ceil(widthPx * components * depth / 8) * heightPx;
}

const whitespace = (b: number | undefined) => b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;

function asciiEnd(bytes: Uint8Array, start: number, hex: boolean): number {
  for (let i = start; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    if (whitespace(b)) continue;
    if (hex) {
      if (b === 0x3e) return i + 1; // >
      if ((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102)) continue;
    } else {
      if (b === 0x7e && bytes[i + 1] === 0x3e) return i + 2; // ~>
      if ((b >= 33 && b <= 117) || b === 122) continue;
    }
    break;
  }
  throw Error("invalid ASCII inline image framing");
}

function runLengthEnd(bytes: Uint8Array, start: number): number {
  for (let pos = start; pos < bytes.length;) {
    const code = bytes[pos++]!;
    if (code === 128) return pos;
    pos += code < 128 ? code + 1 : 1;
  }
  throw Error("missing RunLength inline image end marker");
}

function lzwEnd(bytes: Uint8Array, start: number, params: ContentOperand | undefined): number {
  const first = params?.kind === "array" ? params.items[0] : params;
  const change = first?.kind === "dict" ? first.entries.find(entry => entry.key === "EarlyChange") : undefined;
  const earlyChange = change ? change.numberValue : 1;
  if (earlyChange !== 0 && earlyChange !== 1) throw Error("invalid LZW EarlyChange");
  let bit = start * 8;
  let width = 9;
  let next = 258;
  let hasPrevious = false;
  while (bit + width <= bytes.length * 8) {
    let code = 0;
    for (let i = 0; i < width; i += 1, bit += 1) {
      code = (code << 1) | ((bytes[Math.floor(bit / 8)]! >>> (7 - bit % 8)) & 1);
    }
    if (code === 257) return Math.ceil(bit / 8);
    if (code === 256) {
      width = 9;
      next = 258;
      hasPrevious = false;
      continue;
    }
    if (code > next || (!hasPrevious && code > 255)) break;
    if (hasPrevious && next < 4096) {
      next += 1;
      if (width < 12 && next + earlyChange === 1 << width) width += 1;
    }
    hasPrevious = true;
  }
  throw Error("invalid LZW inline image framing");
}

export function jpegEnd(bytes: Uint8Array, start: number): number {
  if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) throw Error("missing JPEG start marker");
  let inScan = false;
  let sawScan = false;
  for (let pos = start + 2; pos < bytes.length;) {
    if (bytes[pos++] !== 0xff) {
      if (inScan) continue;
      break;
    }
    while (bytes[pos] === 0xff) pos += 1;
    const marker = bytes[pos++]!;
    if (marker === 0xd9 && sawScan) return pos;
    if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    const size = 256 * bytes[pos]! + bytes[pos + 1]!;
    if (!(size >= 2 && pos + size <= bytes.length) || marker === 0 || marker === 0xd8) break;
    pos += size;
    inScan = marker === 0xda;
    sawScan ||= inScan;
  }
  throw Error("invalid JPEG inline image framing");
}

export function inlineImageExtent(
  bytes: Uint8Array, entries: InlineEntries, afterId: number, lookup: ColorSpaceLookup,
) {
  inlineImageProperties(entries);
  const filter = entry(entries, "Filter", "F");
  const first = filter?.kind === "array" ? filter.items[0] : filter;
  if (first && first.kind !== "name") throw Error("malformed inline image filter");
  const name = first?.value;
  const asciiHex = name === "AHx" || name === "ASCIIHexDecode";
  const ascii85 = name === "A85" || name === "ASCII85Decode";
  let dataStart = afterId;
  if (whitespace(bytes[dataStart])) dataStart += 1;
  else if (!asciiHex && !ascii85) throw Error("missing inline image ID separator");

  let dataEnd: number;
  switch (name) {
    case undefined: dataEnd = dataStart + rawLength(entries, lookup); break;
    case "AHx": case "ASCIIHexDecode": case "A85": case "ASCII85Decode":
      dataEnd = asciiEnd(bytes, dataStart, asciiHex); break;
    case "RL": case "RunLengthDecode": dataEnd = runLengthEnd(bytes, dataStart); break;
    case "Fl": case "FlateDecode": dataEnd = flateInlineEnd(bytes, dataStart); break;
    case "LZW": case "LZWDecode":
      dataEnd = lzwEnd(bytes, dataStart, entry(entries, "DecodeParms", "DP")); break;
    case "DCT": case "DCTDecode": dataEnd = jpegEnd(bytes, dataStart); break;
    default: throw Error(`unproven inline image boundary for /${name}`);
  }
  const length = entry(entries, "Length", "L");
  if (length !== undefined) {
    let lengthStart = dataStart;
    if (asciiHex || ascii85) while (whitespace(bytes[lengthStart])) lengthStart += 1;
    if (length.kind !== "number" || length.value !== dataEnd - lengthStart) {
      throw Error("inline image length disagrees with its data boundary");
    }
  }
  return { dataStart, dataEnd };
}
