import {expect,test} from 'bun:test';
import {compareQpdfChecks} from './qpdfOracle';
import {auditQpdfPair} from './qpdfOracle';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {PDFDocument,PDFName,PDFRawStream} from 'pdf-lib';

// Failure list: inherited warnings may disappear, never multiply; an after-only
// message or severity increase must fail even when both commands exit 3.
// qpdf exit 2 (errors) is worse than 3 (warnings); abnormal exits fail closed.
const warning='WARNING: <pdf>: inherited stream warning';
test('qpdf accepts clean output and a subset of inherited diagnostics',()=>{
 expect(compareQpdfChecks({status:0,issues:[]},{status:0,issues:[]})).toEqual({qpdf:'clean'});
 expect(compareQpdfChecks({status:3,issues:[warning,warning]},{status:3,issues:[warning]}))
  .toMatchObject({qpdf:'clean',qpdfSourceIssues:2,qpdfInheritedIssues:1});
 expect(compareQpdfChecks({status:3,issues:[warning]},{status:0,issues:[]})).toMatchObject({qpdf:'clean'});
});
test('qpdf rejects new messages, extra occurrences, errors and worse exits',()=>{
 const before={status:3,issues:[warning]};
 for(const after of [
  {status:3,issues:[warning,'WARNING: <pdf>: new problem']},
  {status:3,issues:[warning,warning]},
  {status:2,issues:[warning]},
  {status:3,issues:['ERROR: <pdf>: inherited stream warning']},
 ])expect(()=>compareQpdfChecks(before,after)).toThrow(/qpdf/);
 expect(()=>compareQpdfChecks({status:0,issues:[]},{status:3,issues:[]})).toThrow(/qpdf/);
 for(const status of [null,1,4])expect(()=>compareQpdfChecks(before,{status,issues:[]})).toThrow(/qpdf/);
});

test('real source stream warnings survive shifted offsets/objects but new damaged streams fail',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'shiori-qpdf-'));
 async function fixture(name:string,payloads:string[],shift=false){
  const doc=await PDFDocument.create(),page=doc.addPage([100,100]);
  if(shift)doc.context.register(doc.context.obj({Padding:'object numbers and offsets shift'}));
  const refs=payloads.map(payload=>doc.context.register(PDFRawStream.of(doc.context.obj({Filter:'FlateDecode'}),deflateSync(Buffer.from(payload)).subarray(0,-4))));
  page.node.set(PDFName.of('SourceNoise'),doc.context.obj(refs));
  const path=join(directory,`${name}.pdf`);await writeFile(path,await doc.save({useObjectStreams:false}));return path;
 }
 try{
  const before=await fixture('before',['inherited']);
  const inherited=await fixture('inherited',['inherited'],true);
  expect(await auditQpdfPair(before,inherited)).toMatchObject({qpdf:'clean',qpdfSourceIssues:1,qpdfInheritedIssues:1});
  expect(await auditQpdfPair(before,await fixture('clean',[]))).toMatchObject({qpdf:'clean',qpdfInheritedIssues:0});
  await expect(auditQpdfPair(before,await fixture('extra',['inherited','inherited']))).rejects.toThrow(/qpdf/);
  await expect(auditQpdfPair(before,await fixture('different',['new damage'],true))).rejects.toThrow(/qpdf/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
