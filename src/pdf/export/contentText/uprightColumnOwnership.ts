import type { ContentOp } from '../contentStreamEdit/tokenizer';
import { lineChanges } from './diff';
import type { RetypesetGlyph } from './retypesetTypes';
import type { RunEnvironment } from '../contentStreamEdit/textSafety';
import type { retypesetScopes } from './retypesetScopes';
import type { ColumnAtom } from './uprightColumnEmit';

const textAndMarks = new Set(['BT', 'ET', 'Tf', 'Tm', 'Td', 'TD', 'T*', 'Tj', 'TJ', "'", '"', 'Tc', 'Tw',
  'TL', 'Tr', 'Ts', 'Tz', 'BMC', 'BDC', 'EMC', 'q', 'Q', 'cm', 'g', 'rg', 'k', 'cs', 'sc', 'scn']);
const semanticKeys = new Set(['MCID', 'ActualText', 'Alt', 'E']);

function fillState(ops: ContentOp[]) {
  let state = { space: 'DeviceGray', color: '0', known: true };
  const stack: typeof state[] = [];
  return ops.map(op => {
    const before = state;
    if (op.operator === 'q') stack.push(state);
    else if (op.operator === 'Q') state = stack.pop() ?? { ...state, known: false };
    else if (op.operator === 'cs') {
      const space = op.operands[0];
      state = space?.kind === 'name' ? { space: space.value, color: '', known: space.value !== 'Pattern' } :
        { ...state, known: false };
    } else if (['g', 'rg', 'k', 'sc', 'scn'].includes(op.operator)) {
      const implicit = { g: 'DeviceGray', rg: 'DeviceRGB', k: 'DeviceCMYK' } as Record<string, string>;
      state = { space: implicit[op.operator] ?? state.space, color: JSON.stringify(op.operands),
        known: (!!implicit[op.operator] || state.known) && op.operands.every(operand => operand.kind === 'number') };
    }
    return before;
  });
}

function offsets(parts: string[]) {
  let offset = 0;
  return [0, ...parts.map(part => offset += part.length)];
}

function semanticMark(op: ContentOp, env: RunEnvironment) {
  const [tag, props] = op.operands;
  if (op.operator !== 'BDC' || tag?.kind !== 'name' || tag.value === 'OC' || tag.value === 'Artifact') return false;
  if (props?.kind === 'name') return env.markedContentProperties?.get(props.value)?.every(key => semanticKeys.has(key));
  return props?.kind === 'dict' && props.entries.length > 0 &&
    props.entries.every(entry => semanticKeys.has(entry.key));
}

/** Cell layout determines geometry. When several MCIDs share a column,
 * tie an unchanged character to its original show even if a nearby edit
 * shifts its destination cell. Only text and semantic scopes may occur
 * between the two shows, and their inherited paint state must agree. */
export function retainColumnOwners(
  owned: RetypesetGlyph[], rows: ColumnAtom[][], atoms: ColumnAtom[], ops: ContentOp[],
  env: RunEnvironment, clips: ReturnType<typeof retypesetScopes>,
): ColumnAtom[] {
  const marks = (glyph: RetypesetGlyph) => glyph.glyph.markedContent;
  const mcidStack = (glyph: RetypesetGlyph) => marks(glyph).filter(i => {
    const props = ops[i]!.operands[1];
    return props?.kind === 'name' ? env.markedContentMcids?.has(props.value) :
      props?.kind === 'dict' && props.entries.some(entry => entry.key === 'MCID');
  }).join(',');
  const scopes = owned.map(mcidStack);
  if (new Set(scopes).size <= 1) return atoms;
  const old = owned.map(glyph => glyph.text!.normalize('NFKC'));
  const next = rows.map(row => row.map(atom => atom.text).join('').normalize('NFKC'));
  const oldStarts = offsets(old), nextStarts = offsets(next);
  const homes: RetypesetGlyph[] = [];
  let i = 0, j = 0, delta = 0;
  const unchanged = (end: number) => {
    while (i < end) {
      if (old[i] !== next[j]) return false;
      homes.push(owned[i++]!);
      j += 1;
    }
    return true;
  };
  for (const change of lineChanges(old.join(''), next.join(''))) {
    const from = oldStarts.indexOf(change.start), to = oldStarts.indexOf(change.end);
    const start = nextStarts.indexOf(change.start + delta);
    const end = nextStarts.indexOf(change.start + delta + change.replacement.length);
    if (from < 0 || to < 0 || start < 0 || end < 0 || !unchanged(from) || j !== start ||
        new Set(scopes.slice(from, to)).size > 1) return atoms;
    for (; j < end; j += 1) {
      const index = to > from ? Math.min(from + j - start, to - 1) : Math.max(0, from - 1);
      homes.push(owned[index]!);
    }
    i = to;
    delta += change.replacement.length - change.end + change.start;
  }
  if (!unchanged(owned.length) || homes.length !== rows.length) return atoms;
  if (homes.some((home, index) => index && home.glyph.opIndex < homes[index - 1]!.glyph.opIndex)) return atoms;

  const fill = fillState(ops);
  const equivalent = (a: RetypesetGlyph, b: RetypesetGlyph) => {
    if (a.glyph.opIndex === b.glyph.opIndex) return true;
    const low = Math.min(a.glyph.opIndex, b.glyph.opIndex), high = Math.max(a.glyph.opIndex, b.glyph.opIndex);
    if (ops.slice(low, high).some(op => !textAndMarks.has(op.operator))) return false;
    const ac = clips.get(a.glyph.opIndex)?.clip, bc = clips.get(b.glyph.opIndex)?.clip;
    const af = fill[a.glyph.opIndex]!, bf = fill[b.glyph.opIndex]!;
    if (ac === null || bc === null || JSON.stringify(ac) !== JSON.stringify(bc) || !af.known || !bf.known ||
        af.space !== bf.space || af.color !== bf.color || a.state.renderMode !== 0) return false;
    const unchangedMarks = (glyph: RetypesetGlyph) => marks(glyph).filter(i => !semanticMark(ops[i]!, env)).join(',');
    return unchangedMarks(a) === unchangedMarks(b) && a.state.ctm!.slice(0, 4).every((value, index) => value === b.state.ctm![index]) &&
      (['charSpacing', 'wordSpacing', 'horizontalScale', 'rise', 'renderMode'] as const).every(key => a.state[key] === b.state[key]);
  };

  let index = 0;
  const moved = rows.flatMap((row, rowIndex) => row.map(() => {
    const atom = atoms[index++]!;
    return { ...atom, anchor: homes[rowIndex]! };
  }));
  if (moved.some(atom => !equivalent(atom.anchor, atom.home))) return atoms;
  return [...moved, ...atoms.slice(index)];
}
