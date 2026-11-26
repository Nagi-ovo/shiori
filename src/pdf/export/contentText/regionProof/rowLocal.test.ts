import {expect,test} from 'bun:test';
import {rowLocalFixture,requireRowEvidence} from '../reflowRowLocal.test-support';
import {glyphKey} from './occupancy';
import {proveRowLocalSlot} from './rowLocal';
import {subtractRectangles} from './geometry';

test('rectangle subtraction proves union coverage without filling holes or protruding slivers',()=>{
 const subject={x:0,y:0,w:4,h:4};
 expect(subtractRectangles(subject,[{x:0,y:0,w:2,h:4},{x:2,y:0,w:2,h:4}])).toEqual([]);
 expect(subtractRectangles(subject,[{x:-1,y:-1,w:4,h:6},{x:2,y:0,w:3,h:4}])).toEqual([]);
 expect(subtractRectangles(subject,[{x:0,y:0,w:1,h:4},{x:3,y:0,w:1,h:4}])).toEqual([{x:1,y:0,w:2,h:4}]);
 expect(subtractRectangles(subject,[{x:0,y:0,w:4-1e-8,h:4}])).toHaveLength(1);
 expect(subtractRectangles(subject,[{x:1,y:1,w:2,h:2}]).reduce((n,b)=>n+b.w*b.h,0)).toBe(12);
 expect(subtractRectangles(subject,[])).toEqual([subject]);
});
for(const failure of ['blocked','refusal','count-two','unmeasured','unembedded','interleaved']as const)test(`row-local authority fails closed: ${failure}`,async()=>{
 const f=await rowLocalFixture(),e=requireRowEvidence(f),owners=new Set(e.source.map(t=>glyphKey(t.source!))),group={...e.visualGroup};
 const lines=[...e.lines];
 if(failure==='blocked')e.occupancy.pageBlocked=true;
 if(failure==='refusal')group.refusal='Source/geometry order inversion';
 if(failure==='count-two')lines.push(lines[0]!);
 if(failure==='unmeasured')e.occupancy.glyphs.get(owners.values().next().value!)!.ink=undefined;
 if(failure==='unembedded')e.occupancy.embeddedFonts.clear();
 if(failure==='interleaved')owners.delete(glyphKey(e.source[1]!.source!));
 expect(proveRowLocalSlot(group,lines,e.occupancy,owners,e.trace.ends).ok).toBe(false);
});
test('row-local authority never borrows a longer preceding row or a witnessed column edge',async()=>{
 const f=await rowLocalFixture(),e=requireRowEvidence(f),owners=new Set(e.source.map(t=>glyphKey(t.source!)));
 const result=proveRowLocalSlot({...e.visualGroup,capacityRight:250},e.lines,e.occupancy,owners,e.trace.ends);
 expect(result).toMatchObject({ok:true,slot:{left:50,right:74,kind:'observed-row'}});
});
