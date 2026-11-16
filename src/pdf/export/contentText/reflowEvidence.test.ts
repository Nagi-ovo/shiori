import {expect,test} from 'bun:test';
import {spacingPage} from './reflowApply.test-support';
import {regionStream} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {streamReflowEvidence} from './reflowEvidence';

test('production reports the failing evidence gate without granting a region',async()=>{
 const f=await spacingPage('1 Tr '+regionStream()),s=inspectRunPage(f.page);
 if(!s.ok)throw Error(s.reason);
 const target=tokenizeContentStream(s.bytes).findIndex(op=>op.operator==='Tj');
 expect(streamReflowEvidence(f.page,s.bytes,resolveRunFonts(f.page),target)).toMatchObject({ok:false,gate:'target-state'});
});
