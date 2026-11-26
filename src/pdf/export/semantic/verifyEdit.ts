import type { PdfRect } from '../../model/types';
import type { PDFObject } from 'pdf-lib';
import type { ContentTextOutcome } from '../contentText/outcomes';
import type { SemanticChange, SemanticDependency, SemanticRefusalReason } from '../semanticGate';
import { columnOutput, columnReplacement } from './columnIntent';
import { compactText, dependenciesOf, glyphLabel, glyphText, inReadingOrder, spanDependency } from './editIntent';
import type { SemanticIntent } from './editIntent';
import { verifySpanMove, type InstalledPermutation } from './spanPermutation';
import { sameProperties, wasLegacyStrip } from './replacementProperties';
import { asDict, value } from './pdfValues';
import type { SemanticBinding, SemanticGlyph, SemanticIssue, SemanticOccurrence, SemanticPage, SemanticSpan } from './types';

export type ObjectMap = (source: PDFObject) => PDFObject | undefined;
export type InstalledIntent = { intent: SemanticIntent; outcome: ContentTextOutcome };
export type SemanticConflict = {
  key: string;
  overlayIds: string[];
  dependencies: SemanticDependency[];
  reason: SemanticRefusalReason;
};

export type Correspondence = {
  occurrences: Map<SemanticOccurrence, SemanticOccurrence>;
  spans: Map<SemanticSpan, SemanticSpan>;
};

export function matchAddresses(
  before: SemanticPage, after: SemanticPage, generated = new Set<SemanticSpan>(), permutations: InstalledPermutation[] = [],
): Correspondence {
  // Writers preserve Do order within a stream. Byte offsets and operator
  // indices can change when a show splits or brings its own text state.
  const occurrences = new Map<SemanticOccurrence, SemanticOccurrence>();
  const children = (o: SemanticOccurrence) => o.paints.flatMap(p => p.child ? [p.child] : []);
  const visit = (a: SemanticOccurrence, b: SemanticOccurrence) => {
    occurrences.set(a, b);
    const from = children(a), to = children(b);
    if (from.length !== to.length) return;
    from.forEach((child, index) => visit(child, to[index]!));
  };
  visit(before.occurrences[0]!, after.occurrences[0]!);
  const spans = new Map<SemanticSpan, SemanticSpan>();
  for (const [a, b] of occurrences) {
    const expected = [...a.spans];
    for (const permutation of permutations) {
      const start = expected.indexOf(permutation.source[0]!);
      if (start >= 0) expected.splice(start, permutation.source.length, ...permutation.output.map(move => move.span));
    }
    const candidates = b.spans.filter(span => !generated.has(span));
    const sameCount = expected.length === candidates.length;
    const right = sameCount ? candidates : candidates.filter(relevant);
    (sameCount ? expected : expected.filter(relevant)).forEach((span, index) => {
      const next = right[index];
      if (next && next.tag === span.tag && next.mcid === span.mcid) spans.set(span, next);
    });
  }
  return { occurrences, spans };
}

const relevant = (span: SemanticSpan) => span.mcid !== undefined || span.replacement.length > 0 ||
  span.issues.some(issue => issue.kind !== 'coverage');

function opBytes(occurrence: SemanticOccurrence, index: number) {
  const op = occurrence.ops[index];
  return op && new TextDecoder('latin1').decode(occurrence.bytes?.subarray(op.start, op.end));
}

function sameGlyphs(a: SemanticGlyph[], b: SemanticGlyph[], map: Correspondence, copy: ObjectMap): boolean {
  const font = (glyph: SemanticGlyph) => {
    const resources = glyph.occurrence.resources;
    const fonts = resources && asDict(value(resources, 'Font'));
    return fonts && value(fonts, glyph.placement.fontName);
  };
  return a.length === b.length && a.every(({ placement: g }, index) => {
    const earlier = a[index]!, later = b[index]!, h = later.placement;
    const originalFont = font(earlier), copied = originalFont && copy(originalFont);
    return map.occurrences.get(earlier.occurrence) === later.occurrence && (!copied || copied === font(later)) &&
      g.code === h.code && g.fontName === h.fontName && g.byteLength === h.byteLength;
  });
}

function samePaintAndUnknown(
  before: SemanticSpan, after: SemanticSpan, map: Correspondence,
  moved: (before: PdfRect | undefined, after: PdfRect | undefined) => boolean,
): boolean {
  const unknown = (span: SemanticSpan) => span.issues.filter(i => i.kind === 'coverage').map(i =>
    i.opIndex === undefined ? '' : opBytes(i.occurrence!, i.opIndex));
  if (JSON.stringify(unknown(before)) !== JSON.stringify(unknown(after))) return false;
  return before.paints.length === after.paints.length && before.paints.every((paint, index) => {
    const next = after.paints[index]!;
    if (map.occurrences.get(paint.occurrence) !== next.occurrence ||
        !moved(paint.bbox, next.bbox)) return false;
    return paint.child ? map.occurrences.get(paint.child) === next.child :
      opBytes(paint.occurrence, paint.opIndex) === opBytes(next.occurrence, next.opIndex);
  });
}

