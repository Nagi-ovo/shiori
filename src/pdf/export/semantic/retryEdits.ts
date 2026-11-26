import type { DocumentModel } from '../../model/types';
import type { RebuildResult } from '../rebuildPdf';
import type { ContentTextOutcome } from '../contentText/outcomes';
import type { SemanticChange } from '../semanticGate';
import { refusedRows } from './editIntent';
import type { SemanticConflict } from './verifyEdit';

export type SemanticCandidate = RebuildResult & {
  conflicts?: SemanticConflict[];
  canKeepSourceOnRefusal?: boolean;
  anchorRefusalsNeedSemanticProof?: boolean;
};

export async function rebuildWithSemanticGate(
  model: DocumentModel, rebuild: (candidate: DocumentModel, checkTextAnchors: boolean) => Promise<SemanticCandidate>,
): Promise<RebuildResult> {
  let needsProof = false;
  const result = await settleSemanticConflicts(model, async candidate => {
    const trial = await rebuild(candidate, true);
    needsProof ||= !!trial.anchorRefusalsNeedSemanticProof;
    return trial;
  });
  const blocked = result.contentTextOutcomes?.filter(o => o.reason === 'annotation-anchor');
  if (!needsProof || !blocked?.length) return result;

  // An anchored text candidate never reaches the ordinary semantic proof.
  // Run that proof in a separate candidate to retain earlier semantic
  // refusals. Only its findings are used, never its bytes.
  const probe = await settleSemanticConflicts(model, candidate => rebuild(candidate, false));
  const semantic = new Map(probe.contentTextOutcomes?.filter(o => o.reason === 'semantic-dependency').map(o => [o.overlayId, o]));
  const ids = new Set(blocked.filter(o => semantic.has(o.overlayId)).map(o => o.overlayId));
  if (!ids.size) return result;
  return {
    ...result,
    contentTextOutcomes: result.contentTextOutcomes!.map(o => ids.has(o.overlayId) ? semantic.get(o.overlayId)! : o),
    semanticChanges: [
      ...(result.semanticChanges ?? []),
      ...(probe.semanticChanges?.filter(row => ids.has(row.overlayId) && row.action === 'refused') ?? []),
    ],
  };
}

async function settleSemanticConflicts(
  model: DocumentModel, rebuild: (candidate: DocumentModel) => Promise<SemanticCandidate>,
): Promise<RebuildResult> {
  let result = await rebuild(model);
  if (!result.conflicts?.length) return result;
  const original = result;
  const originalOrder = result.contentTextOutcomes ?? [];
  const refused = new Map<string, ContentTextOutcome>();
  const rows: SemanticChange[] = [];
  const without = (extra: readonly string[]) => ({
    ...model,
    overlays: model.overlays.filter(o => !refused.has(o.id) && !extra.includes(o.id)),
  });
  while (result.conflicts?.length) {
    const failure = result.conflicts[0]!;
    let drop = failure.overlayIds;
    let next: SemanticCandidate | undefined;
    // A paragraph may be compiled as a batch. Test removal of each suspect
    // against the same source to retain independent writes on that page.
    if (drop.length > 1) {
      const repeats = (trial: SemanticCandidate) => trial.conflicts?.some(conflict => conflict.key === failure.key);
      for (const id of drop) {
        const trial = await rebuild(without([id]));
        if (!repeats(trial)) {
          drop = [id];
          next = trial;
          break;
        }
      }
      if (!next) {
        const culprits: string[] = [];
        for (const id of drop) {
          const trial = await rebuild(without(drop.filter(other => other !== id)));
          if (repeats(trial)) culprits.push(id);
        }
        drop = culprits.length ? culprits : [drop[0]!];
      }
    }
    for (const id of drop) {
      const outcome = result.contentTextOutcomes?.find(o => o.overlayId === id);
      refused.set(id, { overlayId: id, pageIndex: outcome?.pageIndex, mode: 'unsupported', reason: 'semantic-dependency' });
      const related = result.conflicts.filter(c => c === failure ||
        (c.overlayIds.length === 1 && c.overlayIds[0] === id));
      const touched = result.semanticChanges?.filter(row => row.overlayId === id).map(row => row.dependency) ?? [];
      rows.push(...refusedRows(id, [...related.flatMap(c => c.dependencies), ...touched], failure.reason));
    }
    result = next ?? await rebuild(without([]));
  }
  const current = new Map(result.contentTextOutcomes?.map(outcome => [outcome.overlayId, outcome]));
  const semanticChanges = [...(result.semanticChanges ?? []), ...rows];
  const contentTextOutcomes = originalOrder.map(o => refused.get(o.overlayId) ?? current.get(o.overlayId) ?? o);
  const restore = original.canKeepSourceOnRefusal && !result.sourceImageOutcomes?.some(outcome => outcome.mode === 'applied') && contentTextOutcomes.every(o => o.mode === 'unsupported');
  return {
    ...result,
    ...(restore && { bytes: original.bytes, unchanged: true }),
    contentTextOutcomes,
    unexcisedEdits: result.unexcisedEdits + refused.size,
    ...(semanticChanges.length && { semanticChanges }),
  };
}
