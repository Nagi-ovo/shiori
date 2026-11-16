// Bounded M2 fixtures only. Regenerate: bun scripts/pdf-corpus/reflowM2Native.ts
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {PDFName} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {compareReflowNativePages} from './reflowOracle';
import {type1RegionPage} from '../../src/pdf/export/contentText/reflowRegion.test-support';
import {overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {inspectRunPage,resolveRunFonts} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {streamReflowEvidence} from '../../src/pdf/export/contentText/reflowEvidence';
import {planStreamReflow} from '../../src/pdf/export/contentText/reflowAuto';
import {compileReflowPlan} from '../../src/pdf/export/contentText/reflowCompile';
import {reflowManifest} from '../../src/pdf/export/contentText/reflowManifest';

const directory='test-artifacts/pdf-stage5/reflow-m2',command='bun scripts/pdf-corpus/reflowM2Native.ts';
await mkdir(directory,{recursive:true});
await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nNative PDFium at 144 dpi. Masks are fixed before compilation; no raster grants empty space.\n`);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so'),reports:unknown[]=[];
const first='BT /F1 10 Tf 14 TL 50 150 Td (AB AB AB ) Tj ET ';
const row=(text:string,y=136)=>`BT /F1 10 Tf 14 TL 50 ${y} Td ${text} ET `;
const cases=[
 {name:'nearby-line',stream:first+row('(AB ) Tj')+row('(AB) Tj',127),x:50,accept:true},
 ...[0,3].map(rise=>({name:`prefix-rise-${rise}`,stream:first+row(`/F1 6 Tf 1 Tc ${rise} Ts (B) Tj /F1 10 Tf 0 Tc 0 Ts (AB ) Tj`),x:54.6,accept:true})),
 {name:'one-bt-paragraphs',stream:'BT /F1 10 Tf 14 TL 50 150 Td (AB AB AB ) Tj 0 -14 Td (AB ) Tj 0 -28 Td (AB AB AB ) Tj 0 -14 Td (AB ) Tj ET',x:50,accept:true},
 {name:'white-after-text',stream:first+row('(AB ) Tj')+'1 g 70 135 5 8 re f',x:50,accept:true},
 {name:'white-blocked-growth',stream:first+row('(AB ) Tj')+'1 g 70 0 5 143 re f',x:50,accept:false},
 {name:'moved-superscript',stream:first+row('(A) Tj /F1 6 Tf 3 Ts (B) Tj /F1 10 Tf 0 Ts ( AB ) Tj'),x:50,accept:false},
 {name:'occupied-growth',stream:first+row('(AB AB AB ) Tj')+'/Artifact BMC '+row('(AB) Tj',122)+' EMC',x:50,accept:false},
];
try{
 for(const c of cases){
  const f=await type1RegionPage(c.stream),s=inspectRunPage(f.page);assert(s.ok);
  const fonts=resolveRunFonts(f.page),edit=overlay({originalText:'A',text:'AB AB',coverRects:[{x:c.x-.05,y:135.5,w:6.1,h:8}]});
  const plan=planStreamReflow(f.page,s.bytes,fonts,edit),before=await f.doc.save();
  await writeFile(`${directory}/${c.name}.before.pdf`,before);
  if(!c.accept){assert.equal(plan,null,`${c.name}: unsafe plan admitted`);reports.push({name:c.name,passed:true,refused:true});continue;}
  assert(plan?.reflow,`${c.name}: missing plan`);
  const target=plan.edits.find(e=>e.opIndex===plan.reflow!.clusters.find(t=>!t.source)!.homeOp)!.opIndex;
  const evidence=streamReflowEvidence(f.page,s.bytes,fonts,target);assert(evidence.ok);
  const mask=structuredClone(plan.reflow.proof.mask);assert(mask?.length&&plan.reflow.proof.occupancyHash);
  const manifest=reflowManifest(plan.reflow,evidence.walk.glyphs,fonts);
  if(c.name==='white-after-text'){
   assert.equal(plan.reflow.layout.strategy,'wrap','white paint must force avoidance');
   assert.equal(plan.reflow.proof.lineSlots[0]!.right,69,'white paint was not an analytic occupant');
  }
  const compiled=compileReflowPlan(s.bytes,fonts,plan);assert(compiled.ok,compiled.ok?'':compiled.reason);
  assert.deepEqual(plan.reflow.proof.mask,mask,'compilation changed the mask');
  f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.flateStream(compiled.bytes)));
  const after=await f.doc.save();await writeFile(`${directory}/${c.name}.after.pdf`,after);
  const original=native.inspectPage(before,0,true),saved=native.inspectPage(after,0,true);
  const audit=compareReflowNativePages(original,saved,edit,manifest);
  assert(audit.changedPixels>0&&audit.changedPixelsOutsideMask===0);
  const width=Math.round(saved.width*2),height=Math.round(saved.height*2),rgb=Buffer.alloc(width*height*3);
  for(let i=0,j=0;i<saved.pixels!.length;i+=4,j+=3){rgb[j]=saved.pixels![i+2]!;rgb[j+1]=saved.pixels![i+1]!;rgb[j+2]=saved.pixels![i]!;}
  await writeFile(`${directory}/${c.name}.after.ppm`,Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),rgb]));
  reports.push({name:c.name,passed:true,strategy:plan.reflow.layout.strategy,occupancyHash:plan.reflow.proof.occupancyHash,mask,...audit});
 }
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:true,reports},null,2));
 console.log(JSON.stringify({command,passed:true,reports:reports.map(r=>{const {mask,...rest}=r as {mask?:unknown};void mask;return rest;})},null,2));
}catch(error){
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:false,reports,error:String(error)},null,2));throw error;
}finally{native.close();}
