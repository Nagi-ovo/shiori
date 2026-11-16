import {expect,test} from 'bun:test';
import {PDFDict,PDFName,PDFRawStream,decodePDFRawStream,type PDFPage} from 'pdf-lib';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixture,overlay} from './fixtures.test-support';
import {applyContentTextEdits} from './apply';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {readRetypesetSource} from './retypesetSource';
import {planRetypeset,selectRetypeset} from './retypesetPlan';
import {writeRetypeset} from './retypesetWrite';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';

// Failure list recorded first in STATUS.md. Saved native evidence checks actual
// translations, fixed outsiders, and private occurrence/resource installation.
const title='BT /F1 20 Tf 24 TL 50 150 Td (ABCDEFGHIJ) Tj ET ';
const following='BT /F1 10 Tf 55 120 Td [(Release) -100 (2.0)] TJ ET ';
const shape='0.4 g 80 90 30 6 re f ';
const loadFont=(name:string)=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const edit=()=>overlay({text:'ABCDEFGHIJK',originalText:'ABCDEFGHIJ',coverRects:[{x:49,y:147,w:122,h:24}]});
async function form(body=title+following+shape,pageStream='/Fm Do'){
 const f=await fixture(pageStream),resources=f.page.node.Resources()!.clone();
 const raw=f.doc.context.stream(body,{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:resources}),ref=f.doc.context.register(raw);
 f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Fm:ref}));
 return {...f,raw,ref};
}
const decode=(s:PDFRawStream)=>new TextDecoder().decode(s.dict.has(PDFName.of('Filter'))?decodePDFRawStream(s).decode():s.getContents());
function usedForm(page:PDFPage){
 const s=inspectRunPage(page);if(!s.ok)throw Error(s.reason);
 const name=tokenizeContentStream(s.bytes).find(o=>o.operator==='Do')!.operands[0]!;if(name.kind!=='name')throw Error('no form');
 return page.node.Resources()!.lookup(PDFName.of('XObject'),PDFDict).lookup(PDFName.of(name.value),PDFRawStream);
}
async function apply(f:Awaited<ReturnType<typeof form>>,e=edit()){
 const result=await applyContentTextEdits(f.page,[e],{loadFont});
 expect(result.outcomes[0]?.mode).toBe('retypeset');return result.outcomes[0]!.retypeset!;
}

test('CoW Form wrap pushes its text and graphics together; page and shared occurrences stay fixed',async()=>{
 const body=title+following+shape+'BT /F1 10 Tf 220 120 Td (OTHER) Tj ET';
 const f=await form(body,'/Fm Do BT /F1 10 Tf 20 185 Td (PAGE) Tj ET q 1 0 0 1 350 0 cm /Fm Do Q');f.page.setSize(700,200);
 const second=f.doc.addPage([300,200]);second.node.set(PDFName.of('Resources'),f.page.node.Resources()!);second.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.stream('/Fm Do')));
 const before=await f.doc.save(),m=await apply(f),after=await f.doc.save();
 expect(m).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false});
 expect(m.pushedRegions.length).toBeGreaterThan(1);for(const r of m.pushedRegions)expect(r.after).toEqual({...r.before,y:r.before.y-24});
 expect(decode(f.raw)).toBe(body);expect(usedForm(f.page)).not.toBe(f.raw);expect(usedForm(second)).toBe(f.raw);
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{
  const a=native.inspectPage(before,0,true),b=native.inspectPage(after,0,true);
  const moving=a.glyphs.filter(g=>g.origin[0]!>=55&&g.origin[0]!<130&&g.origin[1]===120);
  expect(moving.length).toBeGreaterThan(0);
  for(const g of moving)expect(b.glyphs.find(n=>n.text===g.text&&Math.abs(n.origin[0]!-g.origin[0]!)<.01&&Math.abs(n.origin[1]!-96)<.01)).toBeDefined();
  for(const g of a.glyphs.filter(g=>g.origin[0]!>=220||g.origin[1]===185))expect(b.glyphs.find(n=>n.text===g.text&&JSON.stringify(n.origin)===JSON.stringify(g.origin)&&n.fontHash===g.fontHash&&JSON.stringify(n.nativePath)===JSON.stringify(g.nativePath))).toBeDefined();
  expect(native.inspectPage(after,1,true).pixels).toEqual(native.inspectPage(before,1,true).pixels);
  expect(b.glyphs.find(g=>g.text==='K')!.inkBox[1]).toBeGreaterThan(b.glyphs.find(g=>g.text==='R')!.inkBox[3]!);
  const pixel=(p:typeof b,x:number,y:number)=>p.pixels![(Math.floor((p.height-y)*2)*Math.round(p.width*2)+Math.floor(x*2))*4]!;
  expect(pixel(a,85,93)).toBeLessThan(200);expect(pixel(b,85,93)).toBe(255);expect(pixel(b,85,69)).toBeLessThan(200);
  const dir='test-artifacts/r23-form';await mkdir(dir,{recursive:true});
  await writeFile(`${dir}/synthetic.before.pdf`,before);await writeFile(`${dir}/synthetic.after.pdf`,after);
  await writeFile(`${dir}/synthetic.json`,JSON.stringify({command:'bun test src/pdf/export/contentText/retypesetFormPush.test.ts',manifest:m,movingGlyphs:moving.length,sharedPagePixelsUnchanged:true},null,2));
 }finally{native.close();}
});

