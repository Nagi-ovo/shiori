import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, type PDFObject } from "pdf-lib";
import type { ContentOp } from "../contentStreamEdit/tokenizer";
import { simpleNames } from "../fontCoverage/encodings";
import { readFontEncoding } from "../fontCoverage/pdfLibAdapter";
import { fillPath, strokePath, textShow, type Frame, type IndirectImageContext, type IndirectPaint } from "./graphics";
import {
  dictionaryEntry, dictionaryValue, resourceGroup, resourceKey, resourceScope, type SourceImageResources,
} from "./objects";

const key = PDFName.of;

function paint(
  context: IndirectImageContext, owner: PDFDict, entry: PDFObject | undefined, resources: SourceImageResources,
): IndirectPaint {
  const stream = owner.context.lookup(entry);
  if (!(stream instanceof PDFRawStream) || !entry) throw Error("unreadable indirect paint stream");
  return { context, entry, stream, resources };
}

function glyphPrograms(font: PDFDict): PDFDict {
  const charProcs = dictionaryValue(font, "CharProcs");
  if (!(charProcs instanceof PDFDict)) throw Error("missing Type 3 glyph streams");
  return charProcs;
}

function glyphPaints(font: PDFDict, current: SourceImageResources, page: SourceImageResources): IndirectPaint[] {
  const scope = resourceScope(font);
  const scopes = scope ? [scope] : current.dict === page.dict ? [current] : [current, page];
  return glyphPrograms(font).entries().flatMap(([, entry]) => scopes.map(resources => paint("Type 3 glyph", font, entry, resources)));
}

const glyphNames = new WeakMap<PDFDict, Map<number, string>>();

function* shownGlyphPaints(
  font: PDFDict, page: SourceImageResources, chars: Uint8Array[], evidence: boolean,
): Iterable<IndirectPaint> {
  let names = glyphNames.get(font);
  if (!names) {
    const encoding = readFontEncoding(font);
    if (!encoding || (typeof encoding === "object" && encoding.cmap !== undefined)) {
      throw Error("unreadable Type 3 encoding");
    }
    names = simpleNames({ subtype: "Type3", encoding });
    glyphNames.set(font, names);
  }
  const programs = glyphPrograms(font);
  const resources = resourceScope(font) ?? page;
  const seen = new Set<number>();
  for (const bytes of chars) {
    for (const code of bytes) {
      if (!evidence && seen.has(code)) continue;
      seen.add(code);
      const name = names.get(code);
      const entry = name && dictionaryEntry(programs, name);
      if (entry) yield paint("Type 3 glyph", programs, entry, resources);
    }
  }
}

export function annotationPaints(
  annot: PDFDict, resources: SourceImageResources, conservative: boolean,
): IndirectPaint[] {
  const ap = dictionaryValue(annot, "AP");
  if (ap === undefined) return [];
  if (!(ap instanceof PDFDict)) throw Error("unreadable annotation appearances");
  if (conservative) {
    return ap.entries().flatMap(([, mode]) => {
      const states = ap.context.lookup(mode);
      return states instanceof PDFDict ? states.entries().map(([, state]) => paint("annotation appearance", ap, state, resources))
        : [paint("annotation appearance", ap, mode, resources)];
    });
  }

  const flags = dictionaryValue(annot, "F");
  if (flags instanceof PDFNumber && (flags.asNumber() & (0x02 | 0x20))) return []; // Hidden or NoView.
  if (dictionaryValue(annot, "Subtype") === key("Popup")) return [];
  const normal = dictionaryValue(ap, "N");
  if (normal === undefined) return [];
  if (!(normal instanceof PDFDict)) return [paint("annotation appearance", ap, dictionaryEntry(ap, "N"), resources)];
  const state = dictionaryValue(annot, "AS");
  if (state instanceof PDFName) {
    const entry = dictionaryEntry(normal, state.decodeText());
    return entry ? [paint("annotation appearance", normal, entry, resources)] : [];
  }
  const parent = dictionaryValue(annot, "Parent");
  const value = dictionaryValue(annot, "V") ?? (parent instanceof PDFDict ? dictionaryValue(parent, "V") : undefined);
  const entry = (value instanceof PDFName && dictionaryEntry(normal, value.decodeText())) || dictionaryEntry(normal, "Off");
  return entry ? [paint("annotation appearance", normal, entry, resources)] : [];
}

