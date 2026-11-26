import {RunCompileError} from './runRefusal';
// Pure span compiler. Every source slice stays byte-for-byte/code-for-code;
// TJ restores the original position before unowned text is shown.
import type { ResolvedRunFont, RunEdit, RunPlan, Overflow } from './replaceRun';
import type { ShowTextState, GlyphPlacement } from './textState';
import { codes, encodeRun, hex, pdfNumber, same, pdfName } from './runEncoding';
import { fallbackClusters } from './fallbackClusters';
type Segment = { font: ResolvedRunFont; bytes: Uint8Array };
function segments(text: string, font: ResolvedRunFont, original: Uint8Array, fallbacks: readonly ResolvedRunFont[], resources: RunEdit['fallbackResources'], allowPermutation=false): Segment[] {
  let encoded = encodeRun(text, font, original,allowPermutation);
  // Preserve an existing exact source encoding first. If unavailable, use the
  // same NFC spelling as fallback preparation, even if the source covers it.
  if (!encoded.ok && text !== text.normalize('NFC')) {
    text = text.normalize('NFC');
    encoded = encodeRun(text, font, original,allowPermutation);
  }
  if (encoded.ok) return [{ font, bytes: encoded.bytes }];
  if (!fallbacks.length || !font.canEncode) throw Object.assign(new RunCompileError(encoded.reason,'font-coverage'), { firstMissing: encoded.firstMissing, offset: encoded.offset });
  const result: Segment[] = [];
  for (const segment of fallbackClusters(text)) {
    const source = encodeRun(segment, font, original);
    let resolved = source.ok ? { font, bytes: source.bytes } : undefined;
    if (!resolved) for (const fallback of fallbacks) {
      if (resources && resources.get(segment) !== fallback.resourceName) continue;
      const out = encodeRun(segment, fallback, new Uint8Array());
      if (out.ok) { resolved = { font: fallback, bytes: out.bytes }; break; }
    }
    if (!resolved) throw new RunCompileError(`fallback missing glyph: ${segment}`,'font-coverage');
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
    if (!Number.isFinite(width) || width < 0) throw new RunCompileError('invalid glyph width','font-coverage');
    return sum + width + 1000 * (state.charSpacing + (font.bytesPerCode === 1 && code === 32 ? state.wordSpacing : 0)) / state.fontSize;
  }, 0);
}
export function deletionGapAdjustment(edit: RunEdit, state: ShowTextState): number {
  const gapPt = edit.closeUpThrough?.gapPt ?? 0;
  if (!Number.isFinite(gapPt)) throw new RunCompileError('invalid deletion gap');
  return Math.abs(gapPt) > 1e-7 ? gapPt * 1000 / (state.fontSize * state.advanceVector.x) : 0;
}
export function compileSpanItem(original: Uint8Array, font: ResolvedRunFont, state: ShowTextState,
  edits: readonly RunEdit[], plan: RunPlan, glyphs: readonly GlyphPlacement[], rejoins: ReadonlyMap<number, number>) {
  if (codes(original, font.bytesPerCode).some(c => !font.unicodeByCode.has(c))) throw new RunCompileError('original code missing ToUnicode','font-unavailable');
  const scale = Math.hypot(state.advanceVector.x, state.advanceVector.y);
  if (!scale || state.fontSize <= 0) throw new RunCompileError('unsupported text advance direction','unsupported-matrix');
  let cursor = 0, overflow: Overflow | undefined;
  let overflowSlot: Pick<RunEdit, 'opIndex' | 'itemIndex' | 'byteStart'> | undefined;
  let changed = rejoins.size > 0;
  const parts: string[] = [];
  const boundaries = [...rejoins].sort(([left], [right]) => left - right).values();
  let boundary = boundaries.next();
  const emitOriginal = (end: number) => {
    while (!boundary.done && boundary.value[0] <= end) {
      const [at, compensation] = boundary.value;
      if (at < cursor) throw new RunCompileError('deletion rejoin overlaps another edit');
      if (at > cursor) parts.push(`[${hex(original.slice(cursor, at))}] TJ`);
      parts.push(`[${pdfNumber(compensation)}] TJ`);
      cursor = at;
      boundary = boundaries.next();
    }
    if (end > cursor) parts.push(`[${hex(original.slice(cursor, end))}] TJ`);
    cursor = end;
  };
  for (const edit of edits) {
    if (edit.availablePt !== undefined && (!Number.isFinite(edit.availablePt) || edit.availablePt < 0)) throw new RunCompileError('invalid available space','unsupported-state');
    const span = original.slice(edit.byteStart, edit.byteEnd);
    const replacement = segments(edit.replacement, font, span, plan.fallbackFonts ?? [], edit.fallbackResources, plan.allowExistingCodePermutation);
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
    if (neededPt > availablePt + 1e-7 && !overflow) {
      overflow = { availablePt, neededPt };
      const {opIndex,itemIndex,byteStart} = edit;
      overflowSlot = {opIndex,itemIndex,byteStart};
    }
    const identity = replacement.length === 1 && replacement[0]!.font === font && same(replacement[0]!.bytes,span);
    changed ||= !identity || !!plan.forceReencode;
    emitOriginal(edit.byteStart);
    let current = font;
    for (const segment of replacement) {
      if (segment.font !== current) { parts.push(`${pdfName(segment.font.resourceName)} ${pdfNumber(state.fontSize)} Tf`); current = segment.font; }
      if (segment.bytes.length) parts.push(`[${hex(segment.bytes)}] TJ`);
    }
    if (current !== font) parts.push(`${pdfName(font.resourceName)} ${pdfNumber(state.fontSize)} Tf`);
    const compensation = edit.closeUpThrough ? deletionGapAdjustment(edit, state) : newAdvance - oldAdvance;
    if (compensation || !edit.closeUpThrough) parts.push(`[${pdfNumber(compensation)}] TJ`);
    cursor = edit.byteEnd;
  }
  emitOriginal(original.length);
  return { patch: parts.join(' '), changed, overflow, overflowSlot };
}
