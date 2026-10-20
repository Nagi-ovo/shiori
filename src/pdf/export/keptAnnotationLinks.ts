// Reply links (/IRT) between the annotations export rebuilds and the ones it
// keeps as they were (Circle, Line, Stamp, Caret, ...).
//
// Export strips the annotations Shiori owns from the SOURCE page, copies the
// page into a new document (pdf-lib renumbers every object on the way and
// keeps its old -> new map private), and only then builds the replacements on
// the COPY. Source object numbers mean nothing by that point, so the two steps
// hand over through a mark on each kept annotation that takes part in a link:
// strip writes it, attach reads it and takes it off again.
//
// A kept annotation that a removed one replied to (a Text reply on a Circle)
// is marked with its own source id, so the rebuilt reply can find it on the
// copy.
//
// A flattened export never runs attach. There the mark stays behind, inert
// in Shiori's developer dictionary.

import { PDFDict, PDFName, PDFRef, PDFString, type PDFPage } from "pdf-lib";
import { pdfjsRefId } from "../import/sourceAnnotations";

const SHIO = PDFName.of("Shio");
const MARK = PDFName.of("Rebuild");
const ID = PDFName.of("Id");

export type RemovedAnnotation = { sourceIndex: number; inReplyTo: PDFRef | null };

/** The overlay id the importer gives the annotation at `ref` (importedAnnotationOverlayId). */
function overlayIdOf(sourceIndex: number, ref: PDFRef): string {
  return `pdf-annotation-${sourceIndex}-${pdfjsRefId(ref)}`;
}

/** Strip side: `removed` maps each deleted annotation's ref (as a string) to where it was. */
export function markKeptAnnotationLinks(
  page: PDFPage,
  sourceIndex: number,
  removed: Map<string, RemovedAnnotation>,
): void {
  const annots = page.node.Annots();
  if (!annots) return;
  const repliedTo = new Set<string>();
  for (const entry of removed.values()) {
    if (entry.inReplyTo) repliedTo.add(entry.inReplyTo.toString());
  }
  const ctx = page.doc.context;
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const mark = ctx.obj({});
    if (raw instanceof PDFRef && repliedTo.has(raw.toString())) {
      mark.set(ID, PDFString.of(overlayIdOf(sourceIndex, raw)));
    }
    if (mark.keys().length === 0) continue;
    let shio = dict.lookupMaybe(SHIO, PDFDict);
    if (!shio) {
      shio = ctx.obj({ V: 1 });
      dict.set(SHIO, shio);
    }
    shio.set(MARK, mark);
  }
}

export type KeptAnnotationLinks = {
  /** Kept annotations a rebuilt reply may answer, by the overlay id it names. */
  parents: Map<string, PDFRef>;
};

/** Attach side: read every mark on the copied page and remove it. */
export function takeKeptAnnotationLinks(page: PDFPage): KeptAnnotationLinks {
  const links: KeptAnnotationLinks = { parents: new Map() };
  const annots = page.node.Annots();
  if (!annots) return links;
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = annots.lookupMaybe(i, PDFDict);
    const shio = dict?.lookupMaybe(SHIO, PDFDict);
    const mark = shio?.lookupMaybe(MARK, PDFDict);
    if (!dict || !shio || !mark) continue;
    const id = mark.lookupMaybe(ID, PDFString)?.decodeText();
    if (id && raw instanceof PDFRef) links.parents.set(id, raw);
    shio.delete(MARK);
    if (shio.keys().every((key) => key === PDFName.of("V"))) dict.delete(SHIO);
  }
  return links;
}
