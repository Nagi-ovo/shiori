import {
  PDFArray,
  PDFDict,
  PDFRef,
  PDFStream,
  PDFStreamWriter,
  PDFWriter,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";

/** Save only the objects reachable after rewriting source content. */
export async function saveReachablePdf(
  document: PDFDocument,
  useObjectStreams: boolean,
): Promise<Uint8Array> {
  // Rebuild has installed the pages and copied form appearances as raw PDF
  // objects. It never opens getForm(), so PDFDocument.save() would find no
  // cached form to update. Flush lazy embeds before marking, then use the
  // same writers and yield interval as PDFDocument.save().
  await document.flush();
  const { context } = document;
  const pending = Object.values(context.trailerInfo).filter(
    (object): object is PDFObject => object !== undefined,
  );
  const seen = new Set<PDFObject>();

  while (pending.length > 0) {
    const object = pending.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);

    if (object instanceof PDFRef) {
      const target = context.lookup(object);
      if (target) pending.push(target);
    } else if (object instanceof PDFStream) {
      // The writers replace /Length with a direct number. Apply that change
      // now so a former indirect length does not keep an object alive.
      object.updateDict();
      pending.push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) pending.push(value);
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) pending.push(value);
    }
  }

  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(ref)) context.delete(ref);
  }

  const Writer = useObjectStreams ? PDFStreamWriter : PDFWriter;
  return Writer.forContext(context, 50).serializeToBuffer();
}
