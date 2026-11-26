import type { ColumnCellEdit } from '../contentText/uprightColumnEvidence';
import type { PDFDict } from 'pdf-lib';
import type { ContentTextOverlay, PdfRect } from '../../model/types';
import type { ContentOp } from '../contentStreamEdit/tokenizer';
import type { GlyphPlacement } from '../contentStreamEdit/textState';
import { removalsByRect } from '../contentStreamEdit/removeGlyphs';
import { recoverRunUnicode } from '../contentStreamEdit/runFontUnicode';
import { fontInputFromDict } from '../fontCoverage/pdfLibAdapter';
import type { SemanticChange, SemanticDependency, SemanticRefusalReason } from '../semanticGate';
import { asDict, value } from './pdfValues';
import type { InstalledPermutation } from './spanPermutation';
import { projectSelection, type GlyphEdit } from './selectionEdits';
import type { SemanticBinding, SemanticGlyph, SemanticOccurrence, SemanticPage, SemanticSpan } from './types';

export type SemanticIntent = {
  overlay: ContentTextOverlay;
  glyphs: Set<SemanticGlyph>;
  spans: Set<SemanticSpan>;
  bindings: SemanticBinding[];
  replacements: SemanticBinding[];
  edits?: GlyphEdit[];
  permutation?: InstalledPermutation;
  column?: { addressed: Map<SemanticGlyph, ColumnCellEdit>; origin: { x: number; y: number } };
  refusal?: SemanticRefusalReason;
};

export type FlowFootprint = {
  firstGlyphs: readonly GlyphPlacement[];
  ops: readonly ContentOp[];
  origin: { x: number; y: number };
  removed: ReadonlySet<number>;
  slot: number;
};

const labels = new WeakMap<PDFDict, ReadonlyMap<number, string>>();
export const compactText = (text: string) => text.normalize('NFC').replace(/\s+/gu, '');

export function glyphText(glyphs: readonly SemanticGlyph[]): string | undefined {
  let text = '';
  for (const glyph of glyphs) {
    if (glyph.unicode !== undefined) { text += glyph.unicode; continue; }
    const font = glyph.occurrence.resources && asDict(value(glyph.occurrence.resources, 'Font'));
    const dict = font && asDict(value(font, glyph.placement.fontName));
    if (!dict) return;
    let unicode = labels.get(dict);
    if (!unicode) {
      unicode = recoverRunUnicode(fontInputFromDict(dict), glyph.placement.byteLength, null, {}, {}).unicodeByCode;
      labels.set(dict, unicode);
    }
    const label = unicode.get(glyph.placement.code);
    if (label === undefined) return;
    text += label;
  }
  return text;
}

export function glyphLabel(glyph: SemanticGlyph): string | undefined {
  const equivalent = glyph.spans.find(span => span.glyphs.length === 1 && !span.paints.length &&
    span.replacement.some(replacement => replacement.key === 'ActualText'));
  return equivalent?.replacement.find(replacement => replacement.key === 'ActualText')?.text ?? glyphText([glyph]);
}

export function inReadingOrder(glyphs: Iterable<SemanticGlyph>): SemanticGlyph[] {
  const addressed = [...glyphs].map(glyph => ({
    glyph,
    path: [...glyph.occurrence.address.split('/').slice(1).map(Number), glyph.placement.opIndex,
      glyph.placement.arrayItemIndex, glyph.placement.byteOffset],
  }));
  addressed.sort((a, b) => {
    for (let i = 0; i < Math.min(a.path.length, b.path.length); i += 1) {
      if (a.path[i] !== b.path[i]) return a.path[i]! - b.path[i]!;
    }
    return a.path.length - b.path.length;
  });
  return addressed.map(({ glyph }) => glyph);
}

export function spanDependency(page: SemanticPage, span: SemanticSpan): SemanticDependency {
  return {
    kind: 'mcid', source: span.source, pageIndex: page.pageIndex, stream: span.occurrence.stream,
    mcid: span.mcid, bbox: span.bbox,
  };
}

export function dependenciesOf(intent: SemanticIntent, page: SemanticPage): SemanticDependency[] {
  const dependencies = intent.bindings.map(binding => binding.dependency);
  for (const span of intent.spans) {
    if (span.issues.length && !intent.bindings.some(binding => binding.spans.includes(span))) {
      dependencies.push(spanDependency(page, span));
    }
  }
  return dependencies;
}

export function refusedRows(overlayId: string, dependencies: SemanticDependency[], reason: SemanticRefusalReason): SemanticChange[] {
  return [...new Set(dependencies)].map(dependency => ({ overlayId, dependency, action: 'refused', reason }));
}

