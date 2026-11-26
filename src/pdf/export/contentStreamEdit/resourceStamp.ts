// Snapshot font and marked-content dependencies across asynchronous font work.
// Referenced dictionaries can change in place while Resources retains identity.
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, type PDFPage, type PDFObject } from 'pdf-lib';
import { sourceFingerprint } from './replaceRun';
type ResourceValue=string|number|ResourceValue[];
export function runResourceStamp(page: PDFPage): string {
  const resources=page.node.Resources();
  if (!resources) return '';
  const active=new Map<PDFObject,number>();
  function visit(value: PDFObject|undefined):ResourceValue {
    const refs=new Set<PDFRef>();
    while(value instanceof PDFRef){
      if(refs.has(value))return ['ref-cycle'];
      refs.add(value);value=page.doc.context.lookup(value);
    }
    if(!value)return ['missing'];
    const cycle=active.get(value);
    if(cycle!==undefined)return ['cycle',cycle];
    active.set(value,active.size);
    let result:ResourceValue;
    if(value instanceof PDFStream) {
      result=['stream',visit(value.dict),sourceFingerprint(value.getContents())];
    } else if(value instanceof PDFDict) {
      const entries=value.entries().sort(([a],[b])=>a.asString()<b.asString()?-1:a.asString()>b.asString()?1:0);
      result=['dict',...entries.map(([key,entry])=>[key.asString(),visit(entry)])];
    } else if(value instanceof PDFArray) {
      result=['array',...Array.from({length:value.size()},(_,i)=>visit(value.get(i)))];
    } else if(value instanceof PDFString||value instanceof PDFHexString) {
      result=['string',sourceFingerprint(value.asBytes())];
    } else result=['scalar',value.toString()];
    active.delete(value);
    return result;
  }
  const parts=['Font','Properties'].map(name=>[name,visit(resources.get(PDFName.of(name),true))]);
  return sourceFingerprint(new TextEncoder().encode(JSON.stringify(parts)));
}
