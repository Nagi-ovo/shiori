import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { DocumentModel, Overlay, PageModel, SourceImageEditOverlay } from '../model/types';
import type { StructureEdges } from './semantic/structure';
import { createImageSemanticGate } from './semantic/imageGate';
import type { AnchoredAnnotation } from './sourceAnnotationAnchors';
import { applySourceImageEdits, inspectImageEditSources, type SourceImageOutcome } from './sourceImages/apply';

export function prepareRebuildImages(source: PDFDocument, model: DocumentModel, overlays: Overlay[], edges?: StructureEdges) {
  if (!model.overlays.some(overlay => overlay.type === 'sourceImageEdit')) return;
  // Read original appearances before applying the annotation export policy.
  const sources = source.isEncrypted ? undefined : inspectImageEditSources(source.getPages(), model.pages, overlays);
  const gate = source.isEncrypted ? undefined : createImageSemanticGate(source, model, overlays, edges);
  const outcomes = new Map<string, SourceImageOutcome>();
  return {
    gate,
    async write(page: PDFPage, modelPage: PageModel, outputIndex: number, edits: SourceImageEditOverlay[], textChanged: boolean, anchors?: readonly AnchoredAnnotation[]) {
      if (!edits.length) return 0;
      const sourceIndex = modelPage.sourceIndex;
      const candidate = await applySourceImageEdits(page, modelPage, sources?.get(sourceIndex), edits, textChanged,
        gate?.forPage(page, outputIndex, sourceIndex, textChanged), anchors);
      for (const outcome of candidate) outcomes.set(outcome.overlayId, outcome);
      return candidate.filter(outcome => outcome.mode === 'unsupported').length;
    },
    outcomes: () => overlays.flatMap(overlay => {
      const outcome = outcomes.get(overlay.id);
      return outcome && overlay.type === 'sourceImageEdit' ? [outcome] : [];
    }),
  };
}