function readFlowSelection(root: SemanticOccurrence, footprint: FlowFootprint) {
  // A previous flow may have shifted show and slot indices. Flow only
  // removes shows and inserts self-contained text blocks. The ordered
  // BMC/BDC/EMC operators still address the source's exact span instances.
  const stacks = new Map<number, readonly SemanticSpan[]>();
  let stack: readonly SemanticSpan[] = [];
  let mark = 0;
  for (const [i, op] of footprint.ops.entries()) {
    if (i === footprint.slot || footprint.removed.has(i)) stacks.set(i, stack);
    if (op.operator === 'BMC' || op.operator === 'BDC') {
      const span = root.spans[mark++];
      if (span) stack = [...stack, span];
    } else if (op.operator === 'EMC') stack = stack.slice(0, -1);
  }
  const byLocation = new Map<string, SemanticGlyph[]>();
  const key = (g: GlyphPlacement, x: number, y: number) =>
    JSON.stringify([g.fontName, g.code, (g.coreQuad[0].x - x).toFixed(3), (g.coreQuad[0].y - y).toFixed(3)]);
  for (const glyph of root.glyphs) {
    const address = key(glyph.placement, 0, 0);
    const matches = byLocation.get(address) ?? [];
    matches.push(glyph);
    byLocation.set(address, matches);
  }
  const glyphs = new Set<SemanticGlyph>();
  for (const g of footprint.firstGlyphs) {
    const matches = byLocation.get(key(g, footprint.origin.x, footprint.origin.y));
    const scopes = stacks.get(g.opIndex) ?? [];
    const addressed = matches?.filter(glyph => glyph.spans.length === scopes.length &&
      glyph.spans.every((span, i) => span === scopes[i]));
    if (addressed?.length === 1) glyphs.add(addressed[0]!);
  }
  return {
    glyphs,
    sources: [...footprint.removed].map(i => stacks.get(i) ?? []),
    slotScopes: stacks.get(footprint.slot) ?? [],
    unresolved: glyphs.size !== footprint.firstGlyphs.length || mark !== root.spans.length,
  };
}

export function inspectEditIntent(
  page: SemanticPage, overlay: ContentTextOverlay, covers: PdfRect[], flow?: FlowFootprint,
): SemanticIntent {
  const flowSelection = flow && readFlowSelection(page.occurrences[0]!, flow);
  const glyphs = flowSelection?.glyphs ?? (() => {
    const glyphs = page.occurrences.flatMap(o => o.glyphs);
    const placements = new Set(removalsByRect(glyphs.map(g => g.placement), covers).flatMap(hit => [...hit]));
    return new Set(glyphs.filter(g => placements.has(g.placement)));
  })();
  const ordered = inReadingOrder(glyphs);
  const sourceText = glyphText(ordered);
  const sameSelection = sourceText !== undefined && compactText(sourceText) === compactText(overlay.originalText);
  const projected = !flow && projectSelection(ordered, overlay.originalText, overlay.text, glyphLabel);
  // Place a changed part in its original scopes. Unchanged characters can
  // belong to other MCIDs, including unchanged rows of a multiline cover.
  const changed = projected && projected.edits.length ? projected.edits.flatMap(edit => edit.glyphs) : ordered;
  const sources = flowSelection?.sources ?? changed.map(g => g.spans);
  const slotScopes = flowSelection?.slotScopes ?? [];
  const scopes = new Set([...sources.flat(), ...slotScopes]);
  const bindings = page.dependencies.filter(b => b.spans.some(s => scopes.has(s)));
  const spans = new Set([...scopes].filter(s => s.issues.some(issue => issue.kind !== 'coverage') ||
    bindings.some(b => b.spans.includes(s))));
  const replacements = bindings.filter(b => b.replacementKey);
  const intent: SemanticIntent = { overlay, glyphs, spans, bindings, replacements,
    edits: projected ? projected.edits : undefined };
  if (!spans.size) return intent;

  const selectedText = compactText(overlay.originalText);
  const equivalent = replacements.map(b => compactText(b.dependency.text!));
  const partialEquivalent = !projected && !sameSelection && !!selectedText &&
    equivalent.some(label => label !== selectedText && label.includes(selectedText));
  // Covers alone cannot authorize a write. If they picked different text,
  // the candidate still has to prove every affected dependency unchanged.
  if (!flow && !projected && !sameSelection && !partialEquivalent && !equivalent.includes(selectedText)) {
    return { overlay, glyphs: new Set(), spans: new Set(), bindings: [], replacements: [] };
  }
  const incomplete = partialEquivalent || replacements.some(b => b.objects.length || b.spans.some(s =>
    s.paints.length || s.issues.length || s.glyphs.some(g => !glyphs.has(g)) ||
    changed.some(g => !b.spans.some(span => g.spans.includes(span)))));
  if (flowSelection?.unresolved || [...spans].some(s => s.issues.some(issue => issue.kind !== 'coverage'))) {
    intent.refusal = 'semantic-unresolved';
  } else if (incomplete && !flow) {
    intent.refusal = 'semantic-replacement-text';
  } else if ([...spans].some(s => (s.mcid !== undefined || flow) && sources.some(stack => !stack.includes(s))) ||
      (flow && [...spans].some(s => !slotScopes.includes(s)))) {
    intent.refusal = 'semantic-partial-span';
  } else if (flow && replacements.length) {
    intent.refusal = 'semantic-replacement-text';
  }
  return intent;
}
