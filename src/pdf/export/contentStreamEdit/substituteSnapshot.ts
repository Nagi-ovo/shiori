import {PDFArray,PDFDict,PDFName,PDFRef,PDFStream,type PDFObject,type PDFPage} from 'pdf-lib';
import {runResourceStamp} from './resourceStamp';
import {sourceFingerprint} from './replaceRun';
/** The reuse stamp covers fonts and properties. Substitution also snapshots
 * inherited graphics state across asynchronous font loading. */
export function substitutionStamp(page:PDFPage):string{
 const parts=[runResourceStamp(page),page.node.toString()],seen=new Set<PDFObject>();
 function visit(value:PDFObject){
  if(seen.has(value))return;seen.add(value);
  if(value instanceof PDFRef){parts.push(value.toString());const target=page.doc.context.lookup(value);if(target)visit(target);}
  else if(value instanceof PDFStream){visit(value.dict);parts.push(sourceFingerprint(value.getContents()));}
  else if(value instanceof PDFDict){parts.push(value.toString());for(const [,entry]of value.entries())visit(entry);}
  else if(value instanceof PDFArray){for(let i=0;i<value.size();i++)visit(value.get(i));}
  else parts.push(value.toString());
 }
 const state=page.node.Resources()?.get(PDFName.of('ExtGState'));if(state)visit(state);
 return sourceFingerprint(new TextEncoder().encode(parts.join('\n')));
}
