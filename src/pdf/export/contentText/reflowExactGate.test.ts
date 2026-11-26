import {expect,test} from 'bun:test';
import {type1RegionPage} from './reflowRegion.test-support';
import {applyContentTextEdits} from './apply';
import {overlay} from './fixtures.test-support';

// Failure list (before implementation): a retypeset row loses the exact-tier
// gate that refused it, so corpus refusals cannot be binned; a gate is named
// on an edit that exact-tier accepted; the gate of an earlier attempt leaks
// onto a later accepted retry; the diagnostic changes any mode or reason.
const row=(text:string,y:number)=>`BT /F1 10 Tf 0 TL 50 ${y} Td (${text}) Tj ET `;
const target=row('AB ',136);
const edit=overlay({originalText:'A',text:'AB AB AB AB',coverRects:[{x:49.95,y:135.5,w:6.1,h:8}]});
const run=async(stream:string)=>{
 const f=await type1RegionPage(stream);
 return (await applyContentTextEdits(f.page,[edit])).outcomes[0]!;
};

test('a one-line title without pitch evidence reports grow-down-space-not-proved on its retypeset row',async()=>{
 const outcome=await run(row('AB AB AB ',164)+target);
 expect(outcome).toMatchObject({mode:'retypeset',retypeset:{reason:'overflow',exactGate:'grow-down-space-not-proved'}});
});
test('an edit that exact-tier reflows carries no exact gate',async()=>{
 const outcome=await run([192,178,164].map(y=>row('AB AB AB ',y)).join('')+target);
 expect(outcome.mode).toBe('reflowed');
 expect(outcome.exactGate).toBeUndefined();
});
