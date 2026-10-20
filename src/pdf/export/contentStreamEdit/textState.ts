// Text-state interpreter for the glyph-removal export pass: walks tokenized
// content ops tracking CTM + text state, and yields one placement per shown
// glyph — its advance-box quad in content-stream user space plus everything
// the rewrite needs to excise it (string location and the TJ compensation
// that preserves the advance so following text does not shift).
//
// Fail-closed by design: any construct whose geometry we cannot model
// EXACTLY (unresolvable fonts, clipping text render modes, ExtGState font
// overrides, malformed operands — which also catch token-boundary damage
// from /Contents coalescing) aborts the whole walk with { ok: false }. The
// caller must then leave the page untouched. Approximating here would
// silently delete the wrong glyphs.
//
// One exception keeps a single odd font from disabling the whole page: text
// in a font glyphWidths cannot measure (a Standard-14 font without /Widths,
// a vertical or CMap encoding) yields no placements and sets unplacedText,
// so it is never removed. Its advance is unknown, so later shows on the same
// line are unplaced too, until a line operator moves from the line start.

import type { ContentOp, ContentOperand } from "./tokenizer";
import type { ContentFontInfo, UnsupportedFont } from "./glyphWidths";

export type Point = { x: number; y: number };

// Row-major affine matrix [a b c d e f] as in PDF: x' = a·x + c·y + e.
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// Top of a glyph's core band, in em above the baseline: below the x-height
// of common text faces, far below the next line's baseline.
const CORE_TOP_EM = 0.4;

