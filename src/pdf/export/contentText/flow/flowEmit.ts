// Content-stream text for a flow rewrite. Every block is self-contained
// (q … Q around BT … ET) and states its source font, Tc, Tw, Tz, zero rise,
// render mode and fill colour, so it leaves no state behind for later ops.
import {hex,pdfName,pdfNumber} from '../../contentStreamEdit/runEncoding';
import type {ContentOperand} from '../../contentStreamEdit/tokenizer';
import type {FlowSource,OwnedShow} from './flowSource';

export type StoryLine = { codes: Uint8Array; x: number; baseline: number };
export type SpliceEdit = { at: number; end: number; text: string };

export const operandText = (v: ContentOperand): string => v.kind === 'number' ? pdfNumber(v.value) : v.kind === 'string' ? hex(v.bytes)
  : v.kind === 'name' ? pdfName(v.value) : v.kind === 'array' ? `[${v.items.map(operandText).join(' ')}]` : '';
const fillOps = (o: OwnedShow) => `${o.fill.colorSpace ?? ''} ${o.fill.color ?? (o.fill.colorSpace ? '' : '0 g')}`.trim();
const textState = (o: OwnedShow) => { const s = o.state;
  return `${pdfName(s.fontName)} ${pdfNumber(s.fontSize)} Tf ${pdfNumber(s.charSpacing)} Tc ${pdfNumber(s.wordSpacing)} Tw ${pdfNumber((s.horizontalScale ?? 1) * 100)} Tz 0 Ts 0 Tr`; };

/** Story lines in the first frame's source style; positions are user space. */
export function storyBlock(style: OwnedShow, lines: readonly StoryLine[]) {
  const tm = style.state.textMatrix!, ctm = style.state.ctm!;
  const shown = lines.map(l => `${pdfNumber(tm[0]!)} 0 0 ${pdfNumber(tm[3]!)} ${pdfNumber((l.x - ctm[4]!) / ctm[0]!)} ${pdfNumber((l.baseline - ctm[5]!) / ctm[3]!)} Tm ${hex(l.codes)} Tj`);
  return `q ${fillOps(style)} BT ${textState(style)} ${shown.join(' ')} ET Q\n`;
}

/** A source show moved down by `dy` user-space points, with its own state and operands. */
export function movedShow(source: FlowSource, o: OwnedShow, dy: number) {
  const s = o.state, tm = s.textMatrix!, op = source.ops[o.opIndex]!;
  const str = op.operands[op.operands.length - 1]!;
  const shown = op.operator === 'TJ' && str.kind === 'array' ? `[${str.items.slice(Math.max(0, s.arrayItemIndex)).map(operandText).join(' ')}] TJ` : `${operandText(str)} Tj`;
  return `q ${fillOps(o)} BT ${textState(o)} ${tm.slice(0, 5).map(pdfNumber).join(' ')} ${pdfNumber(tm[5]! - dy / s.ctm![3]!)} Tm ${shown} ET Q\n`;
}

/** Removes an owned show; a line-moving show keeps its line move. */
export function removal(source: FlowSource, o: OwnedShow): SpliceEdit {
  const op = source.ops[o.opIndex]!;
  const keep = op.operator === "'" ? 'T*' : op.operator === '"' ? `${operandText(op.operands[0]!)} Tw ${operandText(op.operands[1]!)} Tc T*` : '';
  return { at: op.start, end: op.end, text: keep };
}

/** Op index of the BT holding `opIndex`: blocks go before it, in the state its text object starts from. */
export function slotOp(source: FlowSource, opIndex: number) {
  for (let i = opIndex; i >= 0; i--) if (source.ops[i]!.operator === 'BT') return i;
  return opIndex;
}

export function splice(bytes: Uint8Array, edits: SpliceEdit[]): Uint8Array {
  const text = new TextDecoder('latin1').decode(bytes);
  const sorted = [...edits].sort((a, b) => a.at - b.at || (a.end - a.at) - (b.end - b.at));
  let out = '', cursor = 0;
  for (const e of sorted) { out += text.slice(cursor, e.at) + e.text; cursor = e.end; }
  out += text.slice(cursor);
  return Uint8Array.from(out, c => c.charCodeAt(0));
}
