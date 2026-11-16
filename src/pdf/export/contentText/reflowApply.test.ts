import {expectRetypeset} from './retypesetAssertions.test';
import {expect,test} from 'bun:test';
import {applyContentTextEdits} from './apply';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {overlay} from './fixtures.test-support';
import {requestPage,spacingPage} from './reflowApply.test-support';
function glyphs(page:Awaited<ReturnType<typeof spacingPage>>['page']){
 const s=inspectRunPage(page);if(!s.ok)throw Error(s.reason);const fonts=resolveRunFonts(page);
 const w=walkTextPlacements(tokenizeContentStream(s.bytes),{resolveFont:name=>{const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:null;}});
 if(!w.ok)throw Error(w.reason);return w.glyphs.map(g=>({text:fonts.find(f=>f.resourceName===g.fontName)!.unicodeByCode.get(g.code),origin:g.coreQuad[0]}));
}
const spacingEdit=()=>overlay({originalText:'S',text:'an',coverRects:[{x:49.9,y:98,w:10.2,h:12}]});
test('exact reflow opt-out sends overflow to retypeset',async()=>{
 const f=await spacingPage(),before=inspectRunPage(f.page),r=await applyContentTextEdits(f.page,[spacingEdit()],{stage5Reflow:false});
 expectRetypeset(f.page,r.outcomes[0],before,undefined,'overflow');
});
test('boolean on installs spacing-only bytes inside the original slot with fixed suffix',async()=>{
 const f=await spacingPage(),r=await applyContentTextEdits(f.page,[spacingEdit()],{stage5Reflow:true});
 expect(r.outcomes[0]).toMatchObject({mode:'in-place',fidelity:'exact'});expect(r.remaining).toEqual([]);
 const gs=glyphs(f.page);expect(gs.map(g=>g.text).join('')).toBe('anni');expect(gs[1]!.origin.x).toBeCloseTo(54.98);expect(gs.slice(2).map(g=>g.origin.x)).toEqual([60,65.02]);
});
test('unbreakable words and missing leading proofs use approximate wrapping',async()=>{
 for(const text of ['annnnnnnnnnn','an\nn']){const f=await spacingPage(),before=inspectRunPage(f.page);
 const r=await applyContentTextEdits(f.page,[{...spacingEdit(),text}],{stage5Reflow:true});expectRetypeset(f.page,r.outcomes[0],before,text);
 if(text.includes('\n'))expect(r.outcomes[0]?.retypeset).toMatchObject({reason:'reflow-required'});}
});
test('explicit request installs owned suffix shift without changing other rows',async()=>{
 const f=await requestPage();f.request.target={...f.request.paragraph.lines[2]!.shows[0]!.source,byteStart:1,byteEnd:2};f.request.softBreaks=[];
 const edit={...f.overlay,originalText:'乙',coverRects:[{x:59.9,y:670,w:10.2,h:10}]};
 const r=await applyContentTextEdits(f.page,[edit],{stage5Reflow:true,reflowRequests:new Map([[edit.id,f.request]])});
 expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact'});expect(glyphs(f.page).slice(-4).map(g=>g.text).join('')).toBe('甲卯辰丙');expect(glyphs(f.page).at(-1)!.origin.x).toBeGreaterThan(79);
});
test('intersecting exact tails share one approximate paragraph layout',async()=>{
 const f=await requestPage(),before=inspectRunPage(f.page),other=structuredClone(f.request);other.target={...other.target,byteStart:6,byteEnd:7};
 const b={...f.overlay,id:'other',originalText:'庚',coverRects:[{x:109.9,y:698,w:10.2,h:10}]};
 const r=await applyContentTextEdits(f.page,[f.overlay,b],{stage5Reflow:true,reflowRequests:new Map([[f.overlay.id,f.request],[b.id,other]])});
 expect(r.outcomes).toHaveLength(2);for(const outcome of r.outcomes)expectRetypeset(f.page,outcome,before,undefined,'reflow-required');expect(r.outcomes[0]?.retypeset).toEqual(r.outcomes[1]?.retypeset);
});
test('explicit request wraps and apply installs its compiled output',async()=>{
 const f=await requestPage(),r=await applyContentTextEdits(f.page,[f.overlay],{stage5Reflow:true,reflowRequests:new Map([[f.overlay.id,f.request]])});
 expect(r.outcomes[0]).toMatchObject({mode:'reflowed',fidelity:'exact'});expect(glyphs(f.page)[10]).toEqual({text:'癸',origin:{x:50,y:686}});
});

