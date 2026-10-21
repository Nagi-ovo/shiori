// Rewrite stage of the glyph-removal pass: given glyph placements from
// walkTextPlacements and the cover rects of a contentText edit, produce new
// content-stream bytes with the covered glyphs' draw calls removed.
//
// Two invariants the rewrite must never break:
// 1. Geometry of everything else is untouched. A removed glyph's whole
//    displacement (advance width + char/word spacing) is re-inserted as a TJ
//    adjustment, so following glyphs in the same text object do not shift.
// 2. Bytes outside the rewritten show ops are copied verbatim via the
//    tokenizer's extents — no re-serialization of ops we didn't change. The
//    one other edit: a BDC property list enclosing a removed glyph loses its
//    /ActualText, /Alt and /E entries, which would otherwise still hand the
//    removed text to extractors that honour them (a named list through a
//    sanitized copy the caller registers).
//
// Hit policy is conservative: a glyph is removed only when one cover rect
// holds its whole advance, from the baseline up through its core band
// (GlyphPlacement.coreQuad; small epsilon for float noise), or when a rect
// holding no core band hugs the ink of glyphs floating off the baseline
// (removalsByRect). The font-wide ascent/descent box is not required:
// editor covers hug the ink or a band normalized to one em, and many fonts
// declare a taller box. Partially covered glyphs stay — deleting a glyph
// the user can still half-see is worse than leaving one they meant to
// cover — and a rect is clean only when no glyph left in the stream touches
// its full advance box.

import type { PdfRect } from "../../model/types";
import type { ContentOp, ContentOperand } from "./tokenizer";
import type { GlyphPlacement, Point } from "./textState";

// Which /Font resource the glyphs removed inside one cover rect were shown
// with: "none" when the rect removed no glyphs, "mixed" when they came from
// more than one font — both mean the export cannot reuse a single source
// font for that rect's replacement text.
export type RectFontAttribution =
  | { kind: "none" }
  | { kind: "mixed" }
  | { kind: "font"; name: string };

export type GlyphRemovalResult =
  | {
      changed: false;
      removedCount: number;
      cleanRects: boolean[];
      rectFonts: RectFontAttribution[];
    }
  | {
      changed: true;
      bytes: Uint8Array;
      removedCount: number;
      cleanRects: boolean[];
      rectFonts: RectFontAttribution[];
    };

const HIT_EPSILON = 0.01;

function rectBounds(rect: PdfRect): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return {
    minX: Math.min(rect.x, rect.x + rect.w),
    minY: Math.min(rect.y, rect.y + rect.h),
    maxX: Math.max(rect.x, rect.x + rect.w),
    maxY: Math.max(rect.y, rect.y + rect.h),
  };
}

function pointInRect(p: Point, rect: PdfRect): boolean {
  const bounds = rectBounds(rect);
  return (
    p.x >= bounds.minX - HIT_EPSILON &&
    p.x <= bounds.maxX + HIT_EPSILON &&
    p.y >= bounds.minY - HIT_EPSILON &&
    p.y <= bounds.maxY + HIT_EPSILON
  );
}

function quadBounds(quad: GlyphPlacement["quad"]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return {
    minX: Math.min(...quad.map((point) => point.x)),
    minY: Math.min(...quad.map((point) => point.y)),
    maxX: Math.max(...quad.map((point) => point.x)),
    maxY: Math.max(...quad.map((point) => point.y)),
  };
}

function rectCorners(rect: PdfRect): [Point, Point, Point, Point] {
  const bounds = rectBounds(rect);
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  return (
    Math.abs(cross(a, b, p)) <= HIT_EPSILON &&
    p.x >= Math.min(a.x, b.x) - HIT_EPSILON &&
    p.x <= Math.max(a.x, b.x) + HIT_EPSILON &&
    p.y >= Math.min(a.y, b.y) - HIT_EPSILON &&
    p.y <= Math.max(a.y, b.y) + HIT_EPSILON
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);

  if (
    pointOnSegment(c, a, b) ||
    pointOnSegment(d, a, b) ||
    pointOnSegment(a, c, d) ||
    pointOnSegment(b, c, d)
  ) {
    return true;
  }

  return (
    (abC > HIT_EPSILON) !== (abD > HIT_EPSILON) &&
    (cdA > HIT_EPSILON) !== (cdB > HIT_EPSILON)
  );
}

