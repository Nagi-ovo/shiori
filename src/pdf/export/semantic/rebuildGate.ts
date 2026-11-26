import { PDFName, type PDFDocument, type PDFPage } from 'pdf-lib';
import { isBlankPage, type ContentTextOverlay, type DocumentModel, type Overlay } from '../../model/types';
import { pageOrigin } from '../../model/pageSpace';
import { effectivePdfPageBox } from '../../model/pageBoxes';
import { columnEvidence } from '../contentText/uprightColumnEvidence';
import { intersects } from '../contentText/regionProof/geometry';
import type { Type1Options } from '../fontCoverage/type1Support';
import type { ContentTextOutcome } from '../contentText/outcomes';
import type { SemanticChange } from '../semanticGate';
import type { AnchoredAnnotation } from '../sourceAnnotationAnchors';
import { createCloneState, seedObjectMapping } from '../pdfObjectClone';
import { copiedSemanticObject, structureWasProjected } from '../structureCopy';
import { dependenciesOf, inspectEditIntent, refusedRows, type FlowFootprint, type SemanticIntent } from './editIntent';
import { createSemanticInspector } from './inspection';
import { hasStructure, mayHaveMarks } from './probe';
import type { SemanticPage } from './types';
import { columnIntent } from './columnIntent';
import { writeReplacementValues } from './replacementWrites';
import { omittedStructureBindings, verifySemanticEdit, type InstalledIntent, type SemanticConflict } from './verifyEdit';
import { permutationIntent, planSpanPermutation, type SpanPermutation } from './spanPermutation';
import { writeSpanPermutation } from './writeSpanPermutation';

/** Capture the source before annotation filtering or page copying. Only
 * marked pages need glyph coverage, except in a structure graph where a
 * write can invalidate a reference on another page. */
