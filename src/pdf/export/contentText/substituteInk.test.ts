import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {PDFName} from 'pdf-lib';
import {applyContentTextEdits} from './apply';
import {acceptsSourceInk,sourceInkCases,sourceInkFixture} from './substituteInk.test-support';

for(const name of sourceInkCases)test(`source ink proof: ${name}`,async()=>{
 const f=await sourceInkFixture(name),resources=f.page.node.Resources(),contents=f.page.node.get(PDFName.of('Contents'));
 const count=f.doc.context.enumerateIndirectObjects().length;let loads=0;
 const result=await applyContentTextEdits(f.page,[f.edit],{stage5Reflow:false,stage5Type1:{sourceReuse:false},loadFont:async font=>{
  loads++;return readFile(`node_modules/@docx-editor.dev/fonts/assets/${font}`);
 }});
 if(acceptsSourceInk(name)){
  expect(result.outcomes).toEqual([{overlayId:'edit',mode:'substituted'}]);expect(result.remaining).toEqual([]);expect(loads).toBe(1);
 }else{
  expect(result.outcomes[0]).toMatchObject({mode:'overlay',reason:'overflow'});expect(result.remaining).toEqual([f.edit]);expect(loads).toBe(0);
  if(name==='width-only-overhang'||name==='seac-no-bbox')expect(result.outcomes[0]?.detail).toBe('source ink bounds unproved');
  expect(f.page.node.Resources()).toBe(resources);expect(f.page.node.get(PDFName.of('Contents'))).toBe(contents);
  expect(f.doc.context.enumerateIndirectObjects().length).toBe(count);
 }
});