function multiply(m: Matrix, n: Matrix): Matrix {
  // Apply m first, then n.
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function apply(m: Matrix, p: Point): Point {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

export type GlyphPlacement = {
  // Where the glyph's bytes live: ops[opIndex].operands — for TJ the
  // arrayItemIndex-th item of the array operand, for Tj/'/" the string
  // operand itself (arrayItemIndex = -1).
  opIndex: number;
  arrayItemIndex: number;
  byteOffset: number;
  byteLength: 1 | 2;
  code: number;
  // The /Font resource name the glyph was shown with — lets the export reuse
  // the SAME font for replacement text when its glyphs suffice.
  fontName: string;
  // Advance-box corners in content-stream user space, order: origin,
  // origin+advance, top+advance, top. A degenerate box (zero advance) is
  // still emitted — the removal pass decides how to treat it.
  quad: [Point, Point, Point, Point];
  // Same advance, but only from the baseline up to CORE_TOP_EM (or the
  // ascent, if lower): the part of the glyph any cover built for its line
  // contains. Editor covers come from ink bounds or a band normalized to one
  // em, both shorter than many fonts' FontDescriptor box, so the removal
  // pass tests this band, not `quad`, for "fully covered".
  coreQuad: [Point, Point, Point, Point];
  // TJ number that reproduces this glyph's whole displacement (advance width
  // + char/word spacing) when the glyph bytes are removed: insert
  // -tjCompensation at the glyph's position. Units: thousandths of text
  // space at the glyph's font size (exactly what TJ expects).
  tjCompensation: number;
};

export type XObjectUse = {
  opIndex: number;
  name: string;
  // CTM in effect at the Do — the transform an XObject-recursive pass must
  // seed its own walk with.
  ctm: [number, number, number, number, number, number];
};

// An inline image (BI…EI) paints the unit square under the CTM in effect.
export type InlineImageUse = {
  opIndex: number;
  ctm: [number, number, number, number, number, number];
};

export type TextWalkResult =
  | {
      ok: true;
      glyphs: GlyphPlacement[];
      xobjects: XObjectUse[];
      inlineImages: InlineImageUse[];
      // Some text was shown where the walk cannot place it; no cover rect
      // can be proven free of it.
      unplacedText: boolean;
    }
  | { ok: false; reason: string };

type GraphicsState = {
  ctm: Matrix;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number; // Tz/100
  leading: number;
  rise: number;
  renderMode: number;
  fontName: string | null;
  fontSize: number;
  // Set when a gs op may have replaced the font via ExtGState /Font; a show
  // before the next Tf is then unmodelable.
  fontTainted: boolean;
};

export type TextWalkCallbacks = {
  // Resolve a /Font resource name. Null (unresolvable) aborts the walk; an
  // unsupported font leaves its text unplaced.
  resolveFont: (name: string) => ContentFontInfo | UnsupportedFont | null;
  // Whether an /ExtGState resource contains a /Font entry. Return null when
  // unknown — the walk then assumes it might and taints the current font.
  extGStateSetsFont?: (name: string) => boolean | null;
};

function operandNumbers(op: ContentOp, count: number): number[] | null {
  if (op.operands.length !== count) return null;
  const out: number[] = [];
  for (const operand of op.operands) {
    if (operand.kind !== "number") return null;
    out.push(operand.value);
  }
  return out;
}

export function walkTextPlacements(
  ops: ContentOp[],
  callbacks: TextWalkCallbacks,
): TextWalkResult {
  const glyphs: GlyphPlacement[] = [];
  const xobjects: XObjectUse[] = [];
  const inlineImages: InlineImageUse[] = [];
  const stack: GraphicsState[] = [];
  let gs: GraphicsState = {
    ctm: IDENTITY,
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
    fontName: null,
    fontSize: 0,
    fontTainted: false,
  };
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let inTextObject = false;
  // Set once a show of unknown advance moved tm by an unknown amount.
  let tmUnknown = false;
  let unplacedText = false;
  const fontCache = new Map<string, ContentFontInfo | UnsupportedFont | null>();

  const fail = (reason: string): TextWalkResult => ({ ok: false, reason });

  const resolveFont = (
    name: string,
  ): ContentFontInfo | UnsupportedFont | null => {
    if (!fontCache.has(name)) fontCache.set(name, callbacks.resolveFont(name));
    return fontCache.get(name) ?? null;
  };

  const translateText = (tx: number, ty: number) => {
    tm = multiply([1, 0, 0, 1, tx, ty], tm);
  };

  const nextLine = (tx: number, ty: number) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    tmUnknown = false;
  };

  const show = (
    bytes: Uint8Array,
    opIndex: number,
    arrayItemIndex: number,
  ): string | null => {
    if (!inTextObject) return "show-text outside BT/ET";
    if (gs.fontName === null) return "show-text with no font set";
    if (gs.fontTainted) return "show-text after ExtGState may have set /Font";
    if (gs.renderMode >= 4) {
      // Clipping modes: deleting a glyph would change the clip path and
      // repaint everything it masked.
      return "text used as clipping path (Tr >= 4)";
    }
    const font = resolveFont(gs.fontName);
    if (font === null) return `unresolvable font /${gs.fontName}`;
    if (!font.ok || tmUnknown) {
      unplacedText = true;
      tmUnknown = true;
      return null;
    }
    if (gs.fontSize === 0) return "show-text at font size 0";
    if (font.bytesPerCode === 2 && bytes.length % 2 !== 0) {
      return "odd byte count in 2-byte-code show string";
    }
    for (let offset = 0; offset < bytes.length; offset += font.bytesPerCode) {
      const code =
        font.bytesPerCode === 1
          ? bytes[offset]!
          : bytes[offset]! * 256 + bytes[offset + 1]!;
      const w0Em = font.widthOf(code) / 1000;
      const isWordSpaced =
        font.appliesWordSpacing && code === 0x20 && gs.wordSpacing !== 0;
      const spacing = gs.charSpacing + (isWordSpaced ? gs.wordSpacing : 0);
      // Glyph space (em units) → text space → user space.
      const trm = multiply(
        multiply(
          [
            gs.fontSize * gs.horizontalScale,
            0,
            0,
            gs.fontSize,
            0,
            gs.rise,
          ],
          tm,
        ),
        gs.ctm,
      );
      const quad: [Point, Point, Point, Point] = [
        apply(trm, { x: 0, y: font.descentEm }),
        apply(trm, { x: w0Em, y: font.descentEm }),
        apply(trm, { x: w0Em, y: font.ascentEm }),
        apply(trm, { x: 0, y: font.ascentEm }),
      ];
      const coreTopEm = Math.min(CORE_TOP_EM, font.ascentEm);
      const coreQuad: [Point, Point, Point, Point] = [
        apply(trm, { x: 0, y: 0 }),
        apply(trm, { x: w0Em, y: 0 }),
        apply(trm, { x: w0Em, y: coreTopEm }),
        apply(trm, { x: 0, y: coreTopEm }),
      ];
      glyphs.push({
        opIndex,
        arrayItemIndex,
        byteOffset: offset,
        byteLength: font.bytesPerCode,
        code,
        fontName: gs.fontName,
        quad,
        coreQuad,
        tjCompensation: 1000 * (w0Em + spacing / gs.fontSize),
      });
      const advance =
        (w0Em * gs.fontSize + spacing) * gs.horizontalScale;
      translateText(advance, 0);
    }
    return null;
  };

  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const op = ops[opIndex]!;
    switch (op.operator) {
      case "q":
        stack.push({ ...gs });
        break;
      case "Q": {
        const restored = stack.pop();
        if (!restored) return fail("Q with empty graphics state stack");
        gs = restored;
        break;
      }
      case "cm": {
        const nums = operandNumbers(op, 6);
        if (!nums) return fail("malformed cm operands");
        gs.ctm = multiply(nums as Matrix, gs.ctm);
        break;
      }
      case "gs": {
        const name =
          op.operands.length === 1 && op.operands[0]!.kind === "name"
            ? op.operands[0]!.value
            : null;
        if (name === null) return fail("malformed gs operands");
        const setsFont = callbacks.extGStateSetsFont?.(name) ?? null;
        if (setsFont !== false) gs.fontTainted = true;
        break;
      }
      case "BT":
        if (inTextObject) return fail("nested BT");
        inTextObject = true;
        tm = IDENTITY;
        tlm = IDENTITY;
        tmUnknown = false;
        break;
      case "ET":
        if (!inTextObject) return fail("ET without BT");
        inTextObject = false;
        break;
      case "Tc": {
        const nums = operandNumbers(op, 1);
        if (!nums) return fail("malformed Tc operands");
        gs.charSpacing = nums[0]!;
        break;
      }
      case "Tw": {
        const nums = operandNumbers(op, 1);
        if (!nums) return fail("malformed Tw operands");
        gs.wordSpacing = nums[0]!;
        break;
      }
      case "Tz": {
        const nums = operandNumbers(op, 1);
        if (!nums) return fail("malformed Tz operands");
        gs.horizontalScale = nums[0]! / 100;
        break;
      }
      case "TL": {
        const nums = operandNumbers(op, 1);
        if (!nums) return fail("malformed TL operands");
        gs.leading = nums[0]!;
        break;
      }
      case "Ts": {
        const nums = operandNumbers(op, 1);
        if (!nums) return fail("malformed Ts operands");
        gs.rise = nums[0]!;
        break;
      }
      case "Tr": {
        const nums = operandNumbers(op, 1);
        if (!nums) return fail("malformed Tr operands");
        gs.renderMode = nums[0]!;
        break;
      }
      case "Tf": {
        if (
          op.operands.length !== 2 ||
          op.operands[0]!.kind !== "name" ||
          op.operands[1]!.kind !== "number"
        ) {
          return fail("malformed Tf operands");
        }
        gs.fontName = op.operands[0]!.value;
        gs.fontSize = op.operands[1]!.value;
        gs.fontTainted = false;
        break;
      }
      case "Td": {
        const nums = operandNumbers(op, 2);
        if (!nums) return fail("malformed Td operands");
        if (!inTextObject) return fail("Td outside BT/ET");
        nextLine(nums[0]!, nums[1]!);
        break;
      }
      case "TD": {
        const nums = operandNumbers(op, 2);
        if (!nums) return fail("malformed TD operands");
        if (!inTextObject) return fail("TD outside BT/ET");
        gs.leading = -nums[1]!;
        nextLine(nums[0]!, nums[1]!);
        break;
      }
      case "Tm": {
        const nums = operandNumbers(op, 6);
        if (!nums) return fail("malformed Tm operands");
        if (!inTextObject) return fail("Tm outside BT/ET");
        tm = nums as Matrix;
        tlm = nums as Matrix;
        tmUnknown = false;
        break;
      }
      case "T*":
        if (op.operands.length !== 0) return fail("malformed T* operands");
        if (!inTextObject) return fail("T* outside BT/ET");
        nextLine(0, -gs.leading);
        break;
      case "Tj": {
        if (op.operands.length !== 1 || op.operands[0]!.kind !== "string") {
          return fail("malformed Tj operands");
        }
        const error = show(op.operands[0]!.bytes, opIndex, -1);
        if (error) return fail(error);
        break;
      }
      case "'": {
        if (op.operands.length !== 1 || op.operands[0]!.kind !== "string") {
          return fail("malformed ' operands");
        }
        if (!inTextObject) return fail("' outside BT/ET");
        nextLine(0, -gs.leading);
        const error = show(op.operands[0]!.bytes, opIndex, -1);
        if (error) return fail(error);
        break;
      }
      case '"': {
        if (
          op.operands.length !== 3 ||
          op.operands[0]!.kind !== "number" ||
          op.operands[1]!.kind !== "number" ||
          op.operands[2]!.kind !== "string"
        ) {
          return fail('malformed " operands');
        }
        if (!inTextObject) return fail('" outside BT/ET');
        gs.wordSpacing = op.operands[0]!.value;
        gs.charSpacing = op.operands[1]!.value;
        nextLine(0, -gs.leading);
        const error = show(op.operands[2]!.bytes, opIndex, -1);
        if (error) return fail(error);
        break;
      }
      case "TJ": {
        if (op.operands.length !== 1 || op.operands[0]!.kind !== "array") {
          return fail("malformed TJ operands");
        }
        const items: ContentOperand[] = op.operands[0]!.items;
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          const item = items[itemIndex]!;
          if (item.kind === "string") {
            const error = show(item.bytes, opIndex, itemIndex);
            if (error) return fail(error);
          } else if (item.kind === "number") {
            translateText(
              (-item.value / 1000) * gs.fontSize * gs.horizontalScale,
              0,
            );
          } else {
            return fail("TJ array item is neither string nor number");
          }
        }
        break;
      }
      case "Do": {
        const name =
          op.operands.length === 1 && op.operands[0]!.kind === "name"
            ? op.operands[0]!.value
            : null;
        if (name === null) return fail("malformed Do operands");
        xobjects.push({ opIndex, name, ctm: [...gs.ctm] });
        break;
      }
      case "BI":
        inlineImages.push({ opIndex, ctm: [...gs.ctm] });
        break;
      default:
        // Painting, color, path, and marked-content operators do not affect
        // text geometry. Their bytes pass through the rewrite verbatim.
        break;
    }
  }
  if (inTextObject) return fail("unterminated BT");
  return { ok: true, glyphs, xobjects, inlineImages, unplacedText };
}
