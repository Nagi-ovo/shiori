// Snapshot font and marked-content dependencies across asynchronous font work.
// Referenced dictionaries can change in place while Resources retains identity.
import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFPage, type PDFObject } from 'pdf-lib';
import { sourceFingerprint } from './replaceRun';
export function runResourceStamp(page: PDFPage): string {
  const resources=page.node.Resources();
  if (!resources) return '';
  const parts=[resources.toString()],seen=new Set<PDFObject>();
  function visit(value: PDFObject) {
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof PDFRef) {
      parts.push(value.toString()); const resolved=page.doc.context.lookup(value);
      if(resolved)visit(resolved);
    } else if(value instanceof PDFStream) {
      visit(value.dict);parts.push(sourceFingerprint(value.getContents()));
    } else if(value instanceof PDFDict) {
      parts.push(value.toString());for(const [,entry] of value.entries())visit(entry);
    } else if(value instanceof PDFArray) {
      for(let i=0;i<value.size();i++)visit(value.get(i));
    } else parts.push(value.toString());
  }
  for(const [name,value]of resources.entries())if(['Font','Properties'].includes(name.decodeText()))visit(value);
  return sourceFingerprint(new TextEncoder().encode(parts.join('\n')));
}
