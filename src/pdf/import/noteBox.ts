import { PDFArray, PDFDict, PDFName, PDFNumber } from "pdf-lib";

/**
 * A turned sticky note's box and angle, as Shiori's export writes them in
 * /Shio /Note (src/pdf/export/markupAnnotations.ts): the note exports as an
 * icon at the box's top-left corner, which no viewer turns. PDF user space,
 * degrees clockwise about the box centre.
 */
export type NoteBox = { x: number; y: number; w: number; h: number; angle: number };

export const NOTE_BOX_KEY = "Note";

/** The /Shio /Note box of a Text annotation, or undefined when it has none or a malformed one. */
export function shioNoteBox(dict: PDFDict): NoteBox | undefined {
  const shio = dict.lookup(PDFName.of("Shio"));
  const note = shio instanceof PDFDict ? shio.lookup(PDFName.of(NOTE_BOX_KEY)) : undefined;
  if (!(note instanceof PDFDict)) return undefined;
  const rect = note.lookup(PDFName.of("Rect"));
  const angle = note.lookup(PDFName.of("Angle"));
  if (!(rect instanceof PDFArray) || rect.size() !== 4 || !(angle instanceof PDFNumber)) return undefined;
  const [x, y, w, h] = rect.asArray().map((_, i) => {
    const value = rect.lookup(i);
    return value instanceof PDFNumber ? value.asNumber() : NaN;
  }) as [number, number, number, number];
  const box = { x, y, w, h, angle: angle.asNumber() };
  return Object.values(box).every(Number.isFinite) && w > 0 && h > 0 ? box : undefined;
}

/**
 * `box` when the note's icon `rect` still sits at its top-left corner. A note
 * moved or resized in another reader since has a box that no longer says
 * where it is, and comes back as the icon alone.
 */
export function noteBoxAtIcon(
  box: NoteBox | undefined,
  rect: { x: number; y: number; w: number; h: number },
): NoteBox | undefined {
  if (!box) return undefined;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  return near(box.x, rect.x) && near(box.y + box.h, rect.y + rect.h) ? box : undefined;
}
