import type { DocumentModel } from '../model/types';
import { evaluateAcceptance } from './acceptance';
import type { ContentTextOutcome } from './contentText/outcomes';
import type { ExportOptions } from './exportPdf';
import type { RebuildResult } from './rebuildPdf';
import type { SemanticChange } from './semanticGate';

export async function rebuildForAcceptance(
  model: DocumentModel, options: ExportOptions, rebuild: (model: DocumentModel) => Promise<RebuildResult>,
): Promise<RebuildResult> {
  let result = await rebuild(model);
  const initialOutcomes = result.contentTextOutcomes;
  if (options.acceptance !== "strict" || !initialOutcomes?.length) return result;

  // Recompile from the original rather than trying to undo edits that may
  // share a stream or resources. Keep ordinary writer refusals on each
  // affected page even if dropping a sibling would let them compile.
  const omitted = new Map<string, ContentTextOutcome>();
  const semanticRefusals = new Map<string, SemanticChange[]>();
  const writerRefusals = new Map<string, ContentTextOutcome>();
  for (;;) {
    const outcomes = result.contentTextOutcomes ?? [];
    for (const outcome of outcomes) {
      if (outcome.mode === "unsupported" && !writerRefusals.has(outcome.overlayId)) {
        writerRefusals.set(outcome.overlayId, outcome);
        const rows = result.semanticChanges?.filter(row => row.action === "refused" && row.overlayId === outcome.overlayId);
        if (rows?.length) semanticRefusals.set(outcome.overlayId, rows);
      }
    }
    const blockers = new Set(evaluateAcceptance(result, "strict").findings.map(finding => finding.overlayId));
    const rejected = outcomes.filter(outcome => outcome.mode !== "unsupported" &&
      (blockers.has(outcome.overlayId) || writerRefusals.has(outcome.overlayId)));
    if (rejected.length === 0) break;
    const affectedPages = new Set(rejected.map(outcome => outcome.pageIndex));
    for (const outcome of rejected) {
      omitted.set(outcome.overlayId, writerRefusals.get(outcome.overlayId) ??
        { ...outcome, mode: "unsupported", reason: "acceptance-strict" });
    }
    for (const outcome of outcomes) {
      if (outcome.mode === "unsupported" && affectedPages.has(outcome.pageIndex)) {
        omitted.set(outcome.overlayId, writerRefusals.get(outcome.overlayId)!);
      }
    }
    result = await rebuild({
      ...model,
      overlays: model.overlays.filter(overlay => overlay.type !== "contentText" || !omitted.has(overlay.id)),
    });
  }
  if (omitted.size === 0) return result;
  const finalOutcomes = new Map(result.contentTextOutcomes?.map(outcome => [outcome.overlayId, outcome]));
  const semanticChanges = [
    ...(result.semanticChanges ?? []),
    ...[...omitted.keys()].flatMap(id => semanticRefusals.get(id) ?? []),
  ];
  return {
    ...result,
    ...(semanticChanges.length && { semanticChanges }),
    contentTextOutcomes: initialOutcomes.map(({ overlayId }) =>
      omitted.get(overlayId) ?? writerRefusals.get(overlayId) ?? finalOutcomes.get(overlayId)!),
    unexcisedEdits: result.unexcisedEdits + omitted.size,
  };
}
