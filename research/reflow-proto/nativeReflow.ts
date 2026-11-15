// Regenerate: bun research/reflow-proto/nativeReflow.ts
// Synthetic explicit R1/R2 evidence; this is a saved-PDF backend check, not a
// claim that today's UI/corpus produces authoritative paragraph requests.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {PDFDocument,PDFName} from 'pdf-lib';
import {tinyType1,nums} from '../../src/pdf/export/fontCoverage/fixtures/type1';
import {reflowFixture} from '../../src/pdf/export/contentText/reflow.fixtures';
import {planContentText} from '../../src/pdf/export/contentText/planner';
import {compileReflowPlan} from '../../src/pdf/export/contentText/reflowCompile';
import {resolveRunFonts} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {runResourceStamp} from '../../src/pdf/export/contentStreamEdit/resourceStamp';
import {fontCoverageFromDict} from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import {openPdfium} from '../../scripts/pdf-inplace/nativePdfium';

const out=resolve('test-artifacts/reflow-native');await mkdir(out,{recursive:true});
const native=openPdfium(process.env.PDFIUM_LIBRARY??'/workspace/shiori-wt/pdf-inplace-ui/vendor/pdfium/linux-x64/lib/libpdfium.so');
const reports=[];
try{
 for(const [name,lefts,indent]of [['flush',[50,50,50],false],['first-line',[70,50,50],false],
  ['hanging',[30,50,50],false],['leading-tj-indent',[70,50,50],true]] as const){
  const fixture=reflowFixture([...lefts],indent,true),doc=await PDFDocument.create(),page=doc.addPage([600,800]);
  const entries=[...fixture.font.unicodeByCode],names=entries.map(([code,s])=>[code,`uni${s.codePointAt(0)!.toString(16).toUpperCase()}`] as const);
  const chars=Object.fromEntries(names.map(([code,name])=>[name,Uint8Array.from([
   ...nums(0,1000),13,...nums(100,0),21,...nums(400+code*5,0),5,...nums(0,800),5,...nums(-400-code*5,0),5,9,14])]));
  const program=tinyType1({glyphs:chars});
  const descriptor=doc.context.register(doc.context.obj({Type:'FontDescriptor',FontName:'Tiny',Flags:4,
   FontBBox:[0,-200,1000,800],ItalicAngle:0,Ascent:800,Descent:-200,CapHeight:800,StemV:80,
   FontFile:doc.context.register(doc.context.stream(program.program,{Length1:program.length1,Length2:program.length2,Length3:program.length3}))}));
  const font=doc.context.obj({Type:'Font',Subtype:'Type1',BaseFont:'Tiny',FirstChar:1,LastChar:entries.length,
   Widths:entries.map(()=>1000),Encoding:{Differences:names.flatMap(([code,name])=>[code,PDFName.of(name)])},FontDescriptor:descriptor,
   ToUnicode:doc.context.register(doc.context.stream(`${entries.length} beginbfchar\n${entries.map(([code,s])=>
    `<${code.toString(16).padStart(2,'0')}> <${s.codePointAt(0)!.toString(16)}>`).join('\n')}\nendbfchar`))});
  const fontRef=doc.context.register(font);
  page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:fontRef}}));
  page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(fixture.content)));
  const request=fixture.request,dependencyHash=runResourceStamp(page),objectId=fontRef.toString();
  request.dependencyHash=dependencyHash;request.paragraph.dependencyHash=dependencyHash;request.paragraph.evidence.dependencyHash=dependencyHash;
  const coverage=fontCoverageFromDict(font,{sourceReuse:true});
  request.target.fontObject=objectId;
  for(const line of request.paragraph.lines){line.anchor.fontObject=objectId;for(const show of line.shows){
   show.source.fontObject=objectId;show.before.fontObject=objectId;show.after.fontObject=objectId;
  }}
  for(const ink of request.sourceInk){ink.source.fontObject=objectId;const g=coverage.mappings?.get(
   (request.paragraph.ops[ink.source.opIndex]!.operator==='TJ'
    ?(request.paragraph.ops[ink.source.opIndex]!.operands[0] as {items:{bytes:Uint8Array}[]}).items[ink.source.itemIndex]!.bytes
    :(request.paragraph.ops[ink.source.opIndex]!.operands[0] as {bytes:Uint8Array}).bytes)[ink.source.byteStart]!.toString(16).padStart(2,'0'));
   assert(g);ink.glyph=g.glyph;
  }
  const fonts=resolveRunFonts(page,{sourceReuse:true});
  const off=planContentText(fixture.content,fonts,fixture.overlay);assert(off.ok);
  const refused=compileReflowPlan(fixture.content,fonts,off.plan);assert(!refused.ok);assert.equal(refused.code,'overflow');
  const planned=planContentText(fixture.content,fonts,fixture.overlay,{stage5Reflow:true,reflowRequest:request});
  assert(planned.ok,JSON.stringify(planned));assert(planned.plan.reflow);
  const compiled=compileReflowPlan(fixture.content,fonts,planned.plan);assert(compiled.ok,JSON.stringify(compiled));
  const beforePath=resolve(out,`${name}.before.pdf`),afterPath=resolve(out,`${name}.after.pdf`);
  await writeFile(beforePath,await doc.save());
  page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(compiled.bytes)));
  await writeFile(afterPath,await doc.save());
  const before=native.inspectPage(beforePath,0,true),after=native.inspectPage(afterPath,0,true);
  const actual=after.glyphs.filter(g=>g.text.trim()),layout=planned.plan.reflow.layout;
  const expected=[...planned.plan.reflow.clusters.map((t,i)=>({text:t.unicode,origin:layout.origins[i]!})),
   {text:'甲',origin:[50,658]},{text:'乙',origin:[60,658]}];
  assert.equal(actual.length,expected.length);
  let maxDriftPt=0;
  actual.forEach((g,i)=>{const e=expected[i]!;assert.equal(g.text,e.text);maxDriftPt=Math.max(maxDriftPt,Math.hypot(g.origin[0]-e.origin[0]!,g.origin[1]-e.origin[1]!));});
  assert(maxDriftPt<=.005,`native glyph drift ${maxDriftPt}`);
  assert(before.pixels&&after.pixels);assert.equal(before.pixels.length,after.pixels.length);
  let changedPixels=0,outside=0;const box=planned.plan.reflow.proof.box,width=1200,height=1600;
  for(let p=0;p<before.pixels.length;p+=4)if(!before.pixels.subarray(p,p+4).every((v,i)=>v===after.pixels![p+i])){
   changedPixels++;const at=p/4,x=(at%width+.5)/2,y=(height-Math.floor(at/width)-.5)/2;
   if(x<box.x||x>box.x+box.w||y<box.y||y>box.y+box.h)outside++;
  }
  assert(changedPixels>0);assert.equal(outside,0);
  const checked=spawnSync('qpdf',['--check',afterPath],{encoding:'utf8'});assert.equal(checked.status,0,checked.stderr);
  const extracted=spawnSync('pdftotext',['-layout',afterPath,'-'],{encoding:'utf8'});assert.equal(extracted.status,0,extracted.stderr);
  assert.equal(extracted.stdout.replace(/\s/gu,''),expected.map(t=>t.text).join(''));
  reports.push({name,strategy:layout.strategy,maxDriftPt,changedPixels,changedPixelsOutsideParagraph:outside,qpdf:'clean',poppler:'exact',passed:true});
 }
 await writeFile(resolve(out,'report.json'),JSON.stringify({command:'bun research/reflow-proto/nativeReflow.ts',reports},null,2));
 console.log(JSON.stringify(reports));
}finally{native.close();}
