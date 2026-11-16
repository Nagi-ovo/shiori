import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {fixture,overlay} from './fixtures.test-support';
import {applyContentTextEdits} from './apply';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {verticalWritingReason} from '../contentStreamEdit/verticalWriting';

// Failure list: Identity-V, named vertical CMaps, explicit WMode on the
// source/descendant, encoding CMap dictionary/body/usecmap, a vertical Form,
// comments mentioning WMode, and an unused vertical resource. Refusal must
// happen before loading/shaping a substitute (including vert or vrt2), leave
// source CIDs opaque and preserve resources/content exactly.
for(const kind of ['identity-v','named-v','wmode','descendant','cmap-dict','cmap-body','usecmap','form']as const)test(`vertical ${kind} refuses before substitute shaping or encoding`,async()=>{
 const f=await fixture('BT /F1 10 Tf 1 Tr 50 100 Td <00410042004300440045> Tj ET');
 const resources=f.page.node.Resources()!,font=resources.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('Subtype'),PDFName.of('Type0'));font.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));
 font.set(PDFName.of('DescendantFonts'),f.doc.context.obj([{Type:'Font',Subtype:'CIDFontType2',DW:600,...(kind==='descendant'?{WMode:1}:{})}]));
 font.set(PDFName.of('ToUnicode'),f.doc.context.register(f.doc.context.stream('1 beginbfrange <0041> <0045> <0041> endbfrange')));
 if(kind==='identity-v'||kind==='form')font.set(PDFName.of('Encoding'),PDFName.of('Identity-V'));
 if(kind==='named-v')font.set(PDFName.of('Encoding'),PDFName.of('UniJIS-UTF16-V'));
 if(kind==='wmode')font.set(PDFName.of('WMode'),f.doc.context.obj(1));
 if(kind.startsWith('cmap')||kind==='usecmap')font.set(PDFName.of('Encoding'),f.doc.context.register(f.doc.context.flateStream(
  kind==='cmap-body'?'% /WMode 0 def\n/WMode % continuation\n1 def':kind==='usecmap'?'/Identity-V usecmap':'/WMode 0 def',
  kind==='cmap-dict'?{WMode:1}:{})));
 if(kind==='form'){
  const raw=f.doc.context.flateStream('BT /F1 10 Tf 1 Tr 50 100 Td <00410042> Tj ET',{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:resources.clone()});
  resources.set(PDFName.of('XObject'),f.doc.context.obj({Vertical:f.doc.context.register(raw)}));
  f.page.node.set(PDFName.of('Contents'),f.doc.context.register(f.doc.context.stream('/Vertical Do')));
 }
 const before=inspectRunPage(f.page),count=f.doc.context.enumerateIndirectObjects().length;
 let loads=0;
 const result=await applyContentTextEdits(f.page,[overlay({text:'かな'})],{stage5Reflow:false,loadFont:async()=>{loads++;throw Error('vertical must refuse before vert/vrt2 shaping');}});
 expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
 expect(result.outcomes[0]?.detail).toContain('vertical');expect(loads).toBe(0);
 expect(inspectRunPage(f.page)).toEqual(before);expect(f.page.node.Resources()).toBe(resources);
 expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);
});

test('unused vertical resources and a comment mentioning WMode do not refuse a horizontal run',async()=>{
 const f=await fixture(),fonts=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
 fonts.set(PDFName.of('Unused'),f.doc.context.register(f.doc.context.obj({Subtype:'Type0',Encoding:'Identity-V'})));
 const horizontal=f.doc.context.obj({Encoding:f.doc.context.register(f.doc.context.flateStream('% /WMode 1 def\n(/Identity-V usecmap)\n/WMode 0 def'))});
 expect(verticalWritingReason(horizontal)).toBeUndefined();
 const result=await applyContentTextEdits(f.page,[overlay()],{loadFont:async()=>{throw Error('no fallback needed');}});
 expect(result.outcomes[0]).toMatchObject({mode:'in-place'});
});
