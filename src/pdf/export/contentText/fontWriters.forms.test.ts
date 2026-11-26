import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName,PDFString} from 'pdf-lib';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {exportPdf} from '../exportPdf';
import {preserveSourceFontPage} from '../fonts/sourceFontContext';
import {applyContentTextEdits} from './apply';
import {fixture,model,overlay} from './fixtures.test-support';

const name=PDFName.of;
const loadFont=(file:string)=>readFile(`src/assets/fonts/${file}`);

for(const [label,body,structure,region] of [
 ['first invocation','BT /F1 10 Tf 1 Tr 50 100 Td (ABCDE) Tj ET',false,'JP'],
 ['Form marked content','/Span << /Lang (ko) >> BDC BT /F1 10 Tf 1 Tr 50 100 Td (ABCDE) Tj ET EMC',false,'KR'],
 ['original structure tree','/Span << /MCID 0 >> BDC BT /F1 10 Tf 1 Tr 50 100 Td (ABCDE) Tj ET EMC',true,'KR'],
] as const)test(`saved retypeset resolves regional Han through ${label} of a reused Form`,async()=>{
 const {doc,page}=await fixture('/Span << /Lang (ja) >> BDC /Fm Do EMC q 1 0 0 1 0 -65 cm /Span << /Lang (ko) >> BDC /Fm Do EMC Q');
 doc.catalog.set(name('Lang'),PDFString.of('zh-CN'));
 const resources=page.node.Resources()!.clone();
 const form=doc.context.register(doc.context.stream(body,{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:resources}));
 page.node.Resources()!.set(name('XObject'),doc.context.obj({Fm:form}));
 if(structure)doc.catalog.set(name('StructTreeRoot'),doc.context.obj({K:[{
  Type:'StructElem',S:'Span',Lang:PDFString.of('ko'),Pg:page.ref,K:{Type:'MCR',MCID:0,Stm:form},
 }]}));
 const before=await doc.save(),edit=overlay({text:'ABCDE骨'}),inPlaceFallback={loadFont};
 const result=await exportPdf(before,model([edit]),{mode:'flatten',stage5Reflow:false,inPlaceFallback});
 let out=await PDFDocument.load(result.bytes),outcomes=result.contentTextOutcomes;
 if(structure){
  // The writer can read /Lang in the source's /K even after copying its
  // page. Export still refuses the edit because the Form has no ParentTree entry.
  expect(outcomes).toMatchObject([{mode:'unsupported',reason:'semantic-dependency'}]);
  expect(result.semanticChanges).toContainEqual(expect.objectContaining({action:'refused',reason:'semantic-unresolved'}));
  expect(result.bytes).toEqual(before);
  out=await PDFDocument.create();
  const [copied]=await out.copyPages(doc,[0]);
  out.addPage(copied!);
  preserveSourceFontPage(copied!,page);
  outcomes=(await applyContentTextEdits(copied!,[edit],{loadFont,stage5Reflow:false})).outcomes;
  out=await PDFDocument.load(await out.save());
 }
 expect(outcomes?.[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:`NotoSans${region}-Regular.otf`}});
 const content=inspectRunPage(out.getPage(0));
 expect(content.ok&&new TextDecoder().decode(content.bytes)).toMatch(/0 -65 cm.*\/Fm Do/su);
});
