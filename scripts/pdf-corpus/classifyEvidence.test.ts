import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {spacingPage} from '../../src/pdf/export/contentText/reflowApply.test-support';
import {regionStream} from '../../src/pdf/export/contentText/reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {streamReflowEvidence} from '../../src/pdf/export/contentText/reflowEvidence';
import {explainEvidence} from './evidenceGate';

for(const fixture of ['relative-sibling-BTs','tagged','paint','Tr1','Tr2','missing-ink','FontFile3'] as const)
 test(`classifier uses the production evidence gate: ${fixture}`,async()=>{
  const f=await spacingPage((fixture==='Tr1'?'1 Tr ':fixture==='Tr2'?'2 Tr ':'')+
   regionStream(fixture==='tagged',fixture==='paint'?' 0 0 1 1 re f ':''));
  if(fixture==='missing-ink'||fixture==='FontFile3'){
   const descriptor=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict).lookup(PDFName.of('FontDescriptor'),PDFDict);
   descriptor.delete(PDFName.of('FontFile2'));
   if(fixture==='FontFile3')descriptor.set(PDFName.of('FontFile3'),f.doc.context.register(f.doc.context.flateStream('unknown',{Subtype:'Type1C'})));
  }
  const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
  const fonts=resolveRunFonts(f.page),target=tokenizeContentStream(s.bytes).findIndex(op=>op.operator==='Tj');
  const actual=streamReflowEvidence(f.page,s.bytes,fonts,target),diagnostic=explainEvidence(f.page,s.bytes,fonts,target);
  expect(actual).toHaveProperty('ok');
  if(actual.ok){expect(diagnostic).toEqual({gate:'region-proved'});}
  else expect(diagnostic).toEqual({gate:actual.gate,blocker:actual.blocker,detail:actual.detail});
  if(fixture==='relative-sibling-BTs'||fixture==='tagged')expect(actual.ok).toBe(true);
  if(['Tr1','Tr2','missing-ink','FontFile3'].includes(fixture))expect(actual.ok).toBe(false);
 });
