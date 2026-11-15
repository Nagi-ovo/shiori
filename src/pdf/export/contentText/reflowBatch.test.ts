import {expect,test} from 'bun:test';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {spacingPage} from './reflowApply.test-support';
import {overlay} from './fixtures.test-support';
import {planContentText} from './planner';
import {planOriginalSlotSpacing} from './spacingPlan';
import {compilePageReflows} from './reflowBatch';

test('a mixed recipe batch preserves the explicit fixed edit-box cap',async()=>{
 const f=await spacingPage('BT /F1 10 Tf 1 0 0 1 50 100 Tm (Sni) Tj ET BT /F1 10 Tf 1 0 0 1 50 70 Tm (S) Tj ET');
 const source=inspectRunPage(f.page);if(!source.ok)throw Error(source.reason);const fonts=resolveRunFonts(f.page);
 const a=planContentText(source.bytes,fonts,overlay({originalText:'S',text:'an',coverRects:[{x:49.9,y:98,w:10.2,h:12}]}));
 const b=planContentText(source.bytes,fonts,overlay({originalText:'S',text:'a',coverRects:[{x:49.9,y:68,w:10.2,h:12}]}));
 if(!a.ok||!b.ok)throw Error('fixture planning failed');const p=planOriginalSlotSpacing(f.page,source.bytes,fonts,a.plan);if(!p?.reflow)throw Error('missing recipe');
 const edits=[...p.edits,...b.plan.edits.map(e=>({...e,editBox:{x:50,y:68,w:1,h:12}}))];
 expect(compilePageReflows(source.bytes,fonts,{...b.plan,edits,reflows:[p.reflow]})).toMatchObject({ok:false,code:'overflow'});
});
