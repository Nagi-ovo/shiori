import { PDFArray, PDFRef, type PDFPage } from 'pdf-lib';
import { value } from '../../src/pdf/export/semantic/pdfValues';
import type { CorpusOutcome } from './report';

/** Translate the export's sample refs for the report on the original document. */
export function corpusReportOutcome(outcome: CorpusOutcome, originalPage: PDFPage, samplePage: PDFPage): CorpusOutcome {
  if (!outcome.anchoredAnnotations?.length) return outcome;
  const originalAnnots = value(originalPage.node, 'Annots');
  const sampleAnnots = value(samplePage.node, 'Annots');
  if (!(originalAnnots instanceof PDFArray) || !(sampleAnnots instanceof PDFArray) ||
      originalAnnots.size() !== sampleAnnots.size()) return outcome;

  // copyPages preserves array positions, including those of direct annotations.
  const originalRefs = new Map<string, string>();
  for (let index = 0; index < sampleAnnots.size(); index++) {
    const original = originalAnnots.get(index);
    const sample = sampleAnnots.get(index);
    if (original instanceof PDFRef && sample instanceof PDFRef) {
      originalRefs.set(sample.toString(), original.toString());
    }
  }
  const anchoredAnnotations = outcome.anchoredAnnotations.map(annotation => ({
    ...annotation, ref: originalRefs.get(annotation.ref) ?? annotation.ref,
  }));
  const detail = anchoredAnnotations.map(({ ref, subtype }) => `annotation ${ref} ${subtype}`.trimEnd()).join(', ');
  return { ...outcome, anchoredAnnotations, detail };
}
