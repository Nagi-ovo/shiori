import {RunCompileError,runRefusal,type RunRefusalCode} from './runRefusal';
import {textObjectScopes,followsUnplaced,type RunEnvironment} from './textSafety';
// Pure decoded-content compiler. The caller resolves fonts from the same
// immutable PDF revision. No page dictionaries or PDF writer types enter here.
import type { EncodeOptions, EncodeResult } from '../fontCoverage/types';
import { sha256 } from '@noble/hashes/sha2.js';
import { ContentStreamParseError, tokenizeContentStream } from './tokenizer';
import { walkTextPlacements, type ShowTextState } from './textState';
import { same, hex, pdfNumber } from './runEncoding';
import { compileSpanItem } from './runSpan';

export type ResolvedRunFont = {
  resourceName: string;
  objectId: string;
  bytesPerCode: 1 | 2;
  widthOf: (code: number) => number;
  ascentEm: number;
  descentEm: number;
  unicodeByCode: ReadonlyMap<number, string>;
  // Synchronous verified encoder resolved from this font object/revision.
  // Missing coverage refuses; page usage and ToUnicode are never evidence.
  canEncode?: (text: string, options?: EncodeOptions) => EncodeResult;
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
  // Optional edit-box limit in PDF user-space points along the text baseline.
  availablePt?: number;
};
export type RunPlan = RunEnvironment & {
  allowExistingCodePermutation?:boolean;
  sourceHash: string;
  edits: readonly RunEdit[];
  forceReencode?: boolean;
  scope?: 'page' | 'form';
  allowOverflow?: boolean;
  fallbackFonts?: readonly ResolvedRunFont[];
  // Resolved /Properties key lists; missing/null named entries are unsafe.
  markedContentProperties?: ReadonlyMap<string, readonly string[] | null>;
};
export type Refusal = { ok: false; reason: string; code?:RunRefusalCode; firstMissing?: string; offset?: number };
export type Overflow = { availablePt: number; neededPt: number };
export type RunResult = ({ ok: true; bytes: Uint8Array } | (Refusal & { bytes: Uint8Array })) & { overflow?: Overflow };
export function sourceFingerprint(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
const ascii = new TextEncoder();

export function replaceRuns(content: Uint8Array, fonts: readonly ResolvedRunFont[], plan: RunPlan): RunResult {
  const refuse = (reason: string,code:RunRefusalCode='unsupported-state'): RunResult => ({...runRefusal(reason,code),bytes:content});
  try {
    if (sourceFingerprint(content) !== plan.sourceHash) return refuse('stale source fingerprint','stale-source');
    if (plan.scope === 'form') return refuse('form invocation edits are unsupported','form-xobject');
    const ops = tokenizeContentStream(content);
    const byName = new Map(fonts.map(f => [f.resourceName, f]));
    if (byName.size !== fonts.length) return refuse('ambiguous font resource');
    const resourceNames = new Set(byName.keys());
    for (const fallback of plan.fallbackFonts ?? []) {
      if (resourceNames.has(fallback.resourceName)) return refuse('ambiguous fallback font resource');
      resourceNames.add(fallback.resourceName);
    }
    const states = new Map<string, ShowTextState>();
    const unplaced:number[]=[];const scopes=textObjectScopes(ops);
    const walk = walkTextPlacements(ops, {
      resolveFont: name => {
        const f = byName.get(name);
        return f ? { ...f, ok: true, appliesWordSpacing: f.bytesPerCode === 1 } : {ok:false,reason:'unsupported source font'};
      },
      extGStateSetsFont:name=>plan.extGStates?.get(name)?.setsFont??null,
      onUnplaced:state=>unplaced.push(state.opIndex),
      onShow: state => states.set(`${state.opIndex}:${state.arrayItemIndex}`, state),
    });
    if (!walk.ok) return refuse(walk.reason);

    if (walk.glyphs.some(g => [...g.quad, ...g.coreQuad].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) return refuse('nonfinite transformed geometry','unsupported-matrix');
    const unsafe = new Set<number>();
    // Marked content is independent of the graphics-state q/Q stack.
    const markedContent: boolean[] = [];
    const stack: boolean[] = [];
    let dependent = false;
    for (const [i, op] of ops.entries()) {
      if (['BI', 'BX', 'EX'].includes(op.operator)) return refuse('unsupported opaque/compatibility context');
      if (['q', 'Q', 'BT', 'ET'].includes(op.operator) && op.operands.length) return refuse('malformed state operator');
      if (op.operator === 'q') stack.push(dependent);
      if (op.operator === 'Q') dependent = stack.pop() ?? true;
      if (['W','W*'].includes(op.operator))dependent=true;
      if(op.operator==='gs'){const name=op.operands[0];const state=name?.kind==='name'?plan.extGStates?.get(name.value):undefined;if(!state?.safe || state.setsFont)dependent=true;}
      if (op.operator === 'BMC' || op.operator === 'BDC') {
        if (op.operands[0]?.kind !== 'name' || op.operands.length !== (op.operator === 'BMC' ? 1 : 2)) return refuse('malformed marked content');
        let semantic = false;
        if (op.operator === 'BDC') {
          const properties = op.operands[1]!;
          const keys = properties.kind === 'dict' ? properties.entries.map(e => e.key)
            : properties.kind === 'name' ? plan.markedContentProperties?.get(properties.value) : null;
          semantic = keys == null || keys.some(k => ['ActualText', 'Alt', 'E'].includes(k));
        }
        markedContent.push(semantic);
      }
      if (op.operator === 'EMC') {
        if (op.operands.length || !markedContent.length) return refuse('unbalanced EMC');
        markedContent.pop();
      }
      if (op.operator === 'Tz' && op.operands[0]?.kind === 'number' && op.operands[0].value === 0) return refuse('singular text scale','unsupported-matrix');
      if (op.operator === 'Tr' && op.operands[0]?.kind === 'number' && (!Number.isInteger(op.operands[0].value) || op.operands[0].value < 0 || op.operands[0].value > 7)) return refuse('invalid rendering mode');
      if (op.operator === 'cm' || op.operator === 'Tm') {
        const values = op.operands.map(v => v.kind === 'number' ? v.value : NaN);
        if (values.length !== 6 || !values.every(Number.isFinite) || Math.abs(values[0]! * values[3]! - values[1]! * values[2]!) < 1e-12) {
          return refuse('singular or malformed matrix','unsupported-matrix');
        }
      }
      if (dependent || markedContent.some(Boolean)) unsafe.add(i);
    }
    if (stack.length) return refuse('unbalanced graphics state');
    if (markedContent.length) return refuse('unterminated marked content');
    const changes = new Map<number, Map<number, string>>();
    const grouped = new Map<string, RunEdit[]>();
    let overflow: Overflow | undefined;
    for (const edit of plan.edits) {
      const key = `${edit.opIndex}:${edit.itemIndex}`;
      const siblings = grouped.get(key) ?? [];
      siblings.push(edit); grouped.set(key, siblings);
      if(followsUnplaced(scopes,unplaced,edit.opIndex))return refuse('target follows an unknown advance in its text object','font-unavailable');
      const op = ops[edit.opIndex];
      if (!op || !['Tj', 'TJ'].includes(op.operator)) return refuse('address is not a supported show operator');
      if (unsafe.has(edit.opIndex)) return refuse('clip/graphics/semantic dependent target');
      const items = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : null;
      const item = items ? items[edit.itemIndex] : edit.itemIndex === -1 ? op.operands[0] : undefined;
      if (!item || item.kind !== 'string') return refuse('stale string item address','stale-source');
      if (!Number.isInteger(edit.byteStart) || !Number.isInteger(edit.byteEnd) || edit.byteStart < 0 || edit.byteEnd < edit.byteStart || edit.byteEnd > item.bytes.length) return refuse('invalid span (cross-item spans unsupported)');
      if (!same(edit.expected, item.bytes.slice(edit.byteStart, edit.byteEnd))) return refuse('stale span codes','stale-source');
      const glyphs = walk.glyphs.filter(g => g.opIndex === edit.opIndex && g.arrayItemIndex === edit.itemIndex);
      const font = byName.get(edit.fontResource);
      const state = states.get(key);
      if (!font || font.objectId !== edit.fontObject || !state || !glyphs.every(g => g.fontName === edit.fontResource)) return refuse('stale font identity','stale-source');
      // Empty shows still have font provenance via onShow.
      if (state.fontName !== edit.fontResource) return refuse('stale show font','stale-source');
      if (edit.byteStart % font.bytesPerCode || edit.byteEnd % font.bytesPerCode) return refuse('unaligned span codes');
    }
    for (const edits of grouped.values()) {
      edits.sort((a,b) => a.byteStart - b.byteStart || a.byteEnd - b.byteEnd);
      for (let i = 1; i < edits.length; i++) {
        if (edits[i]!.byteStart < edits[i-1]!.byteEnd || edits[i]!.byteStart === edits[i-1]!.byteStart) return refuse('overlapping edits');
      }
      const edit = edits[0]!, op = ops[edit.opIndex]!;
      const item = op.operator === 'TJ' && op.operands[0]?.kind === 'array'
        ? op.operands[0].items[edit.itemIndex]! : op.operands[0]!;
      if (item.kind !== 'string') return refuse('stale string item address','stale-source');
      const font = byName.get(edit.fontResource)!;
      const state = states.get(`${edit.opIndex}:${edit.itemIndex}`)!;
      const compiled = compileSpanItem(item.bytes, font, state, edits, plan, walk.glyphs);
      overflow ??= compiled.overflow;
      if (compiled.overflow && !plan.allowOverflow) return { ...refuse('replacement overflows available space','overflow'), overflow: compiled.overflow };
      if (!compiled.changed) continue;
      if (!changes.has(edit.opIndex)) changes.set(edit.opIndex, new Map());
      changes.get(edit.opIndex)!.set(edit.itemIndex, compiled.patch);
    }
    if (!changes.size) return { ok: true, bytes: content, ...(overflow ? { overflow } : {}) };
    const chunks: Uint8Array[] = [];
    let cursor = 0;
    for (const [i, op] of ops.entries()) {
      const changed = changes.get(i);
      if (!changed) continue;
      chunks.push(content.subarray(cursor, op.start));
      const items = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : op.operands;
      const body = items.map((item, index) => {
        const patch = changed.get(op.operator === 'TJ' ? index : -1);
        if (patch !== undefined) return patch;
        if (item.kind === 'string') return `[${hex(item.bytes)}] TJ`;
        if (item.kind === 'number') return `[${pdfNumber(item.value)}] TJ`;
        throw new RunCompileError('malformed show item');
      }).join(' ');
      chunks.push(ascii.encode(body.replaceAll('] TJ [', ' ')));
      cursor = op.end;
    }
    chunks.push(content.subarray(cursor));
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { ok: true, bytes, ...(overflow ? { overflow } : {}) };
  } catch (error) {
    if(error instanceof ContentStreamParseError)return refuse(error.message);
    if(!(error instanceof RunCompileError))throw error;
    const detail=error as RunCompileError&Partial<Refusal>;
    return {...refuse(error.message,error.code),...(detail.firstMissing!==undefined?{firstMissing:detail.firstMissing,offset:detail.offset}:{})};
  }
}
