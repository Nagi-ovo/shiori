// Pure decoded-content compiler. The caller resolves fonts from the same
// immutable PDF revision. No page dictionaries or PDF writer types enter here.
import { sha256 } from '@noble/hashes/sha2.js';
import { tokenizeContentStream, type ContentOperand } from './tokenizer';
import { walkTextPlacements, type ShowTextState } from './textState';

export type ResolvedRunFont = {
  resourceName: string;
  objectId: string;
  bytesPerCode: 1 | 2;
  widthOf: (code: number) => number;
  ascentEm: number;
  descentEm: number;
  unicodeByCode: ReadonlyMap<number, string>;
};
export type RunEdit = {
  fontResource: string;
  fontObject: string;
  opIndex: number;
  itemIndex: number; // -1 for Tj, actual array index for TJ
  byteStart: number;
  byteEnd: number;
  expected: Uint8Array;
  replacement: string;
};
export type RunPlan = {
  sourceHash: string;
  edits: readonly RunEdit[];
  forceReencode?: boolean;
  scope?: 'page' | 'form';
};
export type RunResult = { ok: true; bytes: Uint8Array } | { ok: false; bytes: Uint8Array; reason: string };
export function sourceFingerprint(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
const ascii = new TextEncoder();
const hex = (bytes: Uint8Array) => `<${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}>`;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
function number(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw Error('unrepresentable TJ compensation');
  // PDF numbers do not permit exponent notation. Keep the rounding error well
  // below 0.01pt even for large practical text sizes.
  return n.toFixed(10).replace(/\.?0+$/, '') || '0';
}
function codes(bytes: Uint8Array, size: 1 | 2): number[] {
  if (bytes.length % size) throw Error('unaligned source codes');
  return Array.from({ length: bytes.length / size }, (_, i) => size === 1
    ? bytes[i]! : bytes[2 * i]! * 256 + bytes[2 * i + 1]!);
}
function encode(text: string, font: ResolvedRunFont): Uint8Array {
  if ((/[\r\n]/.test(text) || text.includes(String.fromCharCode(0)))) throw Error('replacement is not a single text run');
  const inverse = new Map<string, number | null>();
  for (const [code, unicode] of font.unicodeByCode) {
    if (Array.from(unicode).length !== 1) continue;
    inverse.set(unicode, inverse.has(unicode) ? null : code);
  }
  const out: number[] = [];
  for (const char of text) {
    const code = inverse.get(char);
    if (code == null || !Number.isInteger(code) || code < 0 || code >= 256 ** font.bytesPerCode) {
      throw Error('replacement glyph absent or ambiguous in source font');
    }
    if (font.bytesPerCode === 2) out.push(code >> 8);
    out.push(code & 255);
  }
  return new Uint8Array(out);
}

export function replaceRuns(content: Uint8Array, fonts: readonly ResolvedRunFont[], plan: RunPlan): RunResult {
  const refuse = (reason: string): RunResult => ({ ok: false, bytes: content, reason });
  try {
    if (sourceFingerprint(content) !== plan.sourceHash) return refuse('stale source fingerprint');
    if (plan.scope === 'form') return refuse('form invocation edits are unsupported');
    const ops = tokenizeContentStream(content);
    const byName = new Map(fonts.map(f => [f.resourceName, f]));
    if (byName.size !== fonts.length) return refuse('ambiguous font resource');
    const states = new Map<string, ShowTextState>();
    const walk = walkTextPlacements(ops, {
      resolveFont: name => {
        const f = byName.get(name);
        return f ? { ...f, ok: true, appliesWordSpacing: f.bytesPerCode === 1 } : null;
      },
      onShow: state => states.set(`${state.opIndex}:${state.arrayItemIndex}`, state),
    });
    if (!walk.ok) return refuse(walk.reason);
    if (walk.unplacedText) return refuse('unaccounted source text');
    if (walk.glyphs.some(g => [...g.quad, ...g.coreQuad].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) return refuse('nonfinite transformed geometry');
    const unsafe = new Set<number>();
    const stack: boolean[] = [];
    let dependent = false;
    for (const [i, op] of ops.entries()) {
      if (['BI', 'BX', 'EX'].includes(op.operator)) return refuse('unsupported opaque/compatibility context');
      if (['q', 'Q', 'BT', 'ET'].includes(op.operator) && op.operands.length) return refuse('malformed state operator');
      if (op.operator === 'q') stack.push(dependent);
      if (op.operator === 'Q') dependent = stack.pop() ?? true;
      if (['W', 'W*', 'gs', 'BMC', 'BDC'].includes(op.operator)) dependent = true;
      if (op.operator === 'Tz' && op.operands[0]?.kind === 'number' && op.operands[0].value === 0) return refuse('singular text scale');
      if (op.operator === 'Tr' && op.operands[0]?.kind === 'number' && (!Number.isInteger(op.operands[0].value) || op.operands[0].value < 0 || op.operands[0].value > 7)) return refuse('invalid rendering mode');
      if (op.operator === 'cm' || op.operator === 'Tm') {
        const values = op.operands.map(v => v.kind === 'number' ? v.value : NaN);
        if (values.length !== 6 || !values.every(Number.isFinite) || Math.abs(values[0]! * values[3]! - values[1]! * values[2]!) < 1e-12) {
          return refuse('singular or malformed matrix');
        }
      }
      if (dependent) unsafe.add(i);
    }
    if (stack.length) return refuse('unbalanced graphics state');
    const changes = new Map<number, Map<number, string>>();
    const seen = new Set<string>();
    for (const edit of plan.edits) {
      const key = `${edit.opIndex}:${edit.itemIndex}`;
      if (seen.has(key)) return refuse('overlapping edits');
      seen.add(key);
      const op = ops[edit.opIndex];
      if (!op || !['Tj', 'TJ'].includes(op.operator)) return refuse('address is not a supported show operator');
      if (unsafe.has(edit.opIndex)) return refuse('clip/graphics/semantic dependent target');
      const items = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : null;
      const item = items ? items[edit.itemIndex] : edit.itemIndex === -1 ? op.operands[0] : undefined;
      if (!item || item.kind !== 'string') return refuse('stale string item address');
      if (edit.byteStart !== 0 || edit.byteEnd !== item.bytes.length || !same(edit.expected, item.bytes)) return refuse('stale codes or unsupported partial span');
      const glyphs = walk.glyphs.filter(g => g.opIndex === edit.opIndex && g.arrayItemIndex === edit.itemIndex);
      const font = byName.get(edit.fontResource);
      const state = states.get(key);
      if (!font || font.objectId !== edit.fontObject || !state || !glyphs.every(g => g.fontName === edit.fontResource)) return refuse('stale font identity');
      // Empty shows still have font provenance via onShow.
      if (state.fontName !== edit.fontResource) return refuse('stale show font');
      const originalCodes = codes(item.bytes, font.bytesPerCode);
      if (originalCodes.some(c => !font.unicodeByCode.has(c))) return refuse('original code missing ToUnicode');
      const replacement = encode(edit.replacement, font);
      const advance = (values: number[]) => values.reduce((sum, code) => {
        const width = font.widthOf(code);
        if (!Number.isFinite(width)) throw Error('invalid glyph width');
        return sum + width + 1000 * (state.charSpacing + (font.bytesPerCode === 1 && code === 32 ? state.wordSpacing : 0)) / state.fontSize;
      }, 0);
      // TJ subtracts this number. New - Old restores the original text
      // matrix without touching the line matrix, Tc/Tw/Tz, or later kerns.
      const compensation = advance(codes(replacement, font.bytesPerCode)) - advance(originalCodes);
      if (same(item.bytes, replacement) && !plan.forceReencode) continue;
      if (!changes.has(edit.opIndex)) changes.set(edit.opIndex, new Map());
      changes.get(edit.opIndex)!.set(edit.itemIndex, `${hex(replacement)} ${number(compensation)}`);
    }
    if (!changes.size) return { ok: true, bytes: content };
    const chunks: Uint8Array[] = [];
    let cursor = 0;
    for (const [i, op] of ops.entries()) {
      const changed = changes.get(i);
      if (!changed) continue;
      chunks.push(content.subarray(cursor, op.start));
      const items: ContentOperand[] = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : op.operands;
      const body = items.map((item, index) => {
        const patch = changed.get(op.operator === 'TJ' ? index : -1);
        if (patch !== undefined) return patch;
        if (item.kind === 'string') return hex(item.bytes);
        if (item.kind === 'number') return number(item.value);
        throw Error('malformed show item');
      }).join(' ');
      chunks.push(ascii.encode(`[${body}] TJ`));
      cursor = op.end;
    }
    chunks.push(content.subarray(cursor));
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { ok: true, bytes };
  } catch (error) { return refuse(error instanceof Error ? error.message : 'invalid input'); }
}