export function createRebuildSemanticGate(
  source: PDFDocument, model: DocumentModel, overlays: Overlay[], textAnchors: readonly (readonly AnchoredAnnotation[])[],
) {
  const edits = overlays.filter((o): o is ContentTextOverlay => o.type === 'contentText');
  if (!edits.length) return;
  const pages = source.getPages(), structured = hasStructure(source);
  const bySource = new Map<number, SemanticPage>();
  let inspector: ReturnType<typeof createSemanticInspector> | undefined;
  const inspectSource = (index: number) => {
    inspector ??= createSemanticInspector(source);
    return inspector.inspectPage(index);
  };
  if (structured) {
    const inspection = createSemanticInspector(source);
    for (const page of inspection.inspectDocument()) bySource.set(page.pageIndex, page);
  } else {
    const editPages = new Set(edits.map(edit => edit.pageId));
    for (const page of model.pages) {
      if (isBlankPage(page) || !editPages.has(page.id) || bySource.has(page.sourceIndex)) continue;
      const original = pages[page.sourceIndex];
      if (!original || !mayHaveMarks(original)) continue;
      bySource.set(page.sourceIndex, inspectSource(page.sourceIndex)!);
    }
  }
  const intents = new Map<string, SemanticIntent>();
  const refusals = new Map<string, ContentTextOutcome>();
  const rows: SemanticChange[] = [];
  const permutations = new Map<string, SpanPermutation>();
  const check = (overlay: ContentTextOverlay, footprint?: FlowFootprint) => {
    const index = model.pages.findIndex(page => page.id === overlay.pageId);
    const page = model.pages[index]!;
    const before = bySource.get(page.sourceIndex);
    if (!before) return;
    const original = pages[page.sourceIndex]!;
    const crop = effectivePdfPageBox(original.getMediaBox(), original.getCropBox());
    const origin = pageOrigin(page);
    const covers = overlay.coverRects.map(r => ({ ...r, x: r.x + origin.x - crop.x, y: r.y + origin.y - crop.y }));
    const intent = inspectEditIntent(before, overlay, covers, footprint);
    intents.set(overlay.id, intent);
    if (!intent.refusal) return;
    const outcome: ContentTextOutcome = { overlayId: overlay.id, mode: 'unsupported', reason: 'semantic-dependency', pageIndex: index };
    refusals.set(overlay.id, outcome);
    const independent = edits.every(edit => edit === overlay || edit.pageId !== overlay.pageId ||
      !edit.coverRects.some(rect => overlay.coverRects.some(cover => intersects(rect, cover))));
    const permutation = !footprint && independent ? planSpanPermutation(before, intent) : undefined;
    if (permutation) permutations.set(overlay.id, permutation);
    else rows.push(...refusedRows(overlay.id, dependenciesOf(intent, before), intent.refusal));
    return outcome;
  };
  for (const edit of edits) if (!edit.flowChainId) check(edit);
  const byId = new Map(edits.map(edit => [edit.id, edit]));
  let copied: ReturnType<typeof createCloneState> | undefined;
  const layouts = new Map<PDFPage, SemanticPage>();
  return {
    refusals,
    checksSource: bySource.size > 0,
    recordPages(indices: number[], copies: PDFPage[]) {
      if (!bySource.size || !copies.length) return;
      const dest = copies[0]!.doc;
      if (structureWasProjected(dest)) {
        const baseline = createSemanticInspector(dest, { pages: copies });
        for (const [i, page] of baseline.inspectDocument().entries()) layouts.set(copies[i]!, page);
      }
      if (source.catalog.has(PDFName.of('StructTreeRoot'))) return;
      copied = createCloneState(source, new Map());
      const resources = PDFName.of('Resources');
      for (const [i, index] of indices.entries()) {
        if (!bySource.has(index)) continue;
        const page = copies[i]!;
        seedObjectMapping(source, page.doc, copied,
          pages[index]!.node.getInheritableAttribute(resources), page.node.get(resources));
      }
    },
    checkFlow: check,
    writePermutations(page: PDFPage, pageOverlays: Overlay[], type1: Type1Options | undefined, reflowRequests: ReadonlyMap<string, unknown> | undefined) {
      const installed: ContentTextOutcome[] = [];
      for (const overlay of pageOverlays) {
        const plan = permutations.get(overlay.id);
        if (!plan || overlay.type !== 'contentText') continue;
        const intent = intents.get(overlay.id)!;
        const sourceIndex = model.pages.find(candidate => candidate.id === overlay.pageId)!.sourceIndex;
        const before = bySource.get(sourceIndex)!;
        const result = reflowRequests?.has(overlay.id) ? undefined :
          writeSpanPermutation(page, overlay, plan, type1, textAnchors[sourceIndex] ?? []);
        if (!result) {
          rows.push(...refusedRows(overlay.id, dependenciesOf(intent, before), intent.refusal!));
        } else if ('permutation' in result) {
          installed.push(result.outcome);
          refusals.delete(overlay.id);
          intents.set(overlay.id, permutationIntent(before, intent, result.permutation));
        } else {
          refusals.set(overlay.id, { overlayId: overlay.id, mode: 'unsupported', ...result });
        }
      }
      return installed;
    },
    recordColumnEdits(outcomes: ContentTextOutcome[]) {
      for (const outcome of outcomes) {
        const cells = columnEvidence.get(outcome);
        const original = intents.get(outcome.overlayId);
        if (!cells || !original) continue;
        const { overlay } = original;
        const page = model.pages.find(page => page.id === overlay.pageId)!;
        const sourcePage = pages[page.sourceIndex]!;
        const crop = effectivePdfPageBox(sourcePage.getMediaBox(), sourcePage.getCropBox());
        const before = bySource.get(page.sourceIndex)!;
        const fromColumn = columnIntent(before, overlay, cells, crop);
        if (fromColumn) intents.set(overlay.id, fromColumn);
      }
    },
    verify(out: PDFDocument, outcomes: ContentTextOutcome[]) {
      const installed = outcomes.filter(o => o.mode !== 'unsupported');
      const conflicts: SemanticConflict[] = [];
      if (!installed.length) return { rows, conflicts };
      const outputPages = out.getPages();
      const copy = (object: Parameters<typeof copiedSemanticObject>[1]) =>
        copiedSemanticObject(out, object) ?? copied?.clonedObjects.get(object);
      const contexts = model.pages.flatMap((page, index) => {
        if (isBlankPage(page)) return [];
        const onPage = installed.filter(o => o.pageIndex === index);
        const before = bySource.get(page.sourceIndex) ??
          (onPage.length && mayHaveMarks(outputPages[index]!) ? inspectSource(page.sourceIndex) : undefined);
        if (!before) return [];
        const claims: InstalledIntent[] = onPage.flatMap(outcome => {
          const known = intents.get(outcome.overlayId);
          if (known) return [{ intent: known, outcome }];
          const overlay = byId.get(outcome.overlayId);
          return overlay ? [{ intent: inspectEditIntent(before, overlay, []), outcome }] : [];
        });
        const sourcePage = pages[page.sourceIndex]!;
        const crop = effectivePdfPageBox(sourcePage.getMediaBox(), sourcePage.getCropBox());
        return [{ index, onPage, before, claims, crop }];
      });
      if (!contexts.length) return { rows, conflicts };
      let inspection = createSemanticInspector(out);
      if (structured) inspection.inspectDocument();
      const candidates = contexts.map(context => {
        const { index, before, claims } = context;
        const updates = writeReplacementValues(outputPages[index]!, before, inspection.inspectPage(index)!, claims, copy);
        return { ...context, updates };
      });
      if (candidates.some(candidate => candidate.updates.size)) {
        inspection = createSemanticInspector(out);
        if (structured) inspection.inspectDocument();
      }
      for (const { index, onPage, before, claims, updates, crop } of candidates) {
        const layout = layouts.get(outputPages[index]!);
        const projection = layout && { layout, omitted: omittedStructureBindings(before, layout, copy) };
        const proof = verifySemanticEdit(before, inspection.inspectPage(index)!, claims, copy, updates, crop, projection);
        if (!proof.conflicts.length) for (const { outcome } of claims) {
          const changes = proof.rows.filter(row => row.overlayId === outcome.overlayId);
          if (changes.some(row => row.action === 'updated') && !changes.some(row => row.action === 'stripped')) {
            delete outcome.strippedEquivalent;
          }
        }
        rows.push(...proof.rows);
        for (const failure of proof.conflicts) {
          conflicts.push({ ...failure, key: `${index}:${failure.key}`, overlayIds: failure.overlayIds.length ? failure.overlayIds :
            (onPage.length ? onPage : installed).map(o => o.overlayId) });
        }
      }
      return { rows, conflicts };
    },
  };
}