function expectedText(source: SemanticGlyph[], installed: InstalledIntent[]): string | undefined {
  const edits = new Map<SemanticGlyph, string>();
  const relevantLabel = (glyph: SemanticGlyph) => glyphLabel(glyph);
  for (const { intent } of installed) {
    if (intent.edits?.length) {
      for (const part of intent.edits) {
        if (!part.glyphs.some(glyph => source.includes(glyph))) continue;
        if (part.glyphs.some(glyph => edits.has(glyph) || !source.includes(glyph))) return;
        edits.set(part.glyphs[0]!, part.replacement);
        for (const glyph of part.glyphs.slice(1)) edits.set(glyph, '');
      }
      continue;
    }
    const selected = source.filter(g => intent.glyphs.has(g));
    const actual = glyphText(selected);
    if (!selected.length || actual === undefined ||
        compactText(actual) !== compactText(intent.overlay.originalText) ||
        selected.some(g => edits.has(g))) return;
    edits.set(selected[0]!, intent.overlay.text);
    for (const glyph of selected.slice(1)) edits.set(glyph, '');
  }
  let text = '';
  for (const glyph of source) {
    const label = edits.get(glyph) ?? relevantLabel(glyph);
    if (label === undefined) return;
    text += label;
  }
  return compactText(text.normalize('NFKC'));
}

export function mapsBinding(a: SemanticBinding, b: SemanticBinding, map: Correspondence, copy: ObjectMap): boolean {
  return a.unresolved === b.unresolved && a.dependency.kind === b.dependency.kind && a.dependency.source === b.dependency.source &&
    (a.owner ? !!b.owner && copy(a.owner) === b.owner : !b.owner) &&
    (a.reference ? !!b.reference && copy(a.reference) === b.reference : !b.reference) &&
    a.spans.length === b.spans.length && a.spans.every(span => b.spans.includes(map.spans.get(span)!)) &&
    a.objects.length === b.objects.length && a.objects.every(obj => b.objects.some(next => copy(obj.object) === next.object));
}

/** Losses certified against the layout-only candidate before an edit writes. */
export function omittedStructureBindings(before: SemanticPage, layout: SemanticPage, copy: ObjectMap): Set<SemanticBinding> {
  const map = matchAddresses(before, layout);
  return new Set(before.dependencies.filter(binding =>
    (binding.owner || binding.reference || binding.dependency.source === 'parent-tree') &&
    !layout.dependencies.some(candidate => mapsBinding(binding, candidate, map, copy))));
}

function changesStreamOwner(binding: SemanticBinding, span: SemanticSpan, map: Correspondence, copy: ObjectMap): boolean {
  const occurrence = span.occurrence;
  const next = map.spans.get(span)?.occurrence;
  if (occurrence.raw && copy(occurrence.raw) !== next?.raw) return true;
  const owner = binding.reference && value(binding.reference, 'StmOwn');
  if (!owner) return false;
  for (let from = occurrence.invocation?.occurrence; from; from = from.invocation?.occurrence) {
    if (from.raw === owner || from.owner === owner) {
      return !!from.raw && copy(from.raw) !== map.occurrences.get(from)?.raw;
    }
  }
  return false;
}

const structureIssues = new Set<SemanticIssue['kind']>([
  'marked-content', 'property-name', 'property-value', 'duplicate-mcid', 'number-tree-cycle',
  'number-tree-entry', 'structure-cycle', 'structure-entry', 'parent-key', 'parent-owner',
  'owner-mismatch', 'stream-mismatch', 'object-mismatch',
]);

function addedIssues(before: SemanticPage, after: SemanticPage, map: Correspondence, copy: ObjectMap): SemanticIssue[] {
  const old = before.issues.filter(issue => structureIssues.has(issue.kind));
  return after.issues.filter(issue => {
    if (!structureIssues.has(issue.kind)) return false;
    const at = old.findIndex(earlier => earlier.kind === issue.kind && earlier.mcid === issue.mcid &&
      earlier.parentKey === issue.parentKey && (!earlier.occurrence || map.occurrences.get(earlier.occurrence) === issue.occurrence) &&
      (!earlier.reference || !copy(earlier.reference) || copy(earlier.reference) === issue.reference));
    if (at === -1) return true;
    old.splice(at, 1);
    return false;
  });
}

