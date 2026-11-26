import type { ContentOp } from '../contentStreamEdit/tokenizer';
import type { SemanticIntent } from './editIntent';
import { glyphLabel, inReadingOrder } from './editIntent';
import type { SemanticPage, SemanticSpan } from './types';

export type SpanPermutation = { source: SemanticSpan[]; order: SemanticSpan[] };
export type SpanMove = { span: SemanticSpan; operators: string[]; dx: number; dy: number };
export type InstalledPermutation = { source: SpanPermutation['source']; output: SpanMove[] };

function commonEdges(a: string, b: string) {
  const old = Array.from(a), next = Array.from(b);
  let first = 0, tail = 0;
  while (first < old.length && old[first] === next[first]) first++;
  while (tail < old.length - first && tail < next.length - first &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  return {
    start: old.slice(0, first).join('').length,
    end: old.slice(0, old.length - tail).join('').length,
    replacement: next.slice(first, next.length - tail).join(''),
  };
}

const isolatedText = /^q (?:cm )?(?:re W\*? n )?(?:(?:g|rg|k|cs|sc|scn) )*BT (?:(?:Tr|Tf|Tm|Tc|Tw|Tz|Ts|TL|g|G|rg|RG|k|K) )*(?:Tj|TJ) ET Q$/u;

function isolated(span: SemanticSpan) {
  const { occurrence, beginOp, endOp } = span;
  if (endOp === undefined || !span.glyphs.length || span.issues.length || span.paints.length ||
      span.mcid === undefined || span.ancestors.length || span.replacement.length ||
      span.glyphs.some(g => g.occurrence !== occurrence || g.spans.length !== 1)) return false;
  const [tag, props] = occurrence.ops[beginOp]!.operands;
  if (tag?.kind !== 'name' || tag.value === 'Artifact' || tag.value === 'OC' ||
      props?.kind !== 'dict' || props.entries.some(entry => !['MCID', 'Lang'].includes(entry.key))) return false;
  const inside = occurrence.ops.slice(beginOp + 1, endOp);
  return isolatedText.test(inside.map(op => op.operator).join(' ')) &&
    inside.filter(op => op.operator === 'Tm').length === 1 &&
    inside.filter(op => op.operator === 'Tf').length === 1;
}

/** A permutation is only recognizable when the changed interval tiles
 * complete, consecutive siblings and their exact labels tile the requested
 * interval uniquely. The structure tree fixes order on tagged pages. */
export function planSpanPermutation(page: SemanticPage, intent: SemanticIntent): SpanPermutation | undefined {
  if (page.tagged || page.hasStructureRoot || intent.refusal !== 'semantic-partial-span') return;
  const { overlay, glyphs } = intent;
  const root = page.occurrences[0]!;
  if (root.parts.length !== 1) return;
  const style = overlay.sourceStyle;
  if (!style || overlay.angle || overlay.align !== 'left' || (['fontSize', 'color', 'bold', 'italic', 'align', 'fontFamily', 'backgroundColor'] as const)
    .some(key => overlay[key] !== style[key])) return;
  const original = overlay.originalText.replace(/\r\n?/gu, '\n');
  const next = overlay.text.replace(/\r\n?/gu, '\n');
  const { start, end, replacement } = commonEdges(original, next);
  if (start === end || !replacement || /[\r\n]/u.test(original.slice(start, end) + replacement)) return;

  const selected = inReadingOrder(glyphs);
  const labels = selected.map(glyphLabel);
  if (labels.some(label => !label) || labels.join('') !== original.replace(/\n/gu, '')) return;
  const offset = original.slice(0, start).replace(/\n/gu, '').length;
  let cursor = 0;
  const picked = selected.filter((_, index) => {
    const previous = cursor;
    cursor += labels[index]!.length;
    return cursor > offset && previous < offset + end - start;
  });
  if (picked.map(glyphLabel).join('') !== original.slice(start, end)) return;
  const source = [...new Set(picked.flatMap(g => g.spans))];
  if (source.length < 2 || source.some((span, index) => span.occurrence !== root || !isolated(span) ||
      (index > 0 && source[index - 1]!.endOp! + 1 !== span.beginOp))) return;
  const members = source.flatMap(span => inReadingOrder(span.glyphs));
  if (members.length !== picked.length || members.some((glyph, i) => glyph !== picked[i])) return;

  const remaining = new Map(source.map(span => [span, inReadingOrder(span.glyphs).map(glyphLabel).join('')]));
  const order: SemanticSpan[] = [];
  let pending = replacement;
  while (remaining.size) {
    const matches = [...remaining].filter(([, text]) => pending.startsWith(text));
    if (matches.length !== 1) return;
    const [span, text] = matches[0]!;
    order.push(span);
    remaining.delete(span);
    pending = pending.slice(text.length);
  }
  if (pending.length) return;
  return { source, order };
}

export function permutationIntent(page: SemanticPage, intent: SemanticIntent, permutation: InstalledPermutation): SemanticIntent {
  const spans = new Set(permutation.source);
  return { ...intent, spans, glyphs: new Set(permutation.source.flatMap(span => span.glyphs)),
    bindings: page.dependencies.filter(binding => binding.spans.some(span => spans.has(span))),
    replacements: [], edits: undefined, refusal: undefined, permutation };
}

/** Validate the installed bytes of each item and the original glyph
 * identities, then validate its new geometry. The normal gate also
 * checks the owning stream, dependencies, and untouched spans. */
export function verifySpanMove(move: SpanMove, target: SemanticSpan) {
  const { span, operators, dx, dy } = move;
  const occurrence = target.occurrence;
  if (target.endOp === undefined ||
      JSON.stringify(occurrence.ops.slice(target.beginOp, target.endOp + 1).map(op => operatorBytes(occurrence.bytes!, op))) !==
        JSON.stringify(operators)) return false;
  const from = inReadingOrder(span.glyphs), to = inReadingOrder(target.glyphs);
  return from.length === to.length && from.every((glyph, index) => {
    const a = glyph.placement, b = to[index]!.placement;
    return a.fontName === b.fontName && a.code === b.code && a.byteLength === b.byteLength &&
      glyphLabel(glyph) === glyphLabel(to[index]!) && a.coreQuad.every((point, i) =>
        Math.abs(point.x + dx - b.coreQuad[i]!.x) < .001 && Math.abs(point.y + dy - b.coreQuad[i]!.y) < .001);
  });
}

export function operatorBytes(bytes: Uint8Array, op: ContentOp) {
  // Latin-1 is a byte-to-code-unit mapping here, including C1 controls.
  return Array.from(bytes.subarray(op.start, op.end), value => String.fromCharCode(value)).join('');
}