test('disjoint recipes compile from one revision and both install',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 1 0 0 1 50 100 Tm (Sni) Tj ET BT /F1 10 Tf 1 0 0 1 50 70 Tm (Sni) Tj ET');
 const a=spacingEdit(),b={...a,id:'second',coverRects:[{x:49.9,y:68,w:10.2,h:12}]};
 const r=await applyContentTextEdits(f.page,[a,b],{stage5Reflow:true});
 expect(r.outcomes.map(o=>o.mode)).toEqual(['in-place','in-place']);expect(glyphs(f.page).map(g=>g.text).join('')).toBe('annianni');
 expect(r.outcomes.every(o=>o.reflow?.strategy==='spacing-only')).toBe(true);
});
test('a recipe and an independent fallback edit share one atomic installation',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 1 0 0 1 50 100 Tm (Sni) Tj ET BT /F1 10 Tf 1 0 0 1 50 70 Tm (S) Tj ET');
 const a=spacingEdit(),b={...a,id:'fallback',text:'X',coverRects:[{x:49.9,y:68,w:10.2,h:12}]};
 const r=await applyContentTextEdits(f.page,[a,b],{stage5Reflow:true,loadFont:async name=>new Uint8Array(await Bun.file(`node_modules/@docx-editor.dev/fonts/assets/${name}`).arrayBuffer())});
 expect(r.outcomes.map(o=>o.mode)).toEqual(['in-place','fallback-font']);expect(glyphs(f.page).map(g=>g.text).join('')).toBe('anniX');
});
test('a stale page dependency cannot authorize an explicit recipe',async()=>{
 const f=await requestPage(),before=inspectRunPage(f.page);
 f.request.dependencyHash='stale';f.request.paragraph.dependencyHash='stale';f.request.paragraph.evidence.dependencyHash='stale';
 const r=await applyContentTextEdits(f.page,[f.overlay],{stage5Reflow:true,reflowRequests:new Map([[f.overlay.id,f.request]])});
 expect(r.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-unwritable'});expect(inspectRunPage(f.page)).toEqual(before);
});
test('unknown scene paint keeps exact spacing refused and uses approximate layout',async()=>{
 const f=await spacingPage('0 0 m 300 0 l 150 200 l h f BT /F1 10 Tf 1 0 0 1 50 100 Tm (Sni) Tj ET'),before=inspectRunPage(f.page);
 const r=await applyContentTextEdits(f.page,[spacingEdit()],{stage5Reflow:true});expectRetypeset(f.page,r.outcomes[0],before,undefined,'overflow');
});

test('boolean spacing uses measured CID TrueType outlines and two-byte codes',async()=>{
 const {PDFDict,PDFName}=await import('pdf-lib');const f=await spacingPage(),ctx=f.doc.context;
 const fonts=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),font=fonts.lookup(PDFName.of('F1'),PDFDict);
 const map=new Uint8Array(256*2);for(const [code,gid]of [[83,1],[97,2],[110,3],[105,6]])map[code!*2+1]=gid!;
 const cid=ctx.register(ctx.obj({Type:'Font',Subtype:'CIDFontType2',BaseFont:'Tiny',CIDSystemInfo:{Registry:'Adobe',Ordering:'Identity',Supplement:0},
  DW:500,W:[83,[1000],97,[502],110,[502]],CIDToGIDMap:ctx.register(ctx.flateStream(map)),FontDescriptor:font.get(PDFName.of('FontDescriptor'))}));
 const parent=ctx.register(ctx.obj({Type:'Font',Subtype:'Type0',BaseFont:'Tiny',Encoding:'Identity-H',DescendantFonts:[cid],
  ToUnicode:ctx.register(ctx.flateStream('1 beginbfrange <0020> <007e> <0020> endbfrange'))}));
 fonts.set(PDFName.of('F1'),parent);f.page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream('BT /F1 10 Tf 1 0 0 1 50 100 Tm <0053006e0069> Tj ET')));
 const r=await applyContentTextEdits(f.page,[spacingEdit()],{stage5Reflow:true});
 expect(r.outcomes[0]).toMatchObject({mode:'in-place',fidelity:'exact'});expect(glyphs(f.page).map(g=>g.text).join('')).toBe('anni');expect(glyphs(f.page)[2]!.origin.x).toBe(60);
});