export function verifySemanticEdit(
  before: SemanticPage, after: SemanticPage, installed: InstalledIntent[], copy: ObjectMap,
  updates: ReadonlyMap<SemanticBinding, string> = new Map(), origin = { x: 0, y: 0 },
  projection?: { layout: SemanticPage; omitted: Set<SemanticBinding> },
): { rows: SemanticChange[]; conflicts: SemanticConflict[] } {
  const columns = new Map(installed.filter(({ intent }) => intent.column)
    .map(edit => [edit, columnOutput(after, edit.intent)]));
  const generated = new Set([...columns.values()].flatMap(proof => proof ? [...proof.generated] : []));
  const permutations = installed.flatMap(({ intent }) => intent.permutation ? [intent.permutation] : []);
  const map = matchAddresses(before, after, generated, permutations);
  const relevantTargets = new Set([...map.spans].filter(([source]) => relevant(source)).map(([, dest]) => dest));
  const rows: SemanticChange[] = [];
  const conflicts: SemanticConflict[] = [];
  const conflict = (key: string, dependencies: SemanticDependency[], reason: SemanticRefusalReason,
    edits: InstalledIntent[] = []) => {
    conflicts.push({ key: `${before.pageIndex}:${key}`, dependencies, reason, overlayIds: edits.map(e => e.intent.overlay.id) });
  };

  for (const edit of installed) {
    const { intent } = edit;
    const column = columns.get(edit);
    if (intent.refusal) {
      conflict(`intent:${intent.overlay.id}`, dependenciesOf(intent, before), intent.refusal, [edit]);
    } else if (intent.column && (!column || [...column.targets].some(([source, targets]) => {
      const scopes = source.spans.filter(relevant).map(span => map.spans.get(span));
      return targets.some(target => {
        const actual = target.spans.filter(span => !generated.has(span) && (relevant(span) || relevantTargets.has(span)));
        return scopes.length !== actual.length || scopes.some((span, i) => span !== actual[i]);
      });
    }))) {
      conflict(`column:${intent.overlay.id}`, dependenciesOf(intent, before), 'semantic-structure-reference', [edit]);
    }
  }

  // R1 keeps the legacy stripping disposition for fully covered equivalents.
  const changedProperties = new Set<SemanticSpan>();
  for (const binding of before.dependencies) {
    const next = after.dependencies.find(b => mapsBinding(binding, b, map, copy));
    const edits = installed.filter(e => e.intent.bindings.includes(binding));
    if (projection?.omitted.has(binding)) {
      if (edits.length) conflict(`projection:${before.dependencies.indexOf(binding)}`, [binding.dependency],
        binding.replacementKey ? 'semantic-replacement-text' : 'semantic-structure-reference', edits);
      continue;
    }
    const legacy = !next && edits.length === 1 && wasLegacyStrip(before.tagged, binding, edits[0]!, map.spans);
    if (legacy) {
      binding.spans.forEach(span => changedProperties.add(span));
      rows.push({ overlayId: edits[0]!.intent.overlay.id, dependency: binding.dependency, action: 'stripped' });
      continue;
    }
    const edited = edits.length === 1 && edits[0]!;
    const updated = updates.get(binding) ?? (edited ? columnReplacement(binding, edited.intent) : undefined);
    if (edited && updated !== undefined && next?.dependency.text === updated) {
      const changed = binding.dependency.text !== updated;
      if (changed && binding.dependency.source !== 'struct-elem') binding.spans.forEach(span => changedProperties.add(span));
      rows.push({ overlayId: edited.intent.overlay.id, dependency: binding.dependency, action: changed ? 'updated' : 'preserved' });
      continue;
    }
    const reason = binding.replacementKey ? 'semantic-replacement-text' : 'semantic-structure-reference';
    const formChanged = !binding.unresolved && !binding.replacementKey &&
      binding.spans.some(span => changesStreamOwner(binding, span, map, copy));
    if (!next || formChanged || binding.dependency.text !== next.dependency.text || (binding.replacementKey && edits.length)) {
      conflict(`dependency:${before.dependencies.indexOf(binding)}`, [binding.dependency], reason, edits);
      continue;
    }
    for (const { intent } of edits) rows.push({ overlayId: intent.overlay.id, dependency: binding.dependency, action: 'preserved' });
  }

  const regions = installed.flatMap(({ outcome }) => outcome.retypeset?.pushedRegions ?? []);
  const samePaintBox = (a: PdfRect | undefined, b: PdfRect | undefined) => {
    if (!a || !b) return a === b;
    const near = (x: number, y: number) => Math.abs(x - y) <= .001;
    if (!near(a.w, b.w) || !near(a.h, b.h)) return false;
    if (near(a.x, b.x) && near(a.y, b.y)) return true;
    const x = a.x + origin.x, y = a.y + origin.y;
    return regions.some(({ before, after }) =>
      x >= before.x - .001 && y >= before.y - .001 &&
      x + a.w <= before.x + before.w + .001 && y + a.h <= before.y + before.h + .001 &&
      near(b.x - a.x, after.x - before.x) && near(b.y - a.y, after.y - before.y));
  };
  const protectedSpans = new Set([...before.dependencies.flatMap(b => b.spans),
    ...before.occurrences.flatMap(o => o.spans.filter(relevant))]);
  for (const span of protectedSpans) {
    const next = map.spans.get(span);
    const bindings = before.dependencies.filter(b => b.spans.includes(span));
    const edits = installed.filter(e => e.intent.spans.has(span));
    const dependencies = bindings.length ? bindings.map(b => b.dependency) : [spanDependency(before, span)];
    const key = `span:${span.occurrence.address}:${span.beginOp}`;
    if (!next || !samePaintAndUnknown(span, next, map, samePaintBox) ||
        (span.endOp === undefined) !== (next.endOp === undefined) ||
        span.ancestors.filter(relevant).some(a => !next.ancestors.includes(map.spans.get(a)!)) ||
        next.ancestors.filter(relevant).some(b => !span.ancestors.some(a => map.spans.get(a) === b)) ||
        (changedProperties.has(span) ? !sameProperties(span, next, copy) :
          opBytes(span.occurrence, span.beginOp) !== opBytes(next.occurrence, next.beginOp))) {
      conflict(key, dependencies, 'semantic-structure-reference', edits);
      continue;
    }
    const oldGlyphs = inReadingOrder(span.glyphs), newGlyphs = inReadingOrder(next.glyphs);
    const move = edits.length === 1 && edits[0]!.intent.permutation?.output.find(step => step.span === span);
    if (move) {
      if (!sameGlyphs(oldGlyphs, newGlyphs, map, copy) || !verifySpanMove(move, next)) {
        conflict(key, dependencies, 'semantic-structure-reference', edits);
      }
      continue;
    }
    if (!edits.length) {
      if (sameGlyphs(oldGlyphs, newGlyphs, map, copy)) continue;
      const original = glyphText(oldGlyphs), current = glyphText(newGlyphs);
      // A substitution can re-emit an unchanged sibling line in its
      // replacement face. Its decoded text and reading order must agree.
      if (original !== undefined && original === current &&
          oldGlyphs.every(glyph => newGlyphs.some(next => map.occurrences.get(glyph.occurrence) === next.occurrence))) continue;
    }
    const columnEdits = edits.filter(edit => columns.get(edit));
    if (columnEdits.length === edits.length && columnEdits.length > 0) {
      const targets = new Map(columnEdits.flatMap(edit => [...columns.get(edit)!.targets]));
      const expected = oldGlyphs.flatMap(glyph => (targets.get(glyph) ?? [glyph]).map(g => ({ glyph: g, written: targets.has(glyph) })));
      if (expected.length === newGlyphs.length && expected.every(({ glyph, written }, i) =>
        written ? glyph === newGlyphs[i] : sameGlyphs([glyph], [newGlyphs[i]!], map, copy))) continue;
    } else if (edits.length) {
      const wanted = expectedText(oldGlyphs, edits), actual = newGlyphs.map(glyphLabel);
      if (wanted !== undefined && actual.every(label => label !== undefined) && compactText(actual.join('').normalize('NFKC')) === wanted) continue;
    }
    conflict(key, dependencies, span.issues.length ? 'semantic-unresolved' :
      bindings.some(b => b.replacementKey) ? 'semantic-replacement-text' : 'semantic-structure-reference', edits);
  }

  const issues = projection
    ? addedIssues(projection.layout, after, matchAddresses(projection.layout, after, generated), object => object)
    : addedIssues(before, after, map, copy);
  for (const issue of issues) {
    const kind = issue.kind === 'object-mismatch' ? 'objr' : issue.kind === 'stream-mismatch' ? 'mcr-stm' : 'mcid';
    const associated = before.dependencies.filter(b => b.dependency.kind === kind &&
      (issue.mcid === undefined || b.dependency.mcid === issue.mcid));
    const addressed = associated.filter(b => b.reference && copy(b.reference) === issue.reference);
    const bindings = addressed.length ? addressed : associated;
    const edits = installed.filter(edit => bindings.some(b => edit.intent.bindings.includes(b)));
    const edge = addressed.length ? before.dependencies.indexOf(addressed[0]!) : '';
    conflict(`issue:${issue.kind}:${issue.parentKey}:${issue.mcid}:${edge}`, bindings.length ? bindings.map(b => b.dependency) :
      [{ kind, pageIndex: before.pageIndex, source: 'parent-tree', mcid: issue.mcid }], 'semantic-structure-reference', edits);
  }
  if ((projection?.layout ?? before).hasStructureRoot && !after.hasStructureRoot) {
    conflict('missing-structure', before.dependencies.map(b => b.dependency), 'semantic-structure-reference');
  }
  return { rows, conflicts };
}
