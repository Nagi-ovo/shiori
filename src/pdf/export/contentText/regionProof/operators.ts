import type { ContentOperand } from '../../contentStreamEdit/tokenizer';
import { matrixEqual, near, origin } from './geometry';
import type { ParagraphBlocker, ParagraphInput, ParagraphShow, TextTrace, TjBoundary } from './types';

type Failure = { blocker: ParagraphBlocker; detail: string };
export type OperatorProof = { boundaries: TjBoundary[]; endpoints: number[] } | Failure;
const fail = (blocker: ParagraphBlocker, detail: string): Failure => ({ blocker, detail });
const numbers = (items: ContentOperand[], count: number): number[] | null =>
  items.length === count && items.every(i => i.kind === 'number' && Number.isFinite(i.value))
    ? items.map(i => (i as { value: number }).value) : null;
const key = (op: number, item: number) => `${op}:${item}`;

/** Check complete string-item ownership and the actual positioning/show grammar.
 * Full trace/scene production stays at the caller's R1/R2 boundary.
 */
export function proveOperators(input: ParagraphInput): OperatorProof {
  const { ops, lines } = input;
  const first = lines[0]!.anchor.opIndex;
  const lastLine = lines.at(-1)!;
  const last = lastLine.shows.at(-1)?.source.opIndex ?? lastLine.anchor.opIndex;
  const anchors = new Map(lines.map(l => [l.anchor.opIndex, l]));
  const shows = new Map<string, ParagraphShow>();
  let previous = -1;
  for (const line of lines) {
    if (!Number.isInteger(line.anchor.opIndex) || line.anchor.opIndex <= previous) {
      return fail('ownership', 'Line anchors are not consecutive in source order');
    }
    previous = line.anchor.opIndex;
    let previousItem = -2;
    for (const show of line.shows) {
      const s = show.source;
      if (s.streamHash !== input.sourceHash || s.fontObject !== show.before.fontObject ||
        ![s.opIndex, s.itemIndex, s.byteStart, s.byteEnd].every(Number.isInteger) ||
        s.byteStart !== 0 || s.byteEnd <= 0 || s.opIndex <= line.anchor.opIndex ||
        s.opIndex < previous || (s.opIndex === previous && s.itemIndex <= previousItem)) {
        return fail('ownership', 'Source addresses must own whole items in monotonic source order');
      }
      previousItem = s.itemIndex; previous = s.opIndex;
      if (shows.has(key(s.opIndex, s.itemIndex))) return fail('ownership', 'Duplicate show ownership');
      shows.set(key(s.opIndex, s.itemIndex), show);
    }
  }
  if (first < 0 || last >= ops.length || first > last) return fail('ownership', 'Invalid operator span');
  // bt is the BT operator's source index, not a DOM/grouping identifier.
  let bt = -1;
  for (let i = 0; i <= last; i++) {
    if (ops[i]!.operator === 'BT') {
      if (bt !== -1) return fail('operators', 'Nested BT is unsupported');
      bt = i;
    } else if (ops[i]!.operator === 'ET') bt = -1;
    if (i >= first && bt !== lines[0]!.anchor.bt) return fail('state', 'Candidate crosses BT ownership');
  }
  const boundaries: TjBoundary[] = [];
  let visited = 0;
  let cursor: TextTrace = lines[0]!.anchor;
  let anchored = false;
  const endpoints: number[] = [];
  for (let i = first; i <= last; i++) {
    const op = ops[i]!;
    if (['Tm', 'Td', 'TD', 'T*'].includes(op.operator)) {
      const line = anchors.get(i);
      if (!line) return fail('operators', 'Unowned position anchor interleaves the paragraph');
      const t = line.anchor;
      if (op.operator === 'Tm') {
        const n = numbers(op.operands, 6);
        if (!n || !matrixEqual(n, t.tm) || !matrixEqual(t.tm, t.tlm)) {
          return fail('operators', 'Tm operands and full anchor snapshot disagree');
        }
      } else {
        const prev = lines[lines.indexOf(line) - 1];
        // A relative first anchor needs a pre-candidate Tlm proof, not supplied
        // by this bounded seam. Later relative anchors are checked exactly.
        if (!prev) return fail('operators', 'First anchor requires an absolute Tm snapshot');
        const n = numbers(op.operands, op.operator === 'T*' ? 0 : 2);
        if (!n) return fail('operators', 'Malformed relative anchor');
        const dx = n[0] ?? 0, dy = op.operator === 'T*' ? -t.leading : n[1]!;
        const m = prev.anchor.tlm;
        const expected = [m[0]!, m[1]!, m[2]!, m[3]!,
          m[4]! + dx * m[0]! + dy * m[2]!, m[5]! + dx * m[1]! + dy * m[3]!];
        if (!matrixEqual(t.tm, expected) || !matrixEqual(t.tlm, expected) ||
          (op.operator === 'TD' && !near(t.leading, -dy, 1e-9))) {
          return fail('operators', 'Relative anchor disagrees with saved Tlm');
        }
      }
      if (anchored) endpoints.push(origin(cursor)[0]);
      cursor = t; anchored = true;
      continue;
    }
    let items: ContentOperand[];
    if (op.operator === 'Tj' && op.operands.length === 1 && op.operands[0]!.kind === 'string') {
      items = op.operands;
    } else if (op.operator === 'TJ' && op.operands.length === 1 && op.operands[0]!.kind === 'array') {
      items = op.operands[0]!.items;
    } else return fail('operators', `Unsupported interleaved operator ${op.operator}`);
    for (let j = 0; j < items.length; j++) {
      const item = items[j]!;
      if (item.kind === 'number' && op.operator === 'TJ' && Number.isFinite(item.value)) {
        const delta: number = -item.value / 1000 * cursor.size * cursor.tz / 100;
        const m: readonly number[] = cursor.tm;
        cursor = { ...cursor, tm: [m[0]!, m[1]!, m[2]!, m[3]!,
          m[4]! + delta * m[0]!, m[5]! + delta * m[1]!] };
        const neighbours = [...shows.values()].filter(s => s.source.opIndex === i);
        const left = neighbours.filter(s => s.source.itemIndex < j).at(-1)?.source ?? null;
        const right = neighbours.find(s => s.source.itemIndex > j)?.source ?? null;
        boundaries.push({ opIndex: i, itemIndex: j, value: item.value,
          left: left ? { ...left } : null, right: right ? { ...right } : null });
      } else if (item.kind === 'string') {
        const show = shows.get(key(i, op.operator === 'Tj' ? -1 : j));
        if (!item.bytes.length && !show) continue; // explicit empty show
        if (!show || show.source.byteEnd !== item.bytes.length ||
          show.before.opIndex !== i || show.after.opIndex !== i) {
          return fail('ownership', 'Unknown show or incomplete source string ownership');
        }
        const expected = origin(cursor), actual = origin(show.before);
        if (!near(actual[0], expected[0], 0.01) || !near(actual[1], expected[1], 0.01)) {
          return fail('state', 'Source show origin disagrees with encoded TJ displacement');
        }
        cursor = show.after;
        visited++;
      } else return fail('operators', 'Unknown or nonfinite TJ item');
    }
  }
  endpoints.push(origin(cursor)[0]);
  return visited === shows.size ? { boundaries, endpoints } : fail('ownership', 'Owned show is outside the candidate');
}
