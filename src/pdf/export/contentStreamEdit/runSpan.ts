// Pure span compiler. Every source slice stays byte-for-byte/code-for-code;
// TJ restores each edited span's original endpoint before its suffix is shown.
import type { ResolvedRunFont, RunEdit, RunPlan, Overflow } from './replaceRun';
import type { ShowTextState, GlyphPlacement } from './textState';
import { codes, encodeRun, hex, pdfNumber, same, pdfName } from './runEncoding';
type Segment = { font: ResolvedRunFont; bytes: Uint8Array };
function segments(text: string, font: ResolvedRunFont, original: Uint8Array, fallbacks: readonly ResolvedRunFont[]): Segment[] {
  const encoded = encodeRun(text, font, original);
  if (encoded.ok) return [{ font, bytes: encoded.bytes }];
  if (!fallbacks.length || !font.canEncode) throw Object.assign(Error(encoded.reason), { firstMissing: encoded.firstMissing, offset: encoded.offset });
  const result: Segment[] = [];
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const source = encodeRun(segment, font, original);
    let resolved = source.ok ? { font, bytes: source.bytes } : undefined;
    if (!resolved) for (const fallback of fallbacks) {
      const out = encodeRun(segment, fallback, new Uint8Array());
      if (out.ok) { resolved = { font: fallback, bytes: out.bytes }; break; }
    }
    if (!resolved) throw Error(`fallback missing glyph: ${segment}`);
    const previous = result.at(-1);
    if (previous?.font === resolved.font) {
      previous.bytes = Uint8Array.from([...previous.bytes, ...resolved.bytes]);
    } else result.push(resolved);
  }
  return result;
}
function advance(bytes: Uint8Array, font: ResolvedRunFont, state: ShowTextState): number {
  return codes(bytes, font.bytesPerCode).reduce((sum, code) => {
    const width = font.widthOf(code);
    if (!Number.isFinite(width) || width < 0) throw Error('invalid glyph width');
    return sum + width + 1000 * (state.charSpacing + (font.bytesPerCode === 1 && code === 32 ? state.wordSpacing : 0)) / state.fontSize;
  }, 0);
}
export function compileSpanItem(original: Uint8Array, font: ResolvedRunFont, state: ShowTextState,
  edits: readonly RunEdit[], plan: RunPlan, glyphs: readonly GlyphPlacement[]) {
  if (codes(original, font.bytesPerCode).some(c => !font.unicodeByCode.has(c))) throw Error('original code missing ToUnicode');
  const scale = Math.hypot(state.advanceVector.x, state.advanceVector.y);
  if (!scale || state.fontSize <= 0) throw Error('unsupported text advance direction');
  let cursor = 0, changed = false, overflow: Overflow | undefined;
  const parts: string[] = [];
  for (const edit of edits) {
    if (edit.availablePt !== undefined && (!Number.isFinite(edit.availablePt) || edit.availablePt < 0)) throw Error('invalid available space');
    const span = original.slice(edit.byteStart, edit.byteEnd);
    const replacement = segments(edit.replacement, font, span, plan.fallbackFonts ?? []);
    const oldAdvance = advance(span, font, state);
    const newAdvance = replacement.reduce((n,s) => n + advance(s.bytes, s.font, state), 0);
    const factor = state.fontSize * scale / 1000;
    let availablePt = Math.max(0, oldAdvance * factor);
    // Paint order is unrelated to baseline order: a glyph drawn earlier or
    // after another line can still occupy the replacement's forward slot.
    const prefixAdvance = advance(original.slice(0,edit.byteStart), font, state) * state.fontSize / 1000;
    const start = { x: state.origin.x + prefixAdvance * state.advanceVector.x, y: state.origin.y + prefixAdvance * state.advanceVector.y };
    for (const glyph of glyphs) {
      const addressed = glyph.opIndex === edit.opIndex && glyph.arrayItemIndex === edit.itemIndex &&
        glyph.byteOffset >= edit.byteStart && glyph.byteOffset < edit.byteEnd;
      if (addressed) continue;
      const dx = glyph.coreQuad[0].x - start.x, dy = glyph.coreQuad[0].y - start.y;
      const along = (dx * state.advanceVector.x + dy * state.advanceVector.y) / scale;
      const across = Math.abs(dx * state.advanceVector.y - dy * state.advanceVector.x) / scale;
      if (across <= .01 && along >= -1e-7) availablePt = Math.min(availablePt, Math.max(0,along));
    }
    availablePt = Math.min(availablePt, edit.availablePt ?? Infinity);
    const neededPt = Math.max(0, newAdvance * factor);
    if (neededPt > availablePt + 1e-7) overflow ??= { availablePt, neededPt };
    const identity = replacement.length === 1 && replacement[0]!.font === font && same(replacement[0]!.bytes,span);
    changed ||= !identity || !!plan.forceReencode;
    if (edit.byteStart > cursor) parts.push(`[${hex(original.slice(cursor,edit.byteStart))}] TJ`);
    let current = font;
    for (const segment of replacement) {
      if (segment.font !== current) { parts.push(`${pdfName(segment.font.resourceName)} ${pdfNumber(state.fontSize)} Tf`); current = segment.font; }
      parts.push(`[${hex(segment.bytes)}] TJ`);
    }
    if (current !== font) parts.push(`${pdfName(font.resourceName)} ${pdfNumber(state.fontSize)} Tf`);
    const compensation = pdfNumber(newAdvance - oldAdvance);
    const last = parts.at(-1);
    if (last?.endsWith('] TJ')) parts[parts.length-1] = last.slice(0,-4) + ` ${compensation}] TJ`;
    else parts.push(`[${compensation}] TJ`);
    cursor = edit.byteEnd;
  }
  if (cursor < original.length) parts.push(`[${hex(original.slice(cursor))}] TJ`);
  return { patch: parts.join(' '), changed, overflow };
}