function isTilingPattern(stream: PDFRawStream): boolean {
  const type = dictionaryValue(stream.dict, "PatternType");
  return type instanceof PDFNumber && type.asNumber() === 1;
}

function shownStrings(op: ContentOp): Uint8Array[] {
  const last = op.operands.at(-1);
  const operands = last?.kind === "array" ? last.items : last ? [last] : [];
  return operands.flatMap(item => item.kind === "string" && item.bytes.length ? [item.bytes] : []);
}

// Resource cleanup follows alternate states and selected resources even if they are idle.
export function trackExtraPaints(
  frame: Frame<unknown>, op: ContentOp, page: SourceImageResources,
  enqueue: (paint: IndirectPaint) => void, conservative: boolean, evidence: boolean,
): void {
  const { operator } = op;
  const { state, owner } = frame;
  const named = (category: string, name: string) => {
    const group = resourceGroup(owner.resources, page, category);
    const nameKey = group && resourceKey(group.dict, name);
    const entry = nameKey && group.dict.get(nameKey);
    return entry && { entry, value: group.dict.context.lookup(entry) };
  };
  const selectFont = (font: PDFObject | undefined) => {
    const type3Font = font instanceof PDFDict && dictionaryValue(font, "Subtype") === key("Type3") ? font : undefined;
    if (conservative) {
      if (type3Font) glyphPaints(type3Font, owner.resources, page).forEach(enqueue);
    } else if (type3Font !== frame.state.type3Font) {
      frame.state = { ...frame.state, type3Font };
    }
  };

  if (operator === "scn" || operator === "SCN") {
    const operand = op.operands.at(-1);
    const pattern = operand?.kind === "name" ? named("Pattern", operand.value) : undefined;
    const paint: IndirectPaint | undefined = pattern?.value instanceof PDFRawStream &&
      (!evidence || isTilingPattern(pattern.value))
      ? { context: "tiling pattern", stream: pattern.value, entry: pattern.entry, resources: owner.resources }
      : undefined;
    frame.state = { ...state, [operator === "scn" ? "fillPattern" : "strokePattern"]: paint };
  } else if (operator === "g" || operator === "rg" || operator === "k" || operator === "cs" || operator === "sc") {
    if (state.fillPattern) frame.state = { ...state, fillPattern: undefined };
  } else if (operator === "G" || operator === "RG" || operator === "K" || operator === "CS" || operator === "SC") {
    if (state.strokePattern) frame.state = { ...state, strokePattern: undefined };
  } else if (operator === "Tf") {
    const [name] = op.operands;
    selectFont(name?.kind === "name" ? named("Font", name.value)?.value : undefined);
  } else if (operator === "gs") {
    const [name] = op.operands;
    if (op.operands.length !== 1 || name?.kind !== "name") throw Error("invalid gs operands");
    const ext = named("ExtGState", name.value)?.value;
    if (ext instanceof PDFDict) {
      const mask = dictionaryValue(ext, "SMask");
      if (mask instanceof PDFDict) {
        const group = paint("soft-mask group", mask, dictionaryEntry(mask, "G"), owner.resources);
        if (conservative) enqueue(group);
        else frame.state = { ...state, softMask: group };
      } else if (mask === key("None") && state.softMask) {
        frame.state = { ...state, softMask: undefined };
      }
      const font = dictionaryValue(ext, "Font");
      if (font instanceof PDFArray) selectFont(font.lookup(0));
    }
  }

  const mode = state.textMode % 4;
  const text = frame.inText && textShow.has(operator);
  const inPath = frame.pathStart !== undefined;
  const fill = (!evidence || inPath) && fillPath.has(operator);
  const stroke = (!evidence || inPath) && strokePath.has(operator);
  if (state.fillPattern && (fill || (text && (mode === 0 || mode === 2)))) enqueue(state.fillPattern);
  if (state.strokePattern && (stroke || (text && (mode === 1 || mode === 2)))) enqueue(state.strokePattern);

  const chars = text && mode !== 3 && (state.type3Font || state.softMask) ? shownStrings(op) : [];
  if (state.softMask && ((inPath && (fill || stroke)) || operator === "sh" || chars.length)) {
    enqueue(state.softMask);
  }
  if (state.type3Font && chars.length) {
    for (const glyph of shownGlyphPaints(state.type3Font, page, chars, evidence)) enqueue(glyph);
  }
}
