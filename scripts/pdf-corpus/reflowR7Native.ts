// Bounded R7 fixtures + four exact census pages; never runs the full corpus.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFDocument,PDFName} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {compareReflowNativePages} from './reflowOracle';
import {backdropReferencePdf} from './reflowBackdropRaster';
import {explainEvidence} from './evidenceGate';
import {type1RegionPage} from '../../src/pdf/export/contentText/reflowRegion.test-support';
import {overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {walkTextPlacements,type UnplacedShow} from '../../src/pdf/export/contentStreamEdit/textState';
import {sourceFingerprint} from '../../src/pdf/export/contentStreamEdit/replaceRun';
import {runResourceStamp} from '../../src/pdf/export/contentStreamEdit/resourceStamp';
import {traceReflowSource} from '../../src/pdf/export/contentText/reflowTrace';
import {streamInkResolver} from '../../src/pdf/export/contentText/reflowInk';
import {buildPageOccupancy} from '../../src/pdf/export/contentText/regionProof/occupancy';
import {contains} from '../../src/pdf/export/contentText/regionProof/geometry';
import {streamReflowEvidence} from '../../src/pdf/export/contentText/reflowEvidence';
import {planStreamReflow} from '../../src/pdf/export/contentText/reflowAuto';
import {compileReflowPlan} from '../../src/pdf/export/contentText/reflowCompile';
import {reflowManifest} from '../../src/pdf/export/contentText/reflowManifest';
import type {Rect} from '../../src/pdf/export/contentText/regionProof';

const directory='test-artifacts/reflow-r7',command='bun scripts/pdf-corpus/reflowR7Native.ts';
await mkdir(directory,{recursive:true});
await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nNative PDFium, 144 dpi. Three accepted edits with immutable analytic masks, exact outside-mask diff, and native text/origin/font/outline audit. Coloured backdrop reference uses only source-verified fill ops, for veto only. Four cached census pages are classified, not edited. No full corpus run.\n`);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so'),reports:unknown[]=[];
const row=(s:string,y:number)=>`BT /F1 10 Tf 14 TL 50 ${y} Td (${s}) Tj ET `;
const body=row('AB AB AB ',150)+row('AB AB AB ',136)+row('AB ',122);
async function raster(name:string,snapshot:ReturnType<typeof native.inspectPage>,mask?:readonly Rect[],before?:Uint8Array){
 const width=Math.round(snapshot.width*2),height=Math.round(snapshot.height*2),rgb=Buffer.alloc(width*height*3),marked=Buffer.alloc(width*height*3);
 assert(snapshot.pixels);
 for(let p=0,j=0;p<snapshot.pixels.length;p+=4,j+=3){
  rgb[j]=snapshot.pixels[p+2]!;rgb[j+1]=snapshot.pixels[p+1]!;rgb[j+2]=snapshot.pixels[p]!;
  const at=p/4,x=(at%width+.5)/2,y=(height-Math.floor(at/width)-.5)/2;
  const inside=mask?.some(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h);
  const changed=before&&!snapshot.pixels.subarray(p,p+4).every((v,i)=>v===before[p+i]);
  marked[j]=changed?255:0;marked[j+1]=inside?128:0;marked[j+2]=0;
 }
 const header=Buffer.from(`P6\n${width} ${height}\n255\n`);
 await writeFile(`${directory}/${name}.ppm`,Buffer.concat([header,rgb]));
 if(mask)await writeFile(`${directory}/${name}.mask-diff.ppm`,Buffer.concat([header,marked]));
}
try{
 for(const [name,stream,y]of [
  ['A-stroked-heading','q .456 w 2 Tr '+row('AB',180)+'Q '+body,122],
  ['B-coloured-backdrop','0 .235 .443 rg 0 0 300 200 re f 0 g '+body,122],
  ['C-column-capacity',row('AB ',150)+row('AB AB AB ',122)+row('AB AB AB ',94),150],
 ]as const){
  const f=await type1RegionPage(stream),s=inspectRunPage(f.page);assert(s.ok);
  const fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(s.bytes),target=name.startsWith('C')?ops.findIndex(o=>o.operator==='Tj'):ops.findLastIndex(o=>o.operator==='Tj');
  const e=streamReflowEvidence(f.page,s.bytes,fonts,target);assert(e.ok,e.ok?'':e.detail);
  assert.deepEqual(explainEvidence(f.page,s.bytes,fonts,target),{gate:'region-proved',detail:e.visualGroup.columnEvidence?`column=${JSON.stringify(e.visualGroup.columnEvidence)}`:undefined});
  const edit=overlay({originalText:'A',text:'AB AB',coverRects:[{x:49.95,y:y-.5,w:6.1,h:8}]}),before=await f.doc.save();
  const plan=planStreamReflow(f.page,s.bytes,fonts,edit);assert(plan?.reflow,'missing overflow plan');
  assert.equal(plan.reflow.layout.strategy,'suffix-shift');
  const mask=structuredClone(plan.reflow.proof.mask),manifest=reflowManifest(plan.reflow,e.walk.glyphs,fonts);
  const compiled=compileReflowPlan(s.bytes,fonts,plan);assert(compiled.ok,compiled.ok?'':compiled.reason);assert.deepEqual(plan.reflow.proof.mask,mask);
  f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.flateStream(compiled.bytes)));
  const after=await f.doc.save(),original=native.inspectPage(before,0,true),saved=native.inspectPage(after,0,true);
  const reference=await backdropReferencePdf(before,manifest),backdrop=reference?native.inspectPage(reference,0,true):undefined;
  const audit=compareReflowNativePages(original,saved,edit,manifest,backdrop);assert(audit.changedPixels>0);
  if(reference){
   await writeFile(`${directory}/${name}.backdrop.pdf`,reference);
   assert(backdrop?.glyphs.length===0,'reference contains text');
   await assert.rejects(()=>backdropReferencePdf(before,{...manifest,region:{...manifest.region,backdropOps:[target]}}));
   await assert.rejects(()=>backdropReferencePdf(before,{...manifest,sourceHash:'stale'}));
   const dirty=Uint8Array.from(original.pixels!);let at=-1;
   for(let p=0;p<dirty.length;p+=4){
    const i=p/4,x=(i%(original.width*2)+.5)/2,yy=(original.height*2-Math.floor(i/(original.width*2))-.5)/2;
    const inBox=(b:Rect)=>x>=b.x&&x<=b.x+b.w&&yy>=b.y&&yy<=b.y+b.h;
    if(mask!.some(inBox)&&!manifest.region.oldInk!.some(inBox)){at=p;break;}
   }
   assert(at>=0);dirty[at]=dirty[at]===0?1:dirty[at]!-1;
   assert.throws(()=>compareReflowNativePages({...original,pixels:dirty},saved,edit,manifest,backdrop),/raster veto/);
  }
  await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,after);
  await writeFile(`${directory}/${name}.manifest.json`,JSON.stringify(manifest,null,2));
  await raster(`${name}.before`,original);await raster(`${name}.after`,saved,mask,original.pixels);
  reports.push({name,passed:true,strategy:plan.reflow.layout.strategy,column:e.visualGroup.columnEvidence,...audit});
 }
 // The consult's M0 census is authoritative. These are bounded spot checks,
 // including both full-page JPEGs; this does not repeat the 71-page census.
 for(const [id,pageIndex,expected]of [['gsa-1',6,'unplaced'],['gsa-15',0,'backdrop'],['gsa-17',195,'image'],['gsa-17',292,'image']]as const){
  const doc=await PDFDocument.load(new Uint8Array(await readFile(`test-artifacts/pdf-corpus/cache/${id}.pdf`))),page=doc.getPage(pageIndex),s=inspectRunPage(page);assert(s.ok);
  const fonts=resolveRunFonts(page,{sourceReuse:true}),ops=tokenizeContentStream(s.bytes),environment=runPageEnvironment(page),sourceHash=sourceFingerprint(s.bytes),unplaced:UnplacedShow[]=[];
  const walk=walkTextPlacements(ops,{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:{ok:false,reason:'unmeasurable font'};},
   extGStateSetsFont:name=>environment.extGStates?.get(name)?.setsFont??null,onUnplaced:s=>unplaced.push(s)});assert(walk.ok);
  const trace=traceReflowSource(ops,fonts,sourceHash,environment),ink=streamInkResolver(page,fonts,{sourceReuse:true}),m=page.getMediaBox(),media={x:m.x,y:m.y,w:m.width,h:m.height};
  const occupancy=buildPageOccupancy({page,ops,fonts,trace,ink,glyphs:walk.glyphs,unplaced,sourceHash,dependencyHash:runResourceStamp(page),media});
  const blockers=occupancy.items.filter(o=>o.kind!=='backdrop'&&contains(o.box,media));
  assert.equal(occupancy.pageBlocked,expected==='image');
  assert(occupancy.items.some(o=>o.kind===expected));
  const name=`${id}-p${pageIndex}`,single=await PDFDocument.create();single.addPage((await single.copyPages(doc,[pageIndex]))[0]!);const bytes=await single.save();
  await writeFile(`${directory}/${name}.before.pdf`,bytes);await raster(`${name}.before`,native.inspectPage(bytes,0,true));
  reports.push({name,expected,passed:true,pageBlocked:occupancy.pageBlocked,blockers,
   unplacedReasons:[...new Set(unplaced.map(s=>s.reason))],backdrops:occupancy.items.filter(o=>o.kind==='backdrop')});
 }
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:true,reports},null,2));
 console.log(JSON.stringify({command,passed:true,reports},null,2));
}catch(error){
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:false,reports,error:String(error)},null,2));throw error;
}finally{native.close();}