test('scaled/translated Form reports pushed regions in page space',async()=>{
 const f=await form(title+following+shape,'q 0.5 0 0 0.5 20 30 cm /Fm Do Q');
 const m=await apply(f,overlay({...edit(),coverRects:[{x:44.5,y:103.5,w:61,h:12}]}));
 expect(m.pushed).toBe(true);expect(m.pushedDeltaPt).toBeCloseTo(12,6);expect(m.paragraphBox.x).toBeCloseTo(45,2);
 expect(m.unchangedLineDriftPt).toBeCloseTo(12,6);expect(m.quality).toMatchObject({maxUnchangedLineStartXDriftPt:0,maxUnchangedLineBaselineDriftPt:0});
 for(const r of m.pushedRegions){expect(r.before.x).toBeGreaterThan(40);expect(r.before.x+r.before.w).toBeLessThan(100);expect(r.before.y).toBeGreaterThan(70);expect(r.before.y).toBeLessThan(100);expect(r.before.y-r.after.y).toBeCloseTo(12,6);}
});

test('a containing rectangular Form clip permits the same local push',async()=>{
 const f=await form(title+'q 0 0 300 200 re W n '+following+shape+'Q');
 expect(await apply(f)).toMatchObject({pushed:true,pushedDeltaPt:24,overflowInkOverlap:false});
});

for(const kind of ['bbox','clip','unknown-clip','parent-clip','ancestor-bbox','obstacle'] as const)test(`Form push refuses ${kind} without moving following ink`,async()=>{
 const body=title+(kind==='clip'?'q 0 100 300 100 re W n ':kind==='unknown-clip'?'q 0 0 m 300 0 l 300 200 l h W n ':'')+following+(kind==='clip'||kind==='unknown-clip'?'Q':'')+(kind==='obstacle'?'0.3 g 110 82 130 22 re f':'');
 const f=await form(body,kind==='parent-clip'?'q 0 100 300 100 re W n /Fm Do Q':'/Fm Do');
 if(kind==='bbox')f.raw.dict.set(PDFName.of('BBox'),f.doc.context.obj([0,100,300,200]));
 if(kind==='ancestor-bbox'){
  const parent=f.doc.context.register(f.doc.context.stream('/Child Do',{Type:'XObject',Subtype:'Form',BBox:[0,100,300,200],Resources:{XObject:{Child:f.ref}}}));
  f.page.node.Resources()!.lookup(PDFName.of('XObject'),PDFDict).set(PDFName.of('Fm'),parent);
 }
 const before=await f.doc.save(),m=await apply(f),after=await f.doc.save();
 expect(m).toMatchObject({pushed:false,pushedDeltaPt:0,pushedRegions:[],overflowInkOverlap:true});
 expect(m.pushReason).toBe(kind==='bbox'||kind==='ancestor-bbox'?'push-blocked-by-form-bbox':kind==='obstacle'?'push-blocked-by-fixed-or-foreign-obstacle':'push-blocked-by-form-clip');
 const native=openPdfium(resolve('vendor/pdfium/linux-x64/lib/libpdfium.so'));
 try{const a=native.inspectPage(before),b=native.inspectPage(after);for(const g of a.glyphs.filter(g=>g.fontSize===10))expect(b.glyphs.find(n=>n.text===g.text&&JSON.stringify(n.origin)===JSON.stringify(g.origin))).toBeDefined();}finally{native.close();}
});

test('writer refuses a still-shared Form without a detached CoW node before mutation',async()=>{
 const f=await form();f.page.node.set(PDFName.of('Contents'),f.raw);
 const before=inspectRunPage(f.page);if(!before.ok)throw Error(before.reason);
 const ops=tokenizeContentStream(before.bytes),source=readRetypesetSource(f.page,ops),e=edit();
 const plan=planRetypeset(source.glyphs,ops,[{overlay:e,selected:selectRetypeset(source.glyphs,e),reason:'form-xobject'}]);
 await expect(writeRetypeset(f.page,before.bytes,ops,source,[plan],{loadFont})).rejects.toThrow('form-context');
 expect(inspectRunPage(f.page)).toEqual(before);expect(decode(f.raw)).toBe(title+following+shape);
});
