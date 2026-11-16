import assert from 'node:assert/strict';
import {PDFDocument,PDFName} from 'pdf-lib';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {runResourceStamp} from '../../src/pdf/export/contentStreamEdit/resourceStamp';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {reflowScene} from '../../src/pdf/export/contentText/reflowScene';
import type {AppliedReflowManifest} from '../../src/pdf/export/contentText/reflowManifest';

/** Oracle-only reference. Re-run the production backdrop proof against the
 * exact original revision, then render only its approved fill ops, retaining
 * their original graphics state/resources. Images/forms/shadings, annotations
 * and other paint never enter this reference. No raster grants capacity. */
export async function backdropReferencePdf(before:Uint8Array,manifest:AppliedReflowManifest):Promise<Uint8Array|undefined>{
 const approved=manifest.region.backdropOps;if(!approved?.length)return;
 const doc=await PDFDocument.load(before),page=doc.getPage(0),source=inspectRunPage(page);
 assert(source.ok&&source.sourceHash===manifest.sourceHash,'raster veto: backdrop source revision differs');
 assert.equal(runResourceStamp(page),manifest.dependencyHash,'raster veto: backdrop dependency revision differs');
 const ops=tokenizeContentStream(source.bytes),m=page.getMediaBox(),actual:number[]=[];
 reflowScene(page,ops,{x:m.x,y:m.y,w:m.width,h:m.height},(_box,kind,op)=>{if(kind==='backdrop')actual.push(op);});
 assert.deepEqual(approved,actual,'raster veto: backdrop paint ops lack analytic proof');
 const paint=new Set(['S','s','f','F','f*','B','B*','b','b*']),keep=new Set([
  'q','Q','cm','w','J','j','M','d','ri','i','gs','CS','cs','SC','sc','SCN','scn','G','g','RG','rg','K','k',
  'm','l','c','v','y','h','re','W','W*','n','BMC','BDC','EMC','MP','DP',
 ]),selected=new Set(approved),chunks:Uint8Array[]=[];
 const encoder=new TextEncoder();
 for(const [i,op]of ops.entries()){
  if(selected.has(i)||keep.has(op.operator))chunks.push(source.bytes.slice(op.start,op.end));
  else if(paint.has(op.operator))chunks.push(encoder.encode('n'));
  chunks.push(encoder.encode('\n'));
 }
 page.node.delete(PDFName.of('Annots'));
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(Buffer.concat(chunks))));
 return doc.save();
}