function pointInQuad(p: Point, quad: GlyphPlacement["quad"]): boolean {
  let hasPositive = false;
  let hasNegative = false;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % quad.length]!;
    const value = cross(a, b, p);
    if (value > HIT_EPSILON) hasPositive = true;
    else if (value < -HIT_EPSILON) hasNegative = true;
    if (hasPositive && hasNegative) return false;
  }
  return true;
}

function quadInsideRect(quad: GlyphPlacement["quad"], rect: PdfRect): boolean {
  return quad.every((corner) => pointInRect(corner, rect));
}

export function quadIntersectsRect(
  quad: GlyphPlacement["quad"],
  rect: PdfRect,
): boolean {
  const qb = quadBounds(quad);
  const rb = rectBounds(rect);
  if (
    qb.maxX < rb.minX - HIT_EPSILON ||
    qb.minX > rb.maxX + HIT_EPSILON ||
    qb.maxY < rb.minY - HIT_EPSILON ||
    qb.minY > rb.maxY + HIT_EPSILON
  ) {
    return false;
  }

  if (quad.some((corner) => pointInRect(corner, rect))) return true;
  const corners = rectCorners(rect);
  if (corners.some((corner) => pointInQuad(corner, quad))) return true;

  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % quad.length]!;
    for (let j = 0; j < corners.length; j += 1) {
      const c = corners[j]!;
      const d = corners[(j + 1) % corners.length]!;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

// Whether an upright glyph's font box holds the rect while the rect spans
// its whole advance: the shape of a cover that hugs the ink of a glyph
// floating off the baseline (a dash, an underscore, a quote).
function rectHugsUprightGlyph(rect: PdfRect, quad: GlyphPlacement["quad"]): boolean {
  const [origin, advance, , top] = quad;
  if (
    Math.abs(advance.y - origin.y) > HIT_EPSILON ||
    Math.abs(top.x - origin.x) > HIT_EPSILON ||
    advance.x <= origin.x ||
    top.y <= origin.y
  ) {
    return false;
  }
  const rb = rectBounds(rect);
  const qb = quadBounds(quad);
  return (
    rb.minX <= qb.minX + HIT_EPSILON &&
    rb.maxX >= qb.maxX - HIT_EPSILON &&
    rb.minY >= qb.minY - HIT_EPSILON &&
    rb.maxY <= qb.maxY + HIT_EPSILON
  );
}

// Side margin a hugging cover may leave past its glyphs: the editor's cover
// pad plus the selection's inline edge padding.
function hugSlack(rect: PdfRect): number {
  return 0.8 + Math.max(3, 0.25 * Math.abs(rect.h));
}

// Per rect, the glyphs it removes. A rect removes every glyph whose core
// band it holds. A rect that holds no core band may be an ink-bounds cover
// of glyphs that float off the baseline; it removes the glyphs it hugs
// (rectHugsUprightGlyph), but only when together they span the rect, so a
// cover over a much larger glyph (a heading, a watermark) keeps it.
function removalsByRect(
  glyphs: GlyphPlacement[],
  coverRects: PdfRect[],
): Set<GlyphPlacement>[] {
  return coverRects.map((rect) => {
    const core = glyphs.filter((glyph) => quadInsideRect(glyph.coreQuad, rect));
    if (core.length > 0) return new Set(core);
    const hugged = glyphs.filter((glyph) => rectHugsUprightGlyph(rect, glyph.quad));
    if (hugged.length === 0) return new Set();
    const rb = rectBounds(rect);
    const minX = Math.min(...hugged.map((glyph) => quadBounds(glyph.quad).minX));
    const maxX = Math.max(...hugged.map((glyph) => quadBounds(glyph.quad).maxX));
    const slack = hugSlack(rect);
    return minX <= rb.minX + slack && maxX >= rb.maxX - slack
      ? new Set(hugged)
      : new Set();
  });
}

function classifyGlyphCoverage(
  glyphs: GlyphPlacement[],
  coverRects: PdfRect[],
): {
  hits: GlyphPlacement[];
  cleanRects: boolean[];
  rectFonts: RectFontAttribution[];
} {
  const cleanRects = coverRects.map(() => true);
  const rectFonts: RectFontAttribution[] = coverRects.map(() => ({
    kind: "none",
  }));
  const hits: GlyphPlacement[] = [];
  const removals = removalsByRect(glyphs, coverRects);

  for (const glyph of glyphs) {
    let removeGlyph = false;
    for (let rectIndex = 0; rectIndex < coverRects.length; rectIndex += 1) {
      if (removals[rectIndex]!.has(glyph)) {
        removeGlyph = true;
        const attribution = rectFonts[rectIndex]!;
        if (attribution.kind === "none") {
          rectFonts[rectIndex] = { kind: "font", name: glyph.fontName };
        } else if (
          attribution.kind === "font" &&
          attribution.name !== glyph.fontName
        ) {
          rectFonts[rectIndex] = { kind: "mixed" };
        }
      }
    }
    if (removeGlyph) {
      hits.push(glyph);
      continue;
    }
    // A glyph that stays is still drawn: any rect it touches needs its cover.
    for (let rectIndex = 0; rectIndex < coverRects.length; rectIndex += 1) {
      if (quadIntersectsRect(glyph.quad, coverRects[rectIndex]!)) {
        cleanRects[rectIndex] = false;
      }
    }
  }

  return { hits, cleanRects, rectFonts };
}

// PDF numbers: plain decimal, no exponent. Four decimals ≈ 1.2e-4 pt of
// advance at 12pt — far below anything visible.
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  if (Object.is(rounded, -0) || rounded === 0) return "0";
  let out = rounded.toFixed(4);
  out = out.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

function formatHexString(bytes: Uint8Array): string {
  let out = "<";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out + ">";
}

// One rebuilt TJ item: either kept glyph bytes or an accumulated adjustment.
type TjPiece =
  | { kind: "bytes"; bytes: number[] }
  | { kind: "adjust"; value: number };

class TjBuilder {
  private pieces: TjPiece[] = [];

  keepBytes(source: Uint8Array, start: number, end: number): void {
    if (end <= start) return;
    const last = this.pieces[this.pieces.length - 1];
    const chunk = Array.from(source.subarray(start, end));
    if (last?.kind === "bytes") last.bytes.push(...chunk);
    else this.pieces.push({ kind: "bytes", bytes: chunk });
  }

  // TJ numbers displace by (−n/1000)·Tfs, so reproducing a removed glyph's
  // displacement means inserting −compensation. Consecutive adjustments
  // (removed glyph + original kerning number, or two removed glyphs) merge.
  adjust(value: number): void {
    if (value === 0) return;
    const last = this.pieces[this.pieces.length - 1];
    if (last?.kind === "adjust") last.value += value;
    else this.pieces.push({ kind: "adjust", value });
  }

  serialize(): string {
    const items = this.pieces
      .map((piece) =>
        piece.kind === "bytes"
          ? formatHexString(new Uint8Array(piece.bytes))
          : formatNumber(piece.value),
      )
      .filter((item) => item !== "0");
    return `[${items.join(" ")}] TJ`;
  }
}

function rebuildStringItem(
  builder: TjBuilder,
  bytes: Uint8Array,
  removed: GlyphPlacement[],
): void {
  let cursor = 0;
  for (const glyph of removed) {
    builder.keepBytes(bytes, cursor, glyph.byteOffset);
    builder.adjust(-glyph.tjCompensation);
    cursor = glyph.byteOffset + glyph.byteLength;
  }
  builder.keepBytes(bytes, cursor, bytes.length);
}

// Rebuilds one show op (Tj / TJ / ' / ") with its removed glyphs excised.
// The quote operators carry side effects (line advance, " sets Tw/Tc), which
// are re-emitted as explicit operators before the TJ.
function rebuildShowOp(op: ContentOp, removed: GlyphPlacement[]): string {
  const byOffset = [...removed].sort((a, b) => a.byteOffset - b.byteOffset);
  const builder = new TjBuilder();

  if (op.operator === "TJ") {
    const array = op.operands[0]!;
    if (array.kind !== "array") throw new Error("TJ operand must be array");
    array.items.forEach((item: ContentOperand, itemIndex: number) => {
      if (item.kind === "number") {
        builder.adjust(item.value);
        return;
      }
      if (item.kind !== "string") throw new Error("unexpected TJ item");
      rebuildStringItem(
        builder,
        item.bytes,
        byOffset.filter((glyph) => glyph.arrayItemIndex === itemIndex),
      );
    });
    return builder.serialize();
  }

  const text = op.operands[op.operands.length - 1]!;
  if (text.kind !== "string") throw new Error("show operand must be string");
  rebuildStringItem(builder, text.bytes, byOffset);

  switch (op.operator) {
    case "Tj":
      return builder.serialize();
    case "'":
      return `T* ${builder.serialize()}`;
    case '"': {
      const aw = op.operands[0]!;
      const ac = op.operands[1]!;
      if (aw.kind !== "number" || ac.kind !== "number") {
        throw new Error('malformed " operands');
      }
      return `${formatNumber(aw.value)} Tw ${formatNumber(ac.value)} Tc T* ${builder.serialize()}`;
    }
    default:
      throw new Error(`not a show op: ${op.operator}`);
  }
}

// Property-list keys that carry a text equivalent of the marked content.
const ALT_TEXT_KEYS = new Set(["ActualText", "Alt", "E"]);

// A name token for a decoded name value, #-escaping every byte that is not
// a regular printable character.
function nameToken(value: string): string {
  let out = "/";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out +=
      code > 0x20 && code < 0x7f && !"()<>[]{}/%#".includes(char)
        ? char
        : `#${code.toString(16).padStart(2, "0")}`;
  }
  return out;
}

