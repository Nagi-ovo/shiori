import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {spacingPage} from './reflowApply.test-support';
import {regionStream as multi,type1RegionPage} from './reflowRegion.test-support';
import {cidReflowPage,cffReflowPage} from './reflowFull.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {planStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {streamReflowEvidence} from './reflowEvidence';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {traceReflowSource} from './reflowTrace';
import {overlay} from './fixtures.test-support';

const edit=(y=150)=>overlay({originalText:'S',text:'n n',coverRects:[{x:49.9,y:y-2,w:10.2,h:12}]});
function plan(page:Parameters<typeof inspectRunPage>[0],a=edit()){
 const s=inspectRunPage(page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(page),p=planStreamReflow(page,s.bytes,fonts,a);
 return {s,fonts,p};
}
for(const tagged of [false,true])test(`${tagged?'Word tagged':'one-BT-per-line'} wraps a paragraph as a unit and rejoins the original state`,async()=>{
 const f=await spacingPage(multi(tagged)+' BT /F1 10 Tf 220 150 Td (i) Tj ET'),{s,fonts,p}=plan(f.page,edit(136));
 expect(p?.reflow?.proof.lineSlots.map(s=>s.baseline)).toEqual([150,136,122]);
 expect(p?.reflow?.proof.owned).toHaveLength(3);if(!p?.reflow)throw Error('no paragraph plan');
 expect(p.reflow.firstOp).toBe(p.reflow.proof.owned[0]!.opIndex);
 const out=compileReflowPlan(s.bytes,fonts,p);expect(out.ok).toBe(true);if(!out.ok)throw Error(out.reason);
 const old=traceReflowSource(tokenizeContentStream(s.bytes),fonts,'revision'),after=traceReflowSource(tokenizeContentStream(out.bytes),fonts,'revision');
 const state=(t:ReturnType<typeof old.ends.get>)=>t&&{tm:t.tm,tlm:t.tlm,ctm:t.ctm,font:t.fontObject,size:t.size,tc:t.tc,tw:t.tw,tz:t.tz,rise:t.rise,leading:t.leading,renderMode:t.renderMode};
 expect(state([...after.ends.values()].at(-1))).toEqual(state([...old.ends.values()].at(-1)));
 expect([...after.shows.values()].at(-1)?.before.tm).toEqual([...old.shows.values()].at(-1)?.before.tm);
});
test('Type1 measured Latin one-BT lines produce a paragraph wrap',async()=>{
 const f=await type1RegionPage();
 const {s,fonts,p}=plan(f.page,overlay({originalText:'A',text:'AB AB',coverRects:[{x:49.9,y:134,w:6.2,h:12}]}));
 expect(p?.reflow?.layout.strategy).toBe('wrap');expect(p?.reflow?.proof.owned).toHaveLength(3);
 if(!p)throw Error('missing Type1 plan');expect(compileReflowPlan(s.bytes,fonts,p).ok).toBe(true);
});
test.each(['甲乙丙丁戊己庚辛','日本語文書編集機能'])('CID full-width sibling BTs supply paragraph slots: %s',async text=>{
 const f=await cffReflowPage(new Uint8Array(await Bun.file('src/assets/fonts/NotoSansSC-Regular.otf').arrayBuffer()),text);
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 // Preserve the embedded CID program/codes and put each observed line in its own BT.
 const stream=new TextDecoder().decode(s.bytes).replaceAll(' Tj 1 0 0 1',' Tj ET BT /F1 10 Tf 14 TL 1 0 0 1');
 f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.flateStream(stream)));
 const {s:source,fonts,p}=plan(f.page,overlay(f.edit));expect(p?.reflow?.proof.owned).toHaveLength(3);
 if(!p)throw Error(`missing CID plan ${text}`);expect(compileReflowPlan(source.bytes,fonts,p).ok).toBe(true);
});
for(const bridge of [' /X Do ',' 0 0 1 1 re f ',' 0 0 m 1 1 l S ',' 0 0 1 1 re W n ',' /Shade sh '])test(`interleaved paint/clip refuses: ${bridge}`,async()=>{
 const f=await spacingPage(multi(false,bridge));expect(plan(f.page).p).toBeNull();
});
for(const tr of [1,2])test(`Tr ${tr} remains refused across BTs`,async()=>{
 const f=await spacingPage(`${tr} Tr `+multi());expect(plan(f.page).p).toBeNull();
});
test('occupied band below a full multi-BT paragraph cannot be borrowed',async()=>{
 const f=await cidReflowPage(multi().replace('(S i) Tj','(S i i i i) Tj')+' BT /F1 10 Tf 60 108 Td (i) Tj ET');
 expect(plan(f.page).p).toBeNull();
});
test('missing ink and declared envelope both refuse without an invented box',async()=>{
 const f=await spacingPage(multi()),dict=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),font=dict.lookup(PDFName.of('F1'),PDFDict);
 font.lookup(PDFName.of('FontDescriptor'),PDFDict).delete(PDFName.of('FontFile2'));
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);const fonts=resolveRunFonts(f.page),target=tokenizeContentStream(s.bytes).findIndex(op=>op.operator==='Tj');
 expect(streamReflowEvidence(f.page,s.bytes,fonts,target)).toBeNull();
});
