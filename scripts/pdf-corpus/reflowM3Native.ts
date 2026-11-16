// Bounded M3 fixtures only. Regenerate: bun scripts/pdf-corpus/reflowM3Native.ts
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
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {saveReflowVetoArtifact} from './reflowVetoArtifact';

const directory='test-artifacts/pdf-stage5/reflow-m3',command='bun scripts/pdf-corpus/reflowM3Native.ts';
await mkdir(directory,{recursive:true});
await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nNative PDFium at 144 dpi. Original-raster veto and 0 changed pixels outside box/mask. Masks fixed before compile.\n`);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so'),reports:unknown[]=[];
try{
 for(const translated of [false,true]){
  const rows=['AB AB AB ','AB AB ','AB '],name=translated?'ragged-translated-bts':'ragged-observed-pitch';
  const stream=rows.map((s,i)=>`q ${translated?`1 0 0 1 ${3*i} ${2*i} cm`:''} /P <</MCID ${i}>> BDC BT /F1 10 Tf 0 TL ${50-(translated?3*i:0)} ${150-14*i-(translated?2*i:0)} Td (${s}) Tj ET EMC Q`).join(' ');
  const f=await type1RegionPage(stream),s=inspectRunPage(f.page);assert(s.ok);
  const fonts=resolveRunFonts(f.page),target=tokenizeContentStream(s.bytes).findIndex(o=>o.operator==='Tj');
  const edit=overlay({originalText:'A',text:'AB AB AB',coverRects:[{x:49.95,y:149.5,w:6.1,h:8}]});
  const before=await f.doc.save();await writeFile(`${directory}/${name}.before.pdf`,before);
  const e=streamReflowEvidence(f.page,s.bytes,fonts,target);assert(e.ok,e.ok?'':e.detail);
  const plan=planStreamReflow(f.page,s.bytes,fonts,edit);assert(plan?.reflow,'missing ragged wrap');assert.equal(plan.reflow.layout.strategy,'wrap');
  assert(plan.reflow.proof.lineSlots.every(s=>s.right===95),'capacity borrowed a gutter');
  const mask=structuredClone(plan.reflow.proof.mask),manifest=reflowManifest(plan.reflow,e.walk.glyphs,fonts);
  await writeFile(`${directory}/${name}.manifest.json`,JSON.stringify(manifest,null,2));
  const compiled=compileReflowPlan(s.bytes,fonts,plan);assert(compiled.ok,compiled.ok?'':compiled.reason);
  assert.deepEqual(plan.reflow.proof.mask,mask,'compiler changed mask');
  f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.flateStream(compiled.bytes)));
  const after=await f.doc.save();await writeFile(`${directory}/${name}.after.pdf`,after);
  const original=native.inspectPage(before,0,true),saved=native.inspectPage(after,0,true);
  const audit=compareReflowNativePages(original,saved,edit,manifest);assert(audit.changedPixels>0);
  const width=Math.round(original.width*2),height=Math.round(original.height*2);
  for(const [suffix,snapshot]of [['before',original],['after',saved]] as const){
   const rgb=Buffer.alloc(width*height*3);
   for(let p=0,j=0;p<snapshot.pixels!.length;p+=4,j+=3){rgb[j]=snapshot.pixels![p+2]!;rgb[j+1]=snapshot.pixels![p+1]!;rgb[j+2]=snapshot.pixels![p]!;}
   await writeFile(`${directory}/${name}.${suffix}.ppm`,Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),rgb]));
  }
  reports.push({name,passed:true,strategy:plan.reflow.layout.strategy,...audit});
  if(!translated){
   // Simulate paint missed by the analytic scene without changing the fixed
   // mask. Put a half-point black square in newly occupied (not old) ink.
   const inBoxes=(x:number,y:number,boxes:typeof mask)=>boxes!.some(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h);
   let point:{x:number;y:number}|undefined;
   for(let y=0;y<height&&!point;y++)for(let x=0;x<width;x++){
    const px=(x+.5)/2,py=(height-y-.5)/2;
    if(inBoxes(px,py,mask)&&!inBoxes(px,py,manifest.region.oldInk)){point={x:px,y:py};break;}
   }
   assert(point,'fixture has no newly occupied pixel');
   const paint=`q 0 g ${point.x-.25} ${point.y-.25} .5 .5 re f Q`;
   const mutate=async(content:Uint8Array)=>{
    const bytes=Uint8Array.from([...content,...new TextEncoder().encode(` ${paint}`)]);
    f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.flateStream(bytes)));return f.doc.save();
   };
   const dirtyBefore=await mutate(s.bytes),dirtyAfter=await mutate(compiled.bytes);
   let veto:unknown;
   try{compareReflowNativePages(native.inspectPage(dirtyBefore,0,true),native.inspectPage(dirtyAfter,0,true),edit,manifest);}
   catch(error){if(error instanceof Error&&error.message.includes('raster veto'))veto=error;else throw error;}
   assert(veto,'native missed paint did not veto');assert.deepEqual(plan.reflow.proof.mask,mask,'veto widened mask');
   const artifact=await saveReflowVetoArtifact({name:'m3-missed-paint',before:dirtyBefore,after:dirtyAfter,edit,manifest,error:veto});
   reports.push({name:'missed-paint-veto',passed:true,vetoed:true,artifact,error:String(veto)});
  }
 }
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:true,reports},null,2));
 console.log(JSON.stringify({command,passed:true,reports},null,2));
}catch(error){
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:false,reports,error:String(error)},null,2));throw error;
}finally{native.close();}