// Called for a BDC enclosing a removed glyph whose property list is named:
// the name of a copy of that list without its alternate text, or null when
// the list has none to drop.
export type RenameProperties = (name: string) => string | null;

// The BDC op with its alternate-text entries blanked out, or null when its
// property list has none. A named list is not edited in place (it may be
// shared): the op is pointed at the copy renameProperties names instead.
function stripAltText(
  source: Uint8Array,
  op: ContentOp,
  renameProperties: RenameProperties | undefined,
): Uint8Array | null {
  const properties = op.operands[op.operands.length - 1];
  if (op.operator !== "BDC") return null;
  if (properties?.kind === "name") {
    const tag = op.operands[0];
    const renamed = renameProperties?.(properties.value) ?? null;
    if (renamed === null || op.operands.length !== 2 || tag?.kind !== "name") {
      return null;
    }
    return new TextEncoder().encode(
      `${nameToken(tag.value)} ${nameToken(renamed)} BDC`,
    );
  }
  if (properties?.kind !== "dict") return null;
  const drop = properties.entries.filter((entry) => ALT_TEXT_KEYS.has(entry.key));
  if (drop.length === 0) return null;
  const chunks: Uint8Array[] = [];
  let cursor = op.start;
  for (const entry of drop) {
    chunks.push(source.subarray(cursor, entry.start), SPACE);
    cursor = entry.end;
  }
  chunks.push(source.subarray(cursor, op.end));
  return concatBytes(chunks);
}

