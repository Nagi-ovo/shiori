// Bounded source-ink regression, never the full corpus.
// Regenerate: bun scripts/pdf-corpus/fixP1InkNative.ts
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFName} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {compareSubstitutedNativePages} from './oracle';
import {applyContentTextEdits} from '../../src/pdf/export/contentText/apply';
import {acceptsSourceInk,sourceInkCases,sourceInkFixture} from '../../src/pdf/export/contentText/substituteInk.test-support';

const directory='test-artifacts/fix-p1-ink',command='bun scripts/pdf-corpus/fixP1InkNative.ts';
await mkdir(directory,{recursive:true});await writeFile(`${directory}/README.md`,`Regenerate: ${command}\n`);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so');
const reports=[];
try{
 for(const name of sourceInkCases){
  const f=await sourceInkFixture(name),beforeBytes=await f.doc.save(),resources=f.page.node.Resources(),contents=f.page.node.get(PDFName.of('Contents'));
  const count=f.doc.context.enumerateIndirectObjects().length;
  const result=await applyContentTextEdits(f.page,[f.edit],{stage5Reflow:false,stage5Type1:{sourceReuse:false},loadFont:font=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${font}`)});
  const afterBytes=await f.doc.save(),before=native.inspectPage(beforeBytes,0,true),after=native.inspectPage(afterBytes,0,true);
  await writeFile(`${directory}/${name}.before.pdf`,beforeBytes);await writeFile(`${directory}/${name}.after.pdf`,afterBytes);
  await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({edit:f.edit,outcome:result.outcomes[0]},null,2));
  const width=Math.round(before.width*2),height=Math.round(before.height*2);let changedPixels=0,changedPixelsOutsideCover=0,sourceInkOutsideCoverPixels=0;
  assert(before.pixels&&after.pixels);assert.equal(before.pixels.length,after.pixels.length);
  for(let offset=0;offset<before.pixels.length;offset+=4){
   const p=offset/4,x=(p%width+.5)/2,y=(height-Math.floor(p/width)-.5)/2;
   const outside=!f.edit.coverRects.some(r=>x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h);
   if(outside&&Math.min(before.pixels[offset]!,before.pixels[offset+1]!,before.pixels[offset+2]!)<250)sourceInkOutsideCoverPixels++;
   if(before.pixels.subarray(offset,offset+4).every((value,i)=>value===after.pixels![offset+i]))continue;
   changedPixels++;if(outside)changedPixelsOutsideCover++;
  }
  let error:string|undefined;
  try{
   if(name==='width-only-overhang')assert(sourceInkOutsideCoverPixels>0,'width-only fixture must paint beyond the cover');
   if(acceptsSourceInk(name)){
    assert.equal(result.outcomes[0]?.mode,'substituted');
    compareSubstitutedNativePages(before,after,f.edit);assert(changedPixels>0);
   }else{
    assert.equal(result.outcomes[0]?.mode,'overlay');assert.equal(result.outcomes[0]?.reason,'overflow');
    assert.equal(f.page.node.Resources(),resources);assert.equal(f.page.node.get(PDFName.of('Contents')),contents);
    assert.equal(f.doc.context.enumerateIndirectObjects().length,count);assert.equal(changedPixels,0);
    assert.equal(after.text,before.text);
   }
   assert.equal(changedPixelsOutsideCover,0);
  }catch(cause){error=String(cause);}
  reports.push({name,outcome:result.outcomes[0],sourceInkOutsideCoverPixels,changedPixels,changedPixelsOutsideCover,passed:!error,error});
 }
}finally{native.close();await writeFile(`${directory}/report.json`,JSON.stringify({command,reports},null,2));}
console.log(JSON.stringify(reports,null,2));assert(reports.every(r=>r.passed),'source ink native regression failed');
