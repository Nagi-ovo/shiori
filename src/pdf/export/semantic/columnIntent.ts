import type { ContentTextOverlay } from '../../model/types';
import type { ColumnCellEdit } from '../contentText/uprightColumnEvidence';
import { compactText, glyphLabel, type SemanticIntent } from './editIntent';
import type { SemanticBinding, SemanticGlyph, SemanticPage, SemanticSpan } from './types';

type Origin = { x: number; y: number };

const projectedText = (text: string) => compactText(text.normalize('NFKC'));
const near = (g: SemanticGlyph, x: number, y: number) => {
  const point = g.placement.coreQuad[0];
  return Math.hypot(point.x - x, point.y - y) <= .02;
};

export function columnIntent(
  page: SemanticPage, overlay: ContentTextOverlay, cells: readonly ColumnCellEdit[], origin: Origin,
): SemanticIntent | undefined {
  const glyphs = page.occurrences[0]!.glyphs;
  const addressed = new Map<SemanticGlyph, ColumnCellEdit>();
  for (const cell of cells) {
    const p = cell.source, pos = p.coreQuad[0];
    const matches = glyphs.filter(g => p.fontName === g.placement.fontName && p.code === g.placement.code &&
      near(g, pos.x - origin.x, pos.y - origin.y));
    if (matches.length !== 1 || addressed.has(matches[0]!)) return;
    addressed.set(matches[0]!, cell);
  }
  const owned = [...addressed].filter(([, cell]) => cell.selected);
  const original = owned.map(([glyph]) => glyphLabel(glyph));
  if (original.some(text => text === undefined) ||
      projectedText(original.join('')) !== projectedText(overlay.originalText) ||
      projectedText(owned.map(([, cell]) => cell.text).join('')) !== projectedText(overlay.text)) return;

  const spans = new Set(owned.flatMap(([glyph]) => glyph.spans));
  const protectedSpans = new Set([...spans].filter(s => s.issues.length || page.dependencies.some(b => b.spans.includes(s))));
  const bindings = page.dependencies.filter(b => b.spans.some(s => protectedSpans.has(s)));
  const replacements = bindings.filter(b => b.replacementKey);
  const intent: SemanticIntent = {
    overlay, glyphs: new Set(owned.map(([glyph]) => glyph)), spans: protectedSpans, bindings, replacements,
    column: { addressed, origin },
  };
  for (const [glyph, cell] of addressed) {
    if (glyph.spans.some(s => s.issues.length)) intent.refusal = 'semantic-unresolved';
    if (!cell.selected && projectedText(glyphLabel(glyph) ?? '') !== projectedText(cell.text)) return;
  }
  const changed = owned.filter(([g, cell]) => projectedText(glyphLabel(g) ?? '') !== projectedText(cell.text));
  if (!intent.refusal && changed.some(([g]) => [...protectedSpans].some(span =>
    span.mcid !== undefined && changed.some(([peer]) => g.spans.includes(span) !== peer.spans.includes(span))))) {
    intent.refusal = 'semantic-partial-span';
  }
  return intent;
}

export function columnOutput(after: SemanticPage, intent: SemanticIntent) {
  const { addressed, origin } = intent.column!;
  const targets = new Map<SemanticGlyph, SemanticGlyph[]>();
  const generated = new Set<SemanticSpan>();
  const occupied = new Set<SemanticGlyph>();
  for (const [source, cell] of addressed) {
    const dest: SemanticGlyph[] = [];
    for (const output of cell.output) {
      const matches = after.occurrences[0]!.glyphs.filter(g => g.placement.fontName === output.font &&
        g.placement.code === output.code && near(g, output.x - origin.x, output.y - origin.y));
      if (matches.length !== 1 || occupied.has(matches[0]!)) return;
      const g = matches[0]!;
      if (output.wrapper) {
        const scope = g.spans.at(-1);
        if (!scope || scope.tag !== 'Span' || scope.mcid !== undefined || scope.glyphs.length !== 1 ||
            scope.paints.length || scope.issues.length || scope.replacement.length !== 1 ||
            scope.replacement[0]?.key !== 'ActualText' || scope.replacement[0].text !== output.text || scope.endOp !== scope.beginOp + 4 ||
            scope.occurrence.ops.slice(scope.beginOp + 1, scope.endOp).map(op => op.operator).join(' ') !== 'Tm Tf Tj') return;
        generated.add(scope);
      }
      dest.push(g);
      occupied.add(g);
    }
    targets.set(source, dest);
  }
  return { targets, generated };
}

export function columnReplacement(binding: SemanticBinding, intent: SemanticIntent): string | undefined {
  if (binding.replacementKey !== 'ActualText' || binding.dependency.source !== 'inline' ||
      binding.spans.length !== 1 || binding.objects.length) return;
  const span = binding.spans[0]!;
  if (span.glyphs.length !== 1 || span.issues.length || span.paints.length) return;
  return intent.column?.addressed.get(span.glyphs[0]!)?.text;
}
