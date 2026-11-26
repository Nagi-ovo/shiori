import { PDFArray, PDFRef, type PDFPage } from 'pdf-lib';
import type { PdfRect } from '../model/types';
import { asDict, asName, numberArray, value } from './semantic/pdfValues';

export type AnchoredAnnotation = {
  ref: string;
  subtype: string;
  kind: 'link' | 'markup' | 'widget';
  rect: [number, number, number, number];
};

export type AnnotationAnchorRefusal = {
  reason: 'annotation-anchor';
  detail: string;
  anchoredAnnotations: AnchoredAnnotation[];
};

/** Snapshot the original array before annotation removal, overlay attachment, or object renumbering. */
export function readSourceAnnotationAnchors(page: PDFPage): AnchoredAnnotation[] {
  const annots = value(page.node, 'Annots');
  if (!(annots instanceof PDFArray)) return [];
  return annots.asArray().flatMap((entry, index) => {
    const dict = asDict(annots.lookup(index));
    if (!dict) return [];
    const subtype = asName(value(dict, 'Subtype')) ?? '';
    if (subtype === 'Popup') return [];
    const rect = numberArray(value(dict, 'Rect'), 4);
    if (!rect) return [];
    const [x0, y0, x1, y1] = rect as AnchoredAnnotation['rect'];
    const anchor: AnchoredAnnotation = {
      ref: entry instanceof PDFRef ? entry.toString() : `direct:${index}`,
      subtype,
      kind: subtype === 'Link' ? 'link' : subtype === 'Widget' ? 'widget' : 'markup',
      rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
    };
    return [anchor];
  });
}

/** The intersection itself must have positive width and height, even for degenerate rectangles. */
export function annotationAnchorRefusal(
  annotations: readonly AnchoredAnnotation[], affected: readonly PdfRect[],
): AnnotationAnchorRefusal | undefined {
  const anchoredAnnotations = annotations.filter(({ rect: [x0, y0, x1, y1] }) =>
    affected.some(({ x, y, w, h }) => Math.max(x, x0) < Math.min(x + w, x1) &&
      Math.max(y, y0) < Math.min(y + h, y1)));
  if (!anchoredAnnotations.length) return;
  const detail = anchoredAnnotations.map(({ ref, subtype }) => `annotation ${ref} ${subtype}`.trimEnd()).join(', ');
  return { reason: 'annotation-anchor', detail, anchoredAnnotations };
}

export function retypesetAffectedBoxes(geometry: { paragraphBox: PdfRect; pushedRegions: { before: PdfRect; after: PdfRect }[] }) {
  return [geometry.paragraphBox, ...geometry.pushedRegions.flatMap(({ before, after }) => [before, after])];
}
