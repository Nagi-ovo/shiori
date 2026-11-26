import { PDFBool, PDFName, PDFStream } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import { contentParts, decodedContent } from './content';
import { asDict, entry, value } from './pdfValues';

export function hasStructure(doc: PDFDocument): boolean {
  const marks = asDict(value(doc.catalog, 'MarkInfo'));
  return !!entry(doc.catalog, 'StructTreeRoot') || (!!marks && value(marks, 'Marked') === PDFBool.True);
}

/** Cheap trigger for untagged pages, including Forms. Font programs and
 * image data cannot contain page marked-content operators. */
export function mayHaveMarks(page: PDFPage): boolean {
  const visited = new Set<PDFStream>();
  const read = (stream: PDFStream) => {
    try {
      return /\b(?:BMC|BDC|EMC)\b/.test(new TextDecoder('latin1').decode(decodedContent(stream)));
    } catch {
      return true;
    }
  };
  const inspect = (resources: ReturnType<typeof asDict>, depth: number): boolean => {
    const objects = resources && asDict(value(resources, 'XObject'));
    if (!objects) return false;
    for (const [, ref] of objects.entries()) {
      const stream = objects.context.lookup(ref);
      if (!(stream instanceof PDFStream) || visited.has(stream)) continue;
      visited.add(stream);
      if (entry(stream.dict, 'StructParent') || entry(stream.dict, 'StructParents')) return true;
      if (value(stream.dict, 'Subtype') !== PDFName.of('Form')) continue;
      if (depth >= 64 || read(stream) || inspect(asDict(value(stream.dict, 'Resources')), depth + 1)) return true;
    }
    return false;
  };
  const parts = contentParts(page.node);
  return !parts || parts.some(read) ||
    inspect(asDict(page.doc.context.lookup(page.node.getInheritableAttribute(PDFName.of('Resources')))), 0);
}
