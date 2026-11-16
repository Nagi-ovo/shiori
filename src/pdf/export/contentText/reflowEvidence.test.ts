import {expect,test} from 'bun:test';
import {spacingPage} from './reflowApply.test-support';
import {regionStream} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {streamReflowEvidence} from './reflowEvidence';
import {traceReflowSource} from './reflowTrace';
import {lastPositionAnchor,validTrace} from './regionProof/geometry';

const enc=new TextEncoder();
const artifact='/Artifact <</Type /Pagination /Subtype /Footer /BBox [0 0 300 200]>> BDC';
test('a safe MCID show inherits its line anchor across Artifact EMC',async()=>{
 const stream=`BT /F1 10 Tf 14 TL 1 0 0 1 20 100 Tm ${artifact} 1 0 0 1 50 150 Tm EMC /Span <</MCID 0>> BDC (S i) Tj EMC ET`;
 const f=await spacingPage(stream),content=enc.encode(stream),fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(content);
 const target=ops.findIndex(op=>op.operator==='Tj'),trace=traceReflowSource(ops,fonts,'revision');
 const show=trace.shows.get(`${target}:-1`)!.before,anchor=lastPositionAnchor([...trace.anchors.values()],show);
 expect(validTrace(show)).toBe(true);
 expect(anchor).toMatchObject({opIndex:ops.findLastIndex(op=>op.operator==='Tm'),tm:[1,0,0,1,50,150],scopeSafe:false});
 const result=streamReflowEvidence(f.page,content,fonts,target);
 expect(result.ok).toBe(true);
 if(!result.ok)throw Error(result.detail);
 expect(result.lines[0]!.anchor).toMatchObject({tm:[1,0,0,1,50,150],scopeSafe:false});
 expect(result.proof.lineSlots).toMatchObject([{left:50,baseline:150}]);
});
test.each(['1 .2 0 1 0 0 cm','0 1 -1 0 0 0 cm','1 Tr','2 Tr','3 Tr','/F1 0 Tf','/Missing 10 Tf'])('latest invalid Artifact anchor cannot fall back: %s',async state=>{
 const stream=`BT /F1 10 Tf 14 TL 1 0 0 1 20 100 Tm q ${state} ${artifact} 1 0 0 1 50 150 Tm EMC Q /Span <</MCID 0>> BDC (S i) Tj EMC ET`;
 const f=await spacingPage(stream),content=enc.encode(stream),fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(content);
 const target=ops.findIndex(op=>op.operator==='Tj'),trace=traceReflowSource(ops,fonts,'revision'),show=trace.shows.get(`${target}:-1`)!.before;
 expect(validTrace(show)).toBe(true);expect(lastPositionAnchor([...trace.anchors.values()],show)).toBeUndefined();
 expect(streamReflowEvidence(f.page,content,fonts,target)).toMatchObject({ok:false,gate:'missing-line-anchor'});
});
test('anchors from another BT or with nonfinite geometry cannot replace the latest anchor',async()=>{
 const content=enc.encode('BT /F1 10 Tf 50 150 Td (S i) Tj ET BT /F1 10 Tf (S i) Tj ET'),f=await spacingPage(new TextDecoder().decode(content));
 const trace=traceReflowSource(tokenizeContentStream(content),resolveRunFonts(f.page),'revision'),anchors=[...trace.anchors.values()],shows=[...trace.shows.values()];
 expect(lastPositionAnchor(anchors,shows[1]!.before)).toBeUndefined();
 expect(lastPositionAnchor([{...anchors[0]!,tm:[1,0,0,1,NaN,150]}],shows[0]!.before)).toBeUndefined();
});
test.each(['/OC BMC','/OC <</MCID 0>> BDC',artifact,'/Artifact BMC'])('unsafe %s shows still refuse target-state',async scope=>{
 const stream=`BT /F1 10 Tf 14 TL 1 0 0 1 50 150 Tm ${scope} (S i) Tj EMC ET`;
 const f=await spacingPage(stream),content=enc.encode(stream),fonts=resolveRunFonts(f.page),ops=tokenizeContentStream(content);
 expect(streamReflowEvidence(f.page,content,fonts,ops.findIndex(op=>op.operator==='Tj'))).toMatchObject({ok:false,gate:'target-state'});
});

test('production reports the failing evidence gate without granting a region',async()=>{
 const f=await spacingPage('1 Tr '+regionStream()),s=inspectRunPage(f.page);
 if(!s.ok)throw Error(s.reason);
 const target=tokenizeContentStream(s.bytes).findIndex(op=>op.operator==='Tj');
 expect(streamReflowEvidence(f.page,s.bytes,resolveRunFonts(f.page),target)).toMatchObject({ok:false,gate:'target-state'});
});
