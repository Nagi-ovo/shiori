import {expectRetypeset} from './retypesetAssertions.test';
import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {applyContentTextEdits} from './apply';
import {acceptsSourceInk,sourceInkCases,sourceInkFixture} from './substituteInk.test-support';

for(const name of sourceInkCases)test(`source ink proof: ${name}`,async()=>{
 const f=await sourceInkFixture(name),before=inspectRunPage(f.page);let loads=0;
 const result=await applyContentTextEdits(f.page,[f.edit],{stage5Reflow:false,stage5Type1:{sourceReuse:false},loadFont:async font=>{
  loads++;return readFile(`node_modules/@docx-editor.dev/fonts/assets/${font}`);
 }});
 if(acceptsSourceInk(name)){
  expect(result.outcomes).toEqual([{overlayId:'edit',mode:'substituted',fidelity:'exact'}]);expect(result.remaining).toEqual([]);expect(loads).toBe(1);
 }else{
  expectRetypeset(f.page,result.outcomes[0],before,f.edit.text,'overflow');
  expect(result.remaining).toEqual([]);expect(loads).toBeGreaterThan(0);
 }
});
