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
// - A kept annotation that a removed one replied to (a Text reply on a
//   Circle) is marked with its own source id, so the rebuilt reply can find
//   it on the copy.
// - A kept annotation that replies to a removed one (Acrobat's Replace Text:
//   a Caret grouped to a StrikeOut) loses /IRT and /RT at once, since the
//   object they name is deleted, and the mark remembers them so attach can
//   point them at the rebuilt annotation.
//
// A flattened export never runs attach. There the mark stays behind, inert
// in Shiori's developer dictionary, but no kept annotation names an object
// that no longer exists.

import { PDFDict, PDFName, PDFRef, PDFString, type PDFObject, type PDFPage } from "pdf-lib";
import { pdfjsRefId } from "../import/sourceAnnotations";

const SHIO = PDFName.of("Shio");
const MARK = PDFName.of("Rebuild");
const ID = PDFName.of("Id");
const IRT = PDFName.of("IRT");
const RT = PDFName.of("RT");

export type RemovedAnnotation = { sourceIndex: number; inReplyTo: PDFRef | null };

/** The overlay id the importer gives the annotation at `ref` (importedAnnotationOverlayId). */
function overlayIdOf(sourceIndex: number, ref: PDFRef): string {
  return `pdf-annotation-${sourceIndex}-${pdfjsRefId(ref)}`;
}

/**
 * Strip side: `removed` maps each deleted annotation's ref (as a string) to
 * where it was. Clears every mark already on the page first: one left by an
 * earlier flattened export names object numbers from a different file.
 */
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
    clearMark(dict);
    const mark = ctx.obj({});
    if (raw instanceof PDFRef && repliedTo.has(raw.toString())) {
      mark.set(ID, PDFString.of(overlayIdOf(sourceIndex, raw)));
    }
    const irt = dict.get(IRT);
    const target = irt instanceof PDFRef ? removed.get(irt.toString()) : undefined;
    if (irt instanceof PDFRef && target) {
      mark.set(IRT, PDFString.of(overlayIdOf(target.sourceIndex, irt)));
      const type = dict.get(RT);
      if (type) mark.set(RT, type);
      dict.delete(IRT);
      dict.delete(RT);
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
  /** Kept replies waiting for the rebuilt annotation they answer. */
  replies: Array<{ dict: PDFDict; target: string; type: PDFObject | undefined }>;
};

type TakenMark = { id?: string; target?: string; type: PDFObject | undefined };

// Copies of a duplicated source page share their kept annotation objects, so
// the page attach reaches first takes the mark off for all of them. What it
// read is kept here for the copies after it, whatever order they come in.
const takenMarks = new WeakMap<PDFDict, TakenMark>();

/** Attach side: read every mark on the copied page and remove it. */
export function takeKeptAnnotationLinks(page: PDFPage): KeptAnnotationLinks {
  const links: KeptAnnotationLinks = { parents: new Map(), replies: [] };
  const annots = page.node.Annots();
  if (!annots) return links;
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const taken = takenMarks.get(dict) ?? takeMark(dict);
    if (!taken) continue;
    if (taken.id && raw instanceof PDFRef) links.parents.set(taken.id, raw);
    if (taken.target) links.replies.push({ dict, target: taken.target, type: taken.type });
  }
  return links;
}

function takeMark(dict: PDFDict): TakenMark | undefined {
  const mark = dict.lookupMaybe(SHIO, PDFDict)?.lookupMaybe(MARK, PDFDict);
  if (!mark) return undefined;
  const taken: TakenMark = {
    id: mark.lookupMaybe(ID, PDFString)?.decodeText(),
    target: mark.lookupMaybe(IRT, PDFString)?.decodeText(),
    type: mark.get(RT),
  };
  takenMarks.set(dict, taken);
  clearMark(dict);
  return taken;
}

function clearMark(dict: PDFDict): void {
  const shio = dict.lookupMaybe(SHIO, PDFDict);
  if (!shio?.has(MARK)) return;
  shio.delete(MARK);
  if (shio.keys().every((key) => key === PDFName.of("V"))) dict.delete(SHIO);
}

/** Points each kept reply at its rebuilt parent; one whose parent is gone stays unlinked. */
export function relinkKeptReplies(
  replies: KeptAnnotationLinks["replies"],
  refsByOverlayId: Map<string, PDFRef>,
): void {
  for (const reply of replies) {
    const parent = refsByOverlayId.get(reply.target);
    if (!parent) continue;
    reply.dict.set(IRT, parent);
    if (reply.type) reply.dict.set(RT, reply.type);
  }
}
