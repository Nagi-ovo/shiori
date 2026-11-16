// Bounded M1 fixtures only. Regenerate: bun scripts/pdf-corpus/reflowM1Native.ts
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {PDFName} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {compareReflowNativePages} from './reflowOracle';
import {type1RegionPage} from '../../src/pdf/export/contentText/reflowRegion.test-support';
import {mcidCodes,readSlots} from '../../src/pdf/export/contentText/reflowSlots.test-support';
import {overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {inspectRunPage,resolveRunFonts} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {streamReflowEvidence} from '../../src/pdf/export/contentText/reflowEvidence';
import {planStreamReflow} from '../../src/pdf/export/contentText/reflowAuto';
import {compileReflowPlan} from '../../src/pdf/export/contentText/reflowCompile';
import {reflowManifest} from '../../src/pdf/export/contentText/reflowManifest';

const directory='test-artifacts/pdf-stage5/reflow-m1',command='bun scripts/pdf-corpus/reflowM1Native.ts';
await mkdir(directory,{recursive:true});await writeFile(`${directory}/README.md`,`Regenerate: ${command}\n144 dpi native PDFium; BGRA raster saved as RGB PPM.\n`);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so');
const reports:unknown[]=[];
try{
 for(const blue of [false,true]){
  const rows=['AB AB AB ','AB AB AB ','AB '];
  const stream=rows.map((s,i)=>`q /P <</MCID ${i}>> BDC /Span BMC BT 0 g 0 G ${blue&&i===1?'0 0 1 rg':''} /F1 10 Tf 14 TL 50 ${150-i*14} Td (${s}) Tj ET EMC EMC Q`).join(' ');
  const f=await type1RegionPage(stream),s=inspectRunPage(f.page);assert(s.ok);
  const fonts=resolveRunFonts(f.page),target=readSlots(s.bytes).shows[1]!.op;
  const edit=overlay({originalText:'A',text:'AB AB',coverRects:[{x:49.9,y:134,w:6.2,h:12}]});
  const evidence=streamReflowEvidence(f.page,s.bytes,fonts,target);assert(evidence.ok);
  const plan=planStreamReflow(f.page,s.bytes,fonts,edit);assert(plan?.reflow,'missing native colour plan');
  const manifest=reflowManifest(plan.reflow,evidence.walk.glyphs,fonts);
  const result=compileReflowPlan(s.bytes,fonts,plan);assert(result.ok,result.ok?'':result.reason);
  const expected=mcidCodes(s.bytes);expected[1]=[...rows[1]!.replace('A','AB AB')].map(c=>c.charCodeAt(0));
  assert.deepEqual(mcidCodes(result.bytes),expected);
  const before=await f.doc.save();f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.flateStream(result.bytes)));
  const after=await f.doc.save(),name=blue?'blue-bt2':'black-bts';
  await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,after);
  const original=native.inspectPage(before,0,true),saved=native.inspectPage(after,0,true);
  const audit=compareReflowNativePages(original,saved,edit,manifest);
  const width=Math.round(saved.width*2),height=Math.round(saved.height*2),rgb=Buffer.alloc(width*height*3);
  for(let i=0,j=0;i<saved.pixels!.length;i+=4,j+=3){rgb[j]=saved.pixels![i+2]!;rgb[j+1]=saved.pixels![i+1]!;rgb[j+2]=saved.pixels![i]!;}
  await writeFile(`${directory}/${name}.after.ppm`,Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),rgb]));
  const moved=plan.reflow.clusters.flatMap((c,i)=>(c.source?.opIndex??c.homeOp)===target&&c.unicode.trim()&&plan.reflow!.layout.origins[i]![1]!==136?
   [{unicode:c.unicode,origin:plan.reflow!.layout.origins[i]!}]:[]);
  assert(moved.length,'fixture did not move any MCID 1 glyph to another baseline');
  let movedInk=0;
  for(const g of moved){
   const glyph=saved.glyphs.find(n=>n.text===g.unicode&&Math.hypot(n.origin[0]-g.origin[0]!,n.origin[1]-g.origin[1]!)<.005);assert(glyph);
   const [l,b,r,t]=glyph.box;let ink=0;
   for(let y=Math.max(0,Math.floor((saved.height-t)*2));y<Math.min(height,Math.ceil((saved.height-b)*2));y++)
    for(let x=Math.max(0,Math.floor(l*2));x<Math.min(width,Math.ceil(r*2));x++){
     const p=(y*width+x)*4,[B,G,R]=saved.pixels!.subarray(p,p+3);
     if(Math.min(B!,G!,R!)>=250)continue;
     if(blue){assert(B!>R!+5&&B!>G!+5,'moved glyph lost blue fill');}
     else assert(Math.max(B!,G!,R!)-Math.min(B!,G!,R!)<=1,'moved glyph lost black fill');
     ink++;
    }
   assert(ink>0,'moved glyph has no rendered colour evidence');movedInk+=ink;
  }
  reports.push({name,passed:true,strategy:plan.reflow.layout.strategy,mcidCodes:expected,movedGlyphs:moved,movedInkPixels:movedInk,...audit});
 }
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:true,reports},null,2));
 console.log(JSON.stringify({command,passed:true,reports},null,2));
}catch(error){
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:false,reports,error:String(error)},null,2));throw error;
}finally{native.close();}
