import {PDFArray,PDFDict,PDFName,PDFRawStream,PDFRef,PDFStream,type PDFObject,type PDFPage} from 'pdf-lib';
import {sourceFingerprint} from '../contentStreamEdit/replaceRun';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {pdfName} from '../contentStreamEdit/runEncoding';
import type {RetypesetStream} from './retypesetForms';

/** Snapshot the full resource graph, including nested form bytes and font
 * dictionaries, across async font loading. Never follow a page's Parent. */
export function retypesetFormStamp(page:PDFPage){
 const parts:string[]=[],seen=new Map<PDFObject,number>();
 const visit=(v:PDFObject)=>{
  const prior=seen.get(v);if(prior!==undefined){parts.push(`seen:${prior}`);return;}seen.set(v,seen.size);
  if(v instanceof PDFRef){parts.push(v.toString());const value=page.doc.context.lookup(v);if(value)visit(value);}
  else if(v instanceof PDFStream){visit(v.dict);parts.push(sourceFingerprint(v.getContents()));}
  else if(v instanceof PDFDict){for(const [k,value]of v.entries()){parts.push(k.toString());visit(value);}}
  else if(v instanceof PDFArray){for(const value of v.asArray())visit(value);}
  else parts.push(v.toString());
 };
 for(const [key,value]of page.node.entries())if(key!==PDFName.of('Parent')){parts.push(key.toString());visit(value);}
 const resources=page.node.Resources();if(resources)visit(resources);
 return sourceFingerprint(new TextEncoder().encode(parts.join('\n')));
}
/** Always CoW, including every ancestor on a nested path. New resource names
 * rewrite only the selected Do occurrence. Untouched references stay shared. */
export function installRetypesetForms(page:PDFPage,root:RetypesetStream){
 const compile=(node:RetypesetStream):PDFRef|undefined=>{
  const children=node.children.flatMap(child=>{const ref=compile(child);return ref?[{child,ref}]:[];});
  if(!node.changed&&!children.length)return;
  const stream=inspectRunPage(node.page);if(!stream.ok)throw Error(stream.reason);
  let bytes=stream.bytes,resources=node.page.node.Resources()!;
  if(children.length){
   resources=resources.clone();const objects=resources.lookupMaybe(PDFName.of('XObject'),PDFDict)?.clone()??page.doc.context.obj({});
   // Text rewrites add show operators but never add/remove/reorder Do uses.
   const uses=tokenizeContentStream(bytes).filter(o=>o.operator==='Do'),patches=children.map(({child,ref})=>{
    const op=uses[child.useIndex!];if(!op)throw Error('Form Do occurrence lost during write');
    let n=1;while(objects.has(PDFName.of(`ShioriFm${n}`)))n++;
    const name=`ShioriFm${n}`;objects.set(PDFName.of(name),ref);return{...op,body:new TextEncoder().encode(`${pdfName(name)} Do`)};
   }).sort((a,b)=>a.start-b.start);
   const chunks:Uint8Array[]=[];let at=0;
   for(const p of patches){chunks.push(bytes.subarray(at,p.start),p.body);at=p.end;}chunks.push(bytes.subarray(at));
   bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
   resources.set(PDFName.of('XObject'),objects);
  }
  if(node.raw){
   const dict=node.raw.dict.clone();for(const k of ['Filter','DecodeParms','Length'])dict.delete(PDFName.of(k));
   dict.set(PDFName.of('Resources'),resources);
   return page.doc.context.register(PDFRawStream.of(dict,bytes));
  }
  // Only this final synchronous swap mutates the real page.
  const ref=page.doc.context.register(page.doc.context.flateStream(bytes));
  page.node.set(PDFName.of('Resources'),resources);page.node.set(PDFName.of('Contents'),ref);
 };
 compile(root);
}
