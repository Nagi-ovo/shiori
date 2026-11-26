import {expectRetypeset} from './retypesetAssertions.test';
import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFRawStream} from 'pdf-lib';
import {applyContentTextEdits} from './apply';
import {fixture as originalFixture,overlay as originalOverlay} from './fixtures.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {type1Fixture} from './type1Wiring.test-support';

const overlay=(patch:Parameters<typeof originalOverlay>[0]={})=>originalOverlay({coverRects:[{x:49,y:97,w:32,h:14}],...patch});
async function fixture(stream?:string){
 const f=await originalFixture(stream),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('FontDescriptor'),f.doc.context.obj({FontBBox:[0,-200,600,800],Ascent:800,Descent:-200}));
 return f;
}
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
function savedText(page:import('pdf-lib').PDFPage){
 const source=inspectRunPage(page);if(!source.ok)throw Error(source.reason);
 const fonts=resolveRunFonts(page),walk=walkTextPlacements(tokenizeContentStream(source.bytes),{resolveFont:name=>{
  const font=fonts.find(f=>f.resourceName===name);return font?{...font,ok:true,appliesWordSpacing:font.bytesPerCode===1}:{ok:false,reason:'unavailable'};
 }});
 if(!walk.ok)throw Error(walk.reason);
 return walk.glyphs.map(g=>({text:fonts.find(f=>f.resourceName===g.fontName)?.unicodeByCode.get(g.code)??(g.fontName==='F1'?String.fromCharCode(g.code):undefined),origin:g.coreQuad[0],font:g.fontName}));
}
for(const [text,face] of [['éike','LiberationMono-Regular.ttf'],['e\u0301ike','LiberationMono-Regular.ttf'],['漢é','NotoSansSC-Regular.otf'],['かなé','NotoSansJP-Regular.otf']])test(`whole-run substitution saves NFC ${JSON.stringify(text)} and preserves the suffix position`,async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj [-1000] TJ (Z) Tj ET');
 const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);font.delete(PDFName.of('ToUnicode'));
 const result=await applyContentTextEdits(f.page,[overlay({text})],{loadFont});
 expect(result.outcomes).toEqual([{overlayId:'edit',mode:'substituted',fidelity:'exact',faces:[face]}]);
 const saved=await PDFDocument.load(await f.doc.save()),glyphs=savedText(saved.getPage(0));
 expect(glyphs.map(g=>g.text).join('')).toBe(text.normalize('NFC')+'Z');
 expect(glyphs.at(-1)).toEqual({text:'Z',origin:{x:90,y:100},font:'F1'});
});
test('default-on substitution rewrites a whole unusable Type1 run and preserves its suffix',async()=>{
 const f=await type1Fixture({differences:[65,'A','A'],stream:'BT /F1 10 Tf 50 100 Td (AB) Tj [-1000] TJ (C) Tj ET'});
 const fonts:string[]=[];
 const result=await applyContentTextEdits(f.page,[overlay({originalText:'AB',text:'X',coverRects:[{x:49,y:97,w:14,h:14}]})],{loadFont:async name=>{fonts.push(name);return loadFont(name);}});
 expect(result.outcomes).toEqual([{overlayId:'edit',mode:'substituted',fidelity:'exact',faces:['LiberationMono-Regular.ttf']}]);expect(result.remaining).toEqual([]);
 expect(fonts).toEqual(['LiberationMono-Regular.ttf']);
 const saved=await PDFDocument.load(await f.doc.save({useObjectStreams:false})),page=saved.getPage(0);
 const glyphs=savedText(page);expect(glyphs.map(g=>g.text).join('')).toBe('XC');
 expect(glyphs[0]!.origin).toEqual({x:50,y:100});expect(glyphs.at(-1)).toEqual({text:'C',origin:{x:72,y:100},font:'F1'});
 const font=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of(glyphs[0]!.font),PDFDict);
 expect(font.lookup(PDFName.of('Subtype'),PDFName).decodeText()).toBe('Type0');
 expect(font.lookup(PDFName.of('Encoding'),PDFName).decodeText()).toBe('Identity-H');
 expect(font.lookup(PDFName.of('ToUnicode'))).toBeInstanceOf(PDFRawStream);
 expect(font.lookup(PDFName.of('DescendantFonts'),PDFArray).size()).toBe(1);
});
test('exact substitution opt-out still retypesets an unusable font',async()=>{
 const f=await fixture();const font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.delete(PDFName.of('ToUnicode'));
 const before=inspectRunPage(f.page),result=await applyContentTextEdits(f.page,[overlay()],{stage5Substitute:false,loadFont});
 expectRetypeset(f.page,result.outcomes[0],before,'AXCDE','font-unavailable');
});
test('unusable source encoding substitutes all selected glyphs',async()=>{
 const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.delete(PDFName.of('ToUnicode'));font.set(PDFName.of('BaseFont'),PDFName.of('LegacyMono'));
 const result=await applyContentTextEdits(f.page,[overlay({text:'AX'})],{loadFont});
 expect(result.outcomes[0]?.mode).toBe('substituted');
});
for(const [text,name]of [['漢','NotoSansSC-Regular.otf'],['かな','NotoSansJP-Regular.otf']]as const)test(`substitution selects Noto for ${text}`,async()=>{
 const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.delete(PDFName.of('ToUnicode'));let chosen='';
 const result=await applyContentTextEdits(f.page,[overlay({text})],{loadFont:async name=>{chosen=name;return loadFont(name);}});
 expect(result.outcomes[0]?.mode).toBe('substituted');expect(chosen).toBe(name);
});
test('substitution remains enabled with source reuse disabled',async()=>{
 const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);font.delete(PDFName.of('ToUnicode'));
 const result=await applyContentTextEdits(f.page,[overlay({text:'AX'})],{stage5Type1:{sourceReuse:false},loadFont});expect(result.outcomes[0]?.mode).toBe('substituted');
});
test('substitution removes owned shows across a kerned TJ and keeps unowned text fixed',async()=>{
 const f=await fixture('BT /F1 10 Tf 50 100 Td [(AB) -120 (CDE)] TJ [-1000] TJ (Z) Tj ET'),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);font.delete(PDFName.of('ToUnicode'));
 const result=await applyContentTextEdits(f.page,[overlay({text:'AX',coverRects:[{x:49,y:97,w:33.2,h:14}]})],{loadFont});expect(result.outcomes[0]?.mode).toBe('substituted');
 const saved=await PDFDocument.load(await f.doc.save()),glyphs=savedText(saved.getPage(0));
 expect(glyphs.map(g=>g.text).join('')).toBe('AXZ');expect(glyphs.at(-1)!.origin.x).toBeCloseTo(91.2,5);
});
test('a concurrent resource or content change during substitution refuses stale source',async()=>{
 for(const change of ['resource','content','ext-state']){
  const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);font.delete(PDFName.of('ToUnicode'));
  const state=f.doc.context.obj({ca:1}),stateRef=f.doc.context.register(state);
  f.page.node.Resources()!.set(PDFName.of('ExtGState'),f.doc.context.obj({State:stateRef}));
  const result=await applyContentTextEdits(f.page,[overlay({text:'AX'})],{loadFont:async name=>{
   if(change==='resource')font.set(PDFName.of('BaseFont'),PDFName.of('Changed'));
   else if(change==='ext-state')state.set(PDFName.of('ca'),f.doc.context.obj(.5));
   else f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.stream(new TextEncoder().encode('BT /F1 10 Tf 50 100 Td (ZZZZZ) Tj ET'))));
   return loadFont(name);
  }});
  expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-unwritable'});
 }
});
for(const kind of ['ocr','matrix','vertical','overlap','unknown-encoding'])test(`substitution refuses unsafe ${kind} selection`,async()=>{
 const stream=kind==='ocr'?'':kind==='matrix'?'BT /F1 10 Tf 1 0.2 0 1 50 100 Tm (ABCDE) Tj ET':'BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET';
 const f=await fixture(stream),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);font.delete(PDFName.of('ToUnicode'));
 if(kind==='vertical')font.set(PDFName.of('WMode'),f.doc.context.obj(1));
 if(kind==='unknown-encoding')font.set(PDFName.of('Encoding'),PDFName.of('UnknownEncoding'));
 const edits=[overlay({text:'AX'}),...(kind==='overlap'?[overlay({id:'other'})]:[])];let loads=0;
 const before=inspectRunPage(f.page),result=await applyContentTextEdits(f.page,edits,{loadFont:async name=>{loads++;return loadFont(name);}});
 if(kind==='ocr'||kind==='overlap'||kind==='vertical'){expect(result.outcomes.every(o=>o.mode==='unsupported')).toBe(true);if(kind==='vertical')expect(result.outcomes[0]?.reason).toBe('unsupported-vertical-writing');expect(loads).toBe(0);expect(inspectRunPage(f.page)).toEqual(before);}
 else for(const outcome of result.outcomes){
  const glyphs=expectRetypeset(f.page,outcome,before,kind==='unknown-encoding'?undefined:'AX');
  if(kind==='unknown-encoding'){
   // The unchanged wildcard keeps its source code, never an invented "A"
   // Unicode label. Only the user's changed scalar needs new font encoding.
   expect(glyphs).toHaveLength(2);
   expect(glyphs[0]).toMatchObject({text:undefined,glyph:{fontName:'F1',code:65}});
   expect(glyphs[1]!.text).toBe('X');
  }
 }
});
test('embedded Type1 vertical WMode and nonstandard FontMatrix stay refused with missing ToUnicode',async()=>{
 for(const wmode of [true,false]){
  const f=await type1Fixture({programOptions:wmode?{clear:'/WMode 1 def'}:{}});f.font.delete(PDFName.of('ToUnicode'));f.font.set(PDFName.of('Encoding'),PDFName.of('WinAnsiEncoding'));
  if(!wmode)f.font.set(PDFName.of('FontMatrix'),f.doc.context.obj([.002,0,0,.001,0,0]));
  const before=inspectRunPage(f.page),result=await applyContentTextEdits(f.page,[overlay({originalText:'AB',text:'X'})],{loadFont});
  if(wmode){expect(result.outcomes[0]).toMatchObject({mode:'unsupported',detail:expect.stringContaining('vertical-writing')});expect(inspectRunPage(f.page)).toEqual(before);}
  else expectRetypeset(f.page,result.outcomes[0],before,'X');
 }
});
test('horizontal Type3 with dictionary widths substitutes through Type0',async()=>{
 const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('Subtype'),PDFName.of('Type3'));font.set(PDFName.of('FontMatrix'),f.doc.context.obj([.001,0,0,.001,0,0]));
 font.set(PDFName.of('FontBBox'),f.doc.context.obj([0,-200,600,800]));
 const result=await applyContentTextEdits(f.page,[overlay({text:'AX'})],{loadFont});expect(result.outcomes[0]?.mode).toBe('substituted');
});
for(const tr of [1,2,4])test(`approximate layout handles paint mode ${tr}`,async()=>{
 const f=await fixture(`BT /F1 10 Tf ${tr} Tr 50 100 Td (ABCDE) Tj ET`),before=inspectRunPage(f.page);let loads=0;
 const result=await applyContentTextEdits(f.page,[overlay({text:'AX'})],{loadFont:async name=>{loads++;return loadFont(name);}});
 if(tr<4){const gs=expectRetypeset(f.page,result.outcomes[0],before,'AX','graphics-effect-unsupported');expect(gs.every(g=>g.state.renderMode===tr)).toBe(true);}
 else {expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-unwritable'});expect(loads).toBe(0);expect(inspectRunPage(f.page)).toEqual(before);}
});
test('overflow retypesets while missing placement widths remain unchanged',async()=>{
 for(const unknownWidths of [false,true]){
  const f=await fixture(),font=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
  if(unknownWidths){font.delete(PDFName.of('Widths'));font.set(PDFName.of('BaseFont'),PDFName.of('UnknownFace'));}
  const count=f.doc.context.enumerateIndirectObjects().length,contents=f.page.node.get(PDFName.of('Contents')),before=inspectRunPage(f.page);
  const result=await applyContentTextEdits(f.page,[overlay({text:'W'.repeat(100)})],{loadFont});
  if(unknownWidths){expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-no-text-layer'});expect(f.page.node.get(PDFName.of('Contents'))).toBe(contents);expect(f.doc.context.enumerateIndirectObjects().length).toBe(count);}
  else expectRetypeset(f.page,result.outcomes[0],before,'W'.repeat(100),'overflow');
 }
});

test('whole-run substitution writes every replacement glyph with the selected local program', async () => {
 const f = await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj [-1000] TJ (Z) Tj ET');
 const key = PDFName.of, font = f.page.node.Resources()!.lookup(key('Font'), PDFDict).lookup(key('F1'), PDFDict);
 font.delete(key('ToUnicode'));
 font.set(key('BaseFont'), key('LiberationMono'));
 const bytes = await loadFont('LiberationMono-Regular.ttf');
 const result = await applyContentTextEdits(f.page, [overlay({ text: 'Aé' })], {
  localFonts: [{ name: 'Installed-Regular.ttf', bytes }],
  loadFont: async name => { throw Error('Loaded bundled font ' + name); },
 });
 expect(result.outcomes[0]).toMatchObject({ mode: 'substituted', faces: ['Installed-Regular.ttf'] });
 const page = (await PDFDocument.load(await f.doc.save())).getPage(0), glyphs = savedText(page);
 expect(glyphs.map(g => g.text).join('')).toBe('AéZ');
 expect(glyphs[0]!.font).toBe(glyphs[1]!.font);
 expect(glyphs[2]!.font).toBe('F1');
 const embedded = page.node.Resources()!.lookup(key('Font'), PDFDict).lookup(key(glyphs[0]!.font), PDFDict);
 expect(embedded.lookup(key('BaseFont'), PDFName).decodeText()).toMatch(/^[A-P]{6}\+LiberationMono/u);
});