const SPACE = new Uint8Array([0x20]);

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function removeCoveredGlyphs(
  source: Uint8Array,
  ops: ContentOp[],
  glyphs: GlyphPlacement[],
  coverRects: PdfRect[],
  renameProperties?: RenameProperties,
): GlyphRemovalResult {
  const { hits, cleanRects, rectFonts } = classifyGlyphCoverage(
    glyphs,
    coverRects,
  );
  if (hits.length === 0) {
    return { changed: false, removedCount: 0, cleanRects, rectFonts };
  }

  const byOp = new Map<number, GlyphPlacement[]>();
  for (const hit of hits) {
    const list = byOp.get(hit.opIndex);
    if (list) list.push(hit);
    else byOp.set(hit.opIndex, [hit]);
  }

  const encoder = new TextEncoder();
  const replacements = new Map<number, Uint8Array>();
  for (const [opIndex, removed] of byOp) {
    replacements.set(
      opIndex,
      encoder.encode(rebuildShowOp(ops[opIndex]!, removed)),
    );
  }
  for (const opIndex of new Set(hits.flatMap((hit) => hit.markedContent))) {
    const stripped = stripAltText(source, ops[opIndex]!, renameProperties);
    if (stripped) replacements.set(opIndex, stripped);
  }

  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const [opIndex, bytes] of [...replacements.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const op = ops[opIndex]!;
    chunks.push(source.subarray(cursor, op.start));
    chunks.push(bytes);
    cursor = op.end;
  }
  chunks.push(source.subarray(cursor));

  return {
    changed: true,
    bytes: concatBytes(chunks),
    removedCount: hits.length,
    cleanRects,
    rectFonts,
  };
}
