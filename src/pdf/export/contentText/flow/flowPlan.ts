// Dry run of a linked-frame flow edit: the same qualification and planning
// as the export (planFlowOnPage), on a throwaway parse of the source bytes.
import { PDFDocument, PDFName } from 'pdf-lib';
import type { DocumentModel } from '../../../model/types';
import {stripReplaceableAnnotationsFromPages} from '../../annotations';
import {alignPageTreeWithPdfium} from '../../sourcePageTree';
import {pagesMatchSource} from '../../sourcePageLayout';
import { rebuildPdf } from '../../rebuildPdf';
import { chainEdit, planFlowForModelPage } from './flowApply';
import type { CheckFlowSemantics } from './flowEngine';
import {flowReasons,type FlowMove,type FlowRefusal} from './flowTypes';
import {dependenciesOf, inspectEditIntent, refusedRows, type SemanticIntent} from '../../semantic/editIntent';
import {createSemanticInspector} from '../../semantic/inspection';
import {hasStructure, mayHaveMarks} from '../../semantic/probe';
import {readStructureEdges} from '../../semantic/structure';
import {verifySemanticEdit} from '../../semantic/verifyEdit';

export type FlowDryRun = { ok: true; moves: FlowMove[]; semanticChanges?: import('../../semanticGate').SemanticChange[] } | FlowRefusal;

export async function planLinkedFlow(source: Uint8Array, model: DocumentModel, chainId: string): Promise<FlowDryRun> {
  const edit = chainEdit(model, chainId);
  if ('ok' in edit) return edit;
  const doc = await PDFDocument.load(source.slice(), { updateMetadata: false });
  alignPageTreeWithPdfium(doc);
  const page = doc.getPages()[edit.page.sourceIndex];
  if (!page) return { ok: false, reason: 'flow-ambiguous-frame', detail: 'missing source page' };
  const structured = hasStructure(doc);
  if (!structured && !mayHaveMarks(page)) {
    const plan = planFlowForModelPage(page, edit.page, edit.chain, edit.overlay);
    return plan.ok ? { ok: true, moves: plan.moves } : plan;
  }
  const index = edit.page.sourceIndex;
  const inspector = createSemanticInspector(doc);
  const before = structured ? inspector.inspectDocument() : [inspector.inspectPage(index)!];
  const edited = before.find(p => p.pageIndex === index)!;
  let intent: SemanticIntent | undefined;
  const checkSemantics: CheckFlowSemantics = footprint => {
    intent = inspectEditIntent(edited, edit.overlay, [], footprint);
    if (intent.refusal) return { ok: false, reason: 'semantic-dependency',
      semanticChanges: refusedRows(edit.overlay.id, dependenciesOf(intent, edited), intent.refusal) };
  };
  let plan = planFlowForModelPage(page, edit.page, edit.chain, edit.overlay, checkSemantics);
  const anchor = !plan.ok && plan.reason === 'annotation-anchor' ? plan : undefined;
  if (anchor) plan = planFlowForModelPage(page, edit.page, edit.chain, edit.overlay, checkSemantics, []);
  if (!plan.ok) return plan;
  if (structured && !pagesMatchSource(model.pages, doc.getPages())) {
    // Use the export candidate for page relocation and projection. The
    // source plan supplies the move geometry and any early flow refusal.
    const result = await rebuildPdf(source, { ...model, overlays: [edit.overlay] }, {});
    const outcome = result.contentTextOutcomes?.[0];
    const semanticChanges = result.semanticChanges;
    const proof = semanticChanges?.length ? { semanticChanges } : {};
    if (outcome?.flow && outcome.mode !== 'unsupported') return { ok: true, moves: plan.moves, ...proof };
    const reason = flowReasons.find(reason => reason === outcome?.reason) ?? 'flow-unsupported-text';
    return { ok: false, reason, ...(outcome?.detail && { detail: outcome.detail }),
      ...(outcome?.anchoredAnnotations && { anchoredAnnotations: outcome.anchoredAnnotations }), ...proof };
  }
  if (structured) stripReplaceableAnnotationsFromPages(doc.getPages(), readStructureEdges(doc, inspector.structure).objects);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(plan.bytes)));
  const after = createSemanticInspector(doc);
  if (structured) after.inspectDocument();
  const outcome = { overlayId: edit.overlay.id, mode: 'retypeset' as const, flow: plan.manifest };
  const rows = [];
  for (const sourcePage of before) {
    const proof = verifySemanticEdit(sourcePage, after.inspectPage(sourcePage.pageIndex)!,
      intent && sourcePage === edited ? [{ intent, outcome }] : [], object => object);
    const failure = proof.conflicts[0];
    if (failure) return { ok: false, reason: 'semantic-dependency',
      semanticChanges: refusedRows(edit.overlay.id, failure.dependencies, failure.reason) };
    rows.push(...proof.rows);
  }
  return anchor ?? { ok: true, moves: plan.moves, ...(rows.length && { semanticChanges: rows }) };
}
export { chainEdit, planFlowForModelPage } from './flowApply';
export type { PdfRect } from '../../../model/types';
