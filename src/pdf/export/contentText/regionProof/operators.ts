import type { ContentOperand } from '../../contentStreamEdit/tokenizer';
import { anchorForShow, lineAnchors, matrixEqual, near, origin } from './geometry';
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
export function proveOperators(input: ParagraphInput, beforeFirst?:TextTrace): OperatorProof {
  const { ops, lines } = input;
  const first = lines[0]!.anchor.opIndex;
  const lastLine = lines.at(-1)!;
  const last = lastLine.shows.at(-1)?.source.opIndex ?? lastLine.anchor.opIndex;
  const anchors = new Map(lines.flatMap(l => lineAnchors(l).map(t => [t.opIndex, {line:l, trace:t}] as const)));
  const shows = new Map<string, ParagraphShow>();
  let previous = -1;
  for (const line of lines) {
    if (!Number.isInteger(line.anchor.opIndex) || line.anchor.opIndex <= previous) {
      return fail('ownership', 'Line anchors are not consecutive in source order');
    }
    previous = line.anchor.opIndex;
    const positions=lineAnchors(line);
    if(positions.some((t,i)=>!Number.isInteger(t.opIndex)||i>0&&t.opIndex<=positions[i-1]!.opIndex||
      t.opIndex>=(line.shows.at(-1)?.source.opIndex??Infinity)))return fail('ownership','Invalid same-line anchor order');
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
  // Validate real source scopes, including wrappers that open before the
  // candidate. q/Q never saves Tm/Tlm. Fill state must agree at every owned
  // show: a Q must not silently restore a different painting colour.
  let bt = -1, graphics = 0, marked = 0, fill = {space:'DeviceGray',value:'default'};
  const fills:typeof fill[] = [], owners = new Map<number,number>();
  const fillAt = new Map<number,string>();
  for (let i = 0; i < ops.length; i++) {
    const op=ops[i]!;
    if (op.operator === 'BT') {
      if (bt !== -1 || op.operands.length) return fail('operators', 'Nested or malformed BT');
      bt=i;
    } else if (op.operator === 'ET') {
      if (bt === -1 || op.operands.length) return fail('operators', 'Unbalanced ET');
      bt=-1;
    } else if(op.operator==='q') {
      if(op.operands.length)return fail('operators','Malformed q');
      graphics++; fills.push(fill);
    }
    else if(op.operator==='Q') {
      if(op.operands.length||--graphics<0)return fail('operators','Unbalanced graphics state');
      fill=fills.pop()!;
    } else if(['g','rg','k','cs'].includes(op.operator)) fill={space:op.operator==='cs'?JSON.stringify(op.operands):op.operator,value:JSON.stringify(op.operands)};
    else if(['sc','scn'].includes(op.operator))fill={...fill,value:JSON.stringify(op.operands)};
    else if(op.operator==='BMC'||op.operator==='BDC') marked++;
    else if(op.operator==='EMC'&&--marked<0)return fail('operators','Unbalanced marked content');
    owners.set(i,bt);fillAt.set(i,JSON.stringify(fill));
  }
  if(bt!==-1||graphics||marked)return fail('operators','Unterminated source scope');
  const baseFill=fillAt.get(lines[0]!.shows[0]?.source.opIndex??first);
  for(const line of lines){
    if(lineAnchors(line).some(t=>owners.get(t.opIndex)!==t.bt))return fail('state','Anchor BT snapshot differs from source');
    for(const show of line.shows)if(owners.get(show.source.opIndex)!==show.before.bt||show.after.bt!==show.before.bt||
      show.before.bt!==anchorForShow(line,show.source.opIndex)?.bt)
      return fail('state','Show BT differs from source paragraph');
    if(line.shows.some(show=>fillAt.get(show.source.opIndex)!==baseFill))return fail('operators','Paragraph fill state differs across graphics scopes');
  }
  const boundaries: TjBoundary[] = [];
  let visited = 0;
  let cursor: TextTrace = lines[0]!.anchor;
  let anchored = false, endpoint = origin(cursor)[0];
  const parameters:TextTrace[]=[];
  const endpoints: number[] = [];
  let currentLine=lines[0];
  for (let i = first; i <= last; i++) {
    const op = ops[i]!;
    if (['Tm', 'Td', 'TD', 'T*'].includes(op.operator)) {
      const entry = anchors.get(i);
      if (!entry) return fail('operators', 'Unowned position anchor interleaves the paragraph');
      const {line,trace:t} = entry;
      if (op.operator === 'Tm') {
        const n = numbers(op.operands, 6);
        if (!n || !matrixEqual(n, t.tm) || !matrixEqual(t.tm, t.tlm)) {
          return fail('operators', 'Tm operands and full anchor snapshot disagree');
        }
      } else {
        // A relative first anchor needs a pre-candidate Tlm proof, not supplied
        // by this bounded seam. Later relative anchors are checked exactly.
        if (i===first && (!beforeFirst || beforeFirst.bt!==t.bt || beforeFirst.opIndex!==i-1)) return fail('operators', 'First anchor requires an absolute Tm snapshot');
        const n = numbers(op.operands, op.operator === 'T*' ? 0 : 2);
        if (!n) return fail('operators', 'Malformed relative anchor');
        const dx = n[0] ?? 0, dy = op.operator === 'T*' ? -t.leading : n[1]!;
        const m = i===first ? beforeFirst!.tlm : cursor.tlm;
        const expected = [m[0]!, m[1]!, m[2]!, m[3]!,
          m[4]! + dx * m[0]! + dy * m[2]!, m[5]! + dx * m[1]! + dy * m[3]!];
        if (!matrixEqual(t.tm, expected) || !matrixEqual(t.tlm, expected) ||
          (op.operator === 'TD' && !near(t.leading, -dy, 1e-9))) {
          return fail('operators', 'Relative anchor disagrees with saved Tlm');
        }
      }
      if (anchored&&line!==currentLine) endpoints.push(endpoint);
      currentLine=line;
      cursor = t; anchored = true; endpoint=origin(t)[0];
      continue;
    }
    if(['BT','ET','q','Q','BMC','BDC','EMC','Tf','Tc','Tw','Tz','TL','Ts','Tr'].includes(op.operator)){
      if(op.operator==='BT')cursor={...cursor,bt:i,tm:[1,0,0,1,0,0],tlm:[1,0,0,1,0,0]};
      else if(op.operator==='ET')cursor={...cursor,bt:-1};
      else if(op.operator==='q')parameters.push(cursor);
      else if(op.operator==='Q'){
        const saved=parameters.pop();if(saved)cursor={...saved,bt:cursor.bt,tm:cursor.tm,tlm:cursor.tlm};
      }else if(op.operator==='Tf'){
        if(op.operands.length!==2||op.operands[0]?.kind!=='name'||op.operands[1]?.kind!=='number'||
          !Number.isFinite(op.operands[1].value)||op.operands[1].value<=0)return fail('operators','Malformed Tf');
        cursor={...cursor,size:op.operands[1].value};
      }else if(['Tc','Tw','Tz','TL','Ts','Tr'].includes(op.operator)){
        const n=numbers(op.operands,1);if(!n||op.operator==='Tr'&&n[0]!==0)return fail('operators','Unsupported text state');
        const field={Tc:'tc',Tw:'tw',Tz:'tz',TL:'leading',Ts:'rise',Tr:'renderMode'}[op.operator]!;
        cursor={...cursor,[field]:n[0]};
      }else if(op.operator==='BDC'||op.operator==='BMC'){
        if(op.operands[0]?.kind!=='name'||op.operands[0].value==='OC'||op.operands.length!==(op.operator==='BDC'?2:1))
          return fail('operators','Unsupported marked content');
        const properties=op.operands[1];
        if(properties?.kind==='dict'&&properties.entries.some(e=>['ActualText','Alt','E','OC'].includes(e.key)))
          return fail('semantics','Unresolved marked content semantics');
      }else if(op.operands.length)return fail('operators','Malformed scope operator');
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
      endpoint=origin(cursor)[0];
    }
  }
  endpoints.push(endpoint);
  return visited === shows.size ? { boundaries, endpoints } : fail('ownership', 'Owned show is outside the candidate');
}
