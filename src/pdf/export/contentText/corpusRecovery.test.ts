import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {PDFDict,PDFName} from 'pdf-lib';
import {applyContentTextEdits} from './apply';
import {fixture,overlay} from './fixtures.test-support';
import {spacingPage} from './reflowApply.test-support';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';

const loadFont=(name:string)=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const edit=()=>overlay({originalText:'S',text:'n n',coverRects:[{x:49.9,y:148,w:10.2,h:12}]});
const single='BT /F1 10 Tf 14 TL 50 150 Td (S ) Tj [(i i ) 0 (i i)] TJ ET';
const two='BT /F1 10 Tf 14 TL 50 150 Td (S i i i i ) Tj 0 -14 Td (S i) Tj ET';

test('GSA-style malformed ToUnicode codespace retains explicit Encoding and Widths for substitution',async()=>{
 const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('BaseFont'),PDFName.of('Calibri'));
 font.set(PDFName.of('ToUnicode'),f.doc.context.register(f.doc.context.flateStream('1 begincodespacerange <0000> <ffff> endcodespacerange 1 beginbfrange <20> <7e> <0020> endbfrange')));
 const r=await applyContentTextEdits(f.page,[overlay({text:'ABCDF',coverRects:[{x:49,y:97,w:32,h:14}]})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'substituted'});
});
test('a tight cover uses embedded source ink rather than the descriptor advance quad',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 50 150 Td (S) Tj ET');
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);font.delete(PDFName.of('ToUnicode'));
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'S',text:'i',coverRects:[{x:49.5,y:149.5,w:11,h:9}]})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'substituted'});
});
for(const stream of [single,two,two.replace('14 TL ','').replace('0 -14 Td','0 -14 TD'),single.replace('50 150 Td','50 164 Td T*'),single.replace('50 150 Td','50 164 Td 0 -14 TD')])test(`short paragraph reflows: ${stream}`,async()=>{
 const f=await spacingPage(stream),r=await applyContentTextEdits(f.page,[edit()]);
 expect(r.outcomes[0]).toMatchObject({mode:'reflowed',reflow:{strategy:'wrap'}});
});
for(const kind of ['annotation','image','form','paint','gs','unknown-text'])test(`distant ${kind} does not poison local reflow`,async()=>{
 const extra=kind==='image'||kind==='form'?' q 10 0 0 10 220 20 cm /Far Do Q':kind==='paint'?' 220 20 10 10 re f':kind==='gs'?' q /Far gs 220 20 10 10 re f Q':kind==='unknown-text'?' BT /Missing 10 Tf 220 20 Td (unknown) Tj ET':'';
 const f=await spacingPage(single+extra),ctx=f.doc.context,resources=f.page.node.Resources()!;
 if(kind==='annotation')f.page.node.set(PDFName.of('Annots'),ctx.obj([{Type:'Annot',Subtype:'Link',Rect:[220,20,240,40]}]));
 if(kind==='image'||kind==='form')resources.set(PDFName.of('XObject'),ctx.obj({Far:ctx.register(ctx.stream(new Uint8Array(),kind==='image'?{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}:{Type:'XObject',Subtype:'Form',BBox:[0,0,1,1]}))}));
 if(kind==='gs')resources.set(PDFName.of('ExtGState'),ctx.obj({Far:ctx.register(ctx.obj({ca:.5}))}));
 if(kind==='unknown-text')resources.lookup(PDFName.of('Font'),PDFDict).set(PDFName.of('Missing'),ctx.register(ctx.obj({Type:'Font',Subtype:'TrueType',FontDescriptor:ctx.obj({FontBBox:[0,-200,1000,800]})})));
 const r=await applyContentTextEdits(f.page,[edit()]);expect(r.outcomes[0]?.mode).toBe('reflowed');
});
for(const extra of [' 50 129 50 10 re f',' BT /Missing 10 Tf 50 136 Td (unknown) Tj ET'])test(`intersecting obstacle refuses growth: ${extra}`,async()=>{
 const f=await spacingPage(single+extra),before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[edit()]);
 expect(r.outcomes[0]?.mode).toBe('overlay');expect(inspectRunPage(f.page)).toEqual(before);
});
test('overflowing newly prepared substitute reflows atomically and reports a manifest',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 14 TL 50 150 Td (S i i i i) Tj ET');
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);font.delete(PDFName.of('ToUnicode'));
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'S i i i i',text:'W W W W W W W W',coverRects:[{x:49,y:147,w:51,h:14}]})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'substituted',reflow:{strategy:'wrap'}});
 expect(f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).has(PDFName.of('ShioriSub1'))).toBe(true);
});
test('an empty trailing space can intersect a tight cover without blocking substitution',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 50 150 Td (S i) Tj ( ) Tj ET');
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).delete(PDFName.of('ToUnicode'));
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'S i',text:'i',coverRects:[{x:49,y:147,w:22,h:14}]})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('substituted');
});
test('ordinary negative source kerning does not forbid whole-run substitution',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td [(AB) 3 (CDE)] TJ ET');
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).delete(PDFName.of('ToUnicode'));
 const r=await applyContentTextEdits(f.page,[overlay({text:'AX',coverRects:[{x:49,y:97,w:32,h:14}]})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('substituted');
});
test('substitute reflow cannot move the source beneath a refused sibling overlay',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 14 TL 50 150 Td (S i i i i) Tj 0 -14 Td (S i) Tj ET');
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).delete(PDFName.of('ToUnicode'));
 const before=inspectRunPage(f.page),other={...overlay({id:'other',originalText:'S',text:'i',coverRects:[{x:49,y:134,w:12,h:12}]}),bold:true};
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'S i i i i',text:'W W W W W W W W',coverRects:[{x:49,y:147,w:51,h:14}]}),other],{loadFont});
 expect(r.outcomes.every(o=>o.mode==='overlay')).toBe(true);expect(inspectRunPage(f.page)).toEqual(before);
});
test('substitute overflow honors reflow opt-out without installing new objects',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 14 TL 50 150 Td (S i i i i) Tj ET');
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).delete(PDFName.of('ToUnicode'));
 const before=inspectRunPage(f.page),count=f.doc.context.enumerateIndirectObjects().length;
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'S i i i i',text:'W W W W W W W W',coverRects:[{x:49,y:147,w:51,h:14}]})],{loadFont,stage5Reflow:false});
 expect(r.outcomes[0]).toMatchObject({mode:'overlay',reason:'overflow'});expect(inspectRunPage(f.page)).toEqual(before);expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);
});
test('horizontal Type3 glyph-space scaling retains dictionary advances for substitution',async()=>{
 const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('Subtype'),PDFName.of('Type3'));font.set(PDFName.of('FontMatrix'),f.doc.context.obj([.002,0,0,.002,0,0]));font.set(PDFName.of('FontBBox'),f.doc.context.obj([0,-200,600,800]));
 const r=await applyContentTextEdits(f.page,[overlay({text:'AX',coverRects:[{x:49,y:95,w:62,h:24}]})],{loadFont});expect(r.outcomes[0]?.mode).toBe('substituted');
});
test('a width-only source with declared ink bounds can reflow into a newly embedded substitute',async()=>{
 const f=await fixture('BT /F1 10 Tf 14 TL 50 100 Td (ABCDE) Tj ET'),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.delete(PDFName.of('ToUnicode'));font.set(PDFName.of('FontDescriptor'),f.doc.context.obj({FontBBox:[0,-200,600,800],Ascent:800,Descent:-200}));
 const r=await applyContentTextEdits(f.page,[overlay({text:'W W W W W W W W',coverRects:[{x:49,y:97,w:32,h:14}]})],{loadFont});
 expect(r.outcomes[0]).toMatchObject({mode:'substituted',reflow:{strategy:'wrap'}});
});
test('invisible OCR text cannot be accepted as a visible substitution',async()=>{
 const f=await fixture('BT /F1 10 Tf 3 Tr 50 100 Td (ABCDE) Tj ET');
 f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).delete(PDFName.of('ToUnicode'));
 const before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[overlay({text:'AX',coverRects:[{x:49,y:97,w:32,h:14}]})],{loadFont});
 expect(r.outcomes[0]?.mode).toBe('overlay');expect(inspectRunPage(f.page)).toEqual(before);
});
