import {expect,test} from 'bun:test';
import {shouldSaveCorpusSample} from './saveSamples';
import type {CorpusRow} from './report';

// Failure list: an earlier accepted retypeset suppresses the known page-22
// Form; save exactly one successful allow-listed pair, never refused rows;
// preserve first-per-(file,mode) and all missing-Han samples.
const row=(page:number,mode:CorpusRow['outcome']['mode']='retypeset',kind='same-length'):CorpusRow=>({
 id:'arxiv-2611.17052',category:'latex',page,kind,original:'A',text:'new words',ms:0,outcome:{overlayId:'edit',mode},
});
test('page-22 Form success is saved after earlier page retypesets, once per allow-listed page',()=>{
 const previous=[row(0)],form=row(22);
 expect(shouldSaveCorpusSample(form,previous)).toBe(true);
 previous.push(form);
 expect(shouldSaveCorpusSample(row(22,'retypeset','longer'),previous)).toBe(false);
 expect(shouldSaveCorpusSample(row(22,'unsupported'),[row(0)])).toBe(false);
 expect(shouldSaveCorpusSample(row(21),[row(0)])).toBe(false);
 expect(shouldSaveCorpusSample({...form,id:'other-file'},[{...row(0),id:'other-file'}])).toBe(false);
});
test('first mode and missing-Han samples remain saved without retaining every edit',()=>{
 const first=row(0),previous=[first];
 expect(shouldSaveCorpusSample(first,[])).toBe(true);
 expect(shouldSaveCorpusSample(row(1),previous)).toBe(false);
 expect(shouldSaveCorpusSample(row(1,'in-place'),previous)).toBe(true);
 expect(shouldSaveCorpusSample(row(1,'retypeset','missing-han'),previous)).toBe(true);
 expect(shouldSaveCorpusSample(row(1,'unsupported','missing-han'),previous)).toBe(false);
});
