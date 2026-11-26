import {afterEach,expect,test} from 'bun:test';
import {bareSideNote,identityScenarios,lone,runUnobserved,sideNote,titleBy} from './retypesetPainted.test-support';
import {title} from './retypesetChain.scenarios.test-support';
import {retypesetPaintedLive} from './retypesetPainted';
import {RETYPESET_ENVELOPE_FLOOR} from './retypesetEnvelope';

// r32 P2-B live failure list, written before enabling painted coverage
// (the shadow list is in retypesetPaintedShadow.test.ts):
// (1) a rotated stationary glyph whose painted envelope misses the new ink
//     still flags the row (the whole-page CropBox box);
// (2) clearing that flag moves, re-lays or rewrites anything;
// (3) a glyph with no outline, declared or Standard 14 envelope is read as
//     empty and its row cleared;
// (4) a glyph whose painted envelope does meet the new ink is cleared;
// (5) a row that is already a push, chain push, frame tighten or envelope
//     fit, or is already clear, changes in any byte or manifest field;
// (6) an own-band envelope on a page with such a glyph claims width or
//     height past its own ink, or goes below the .85 floor;
// (7) a page with no such glyph changes at all.
const enabled=retypesetPaintedLive.enabled;
afterEach(()=>{retypesetPaintedLive.enabled=enabled;});
async function both(stream:string,edit?:Parameters<typeof runUnobserved>[1],opts:{image?:boolean}={}){
 retypesetPaintedLive.enabled=false;const off=await runUnobserved(stream,edit,opts);
 retypesetPaintedLive.enabled=true;const on=await runUnobserved(stream,edit,opts);
 return{off,on};
}

test('a margin note whose painted envelope misses the wrapped row no longer flags it, and nothing moves',async()=>{
 const {off,on}=await both(title+sideNote);
 expect(off.m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(on.m).toMatchObject({pushed:false,pushedDeltaPt:0,overflowInkOverlap:false,quality:{overflowInkOverlap:false}});
 expect(on.m.fitStrategy).toBeUndefined();expect(on.m.pushReason).toBeUndefined();
 // Clearing a false flag writes exactly the bytes the flagged row wrote.
 expect(on.bytes).toEqual(off.bytes);
 // And reports what the same edit reports on the page without the note.
 const clean=await runUnobserved(title);
 expect(on.m).toMatchObject({lineCount:clean.m.lineCount,overflowed:clean.m.overflowed,overflowInkOverlap:false});
});

test('a margin note with no envelope stays unknown and keeps the row flagged',async()=>{
 const {off,on}=await both(title+bareSideNote);
 expect(on.m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(on.m.pushReason).toBe(off.m.pushReason!);
 expect(on.bytes).toEqual(off.bytes);
});

test('a note the wrapped row really meets keeps the row flagged',async()=>{
 const {off,on}=await both(title+'BT /F1 8 Tf 0 1 -1 0 62 110 Tm (NOTE) Tj ET 0.4 w 10 105 m 290 105 l S ',titleBy('ABCDEFGHIJKLM'));
 expect(on.m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(on.m.pushReason).toBe(off.m.pushReason!);
 expect(on.bytes).toEqual(off.bytes);
});

for(const [name,c]of Object.entries(identityScenarios))test(`live: the ${name} row is byte- and manifest-identical`,async()=>{
 const {off,on}=await both(c.stream,c.edit,{image:c.image});
 expect(on.m).toEqual(off.m);
 expect(on.bytes).toEqual(off.bytes);
});

test('a one-line block on a page with a margin note compacts inside its own band',async()=>{
 const grow=(s:string)=>['EEEE FFFF GGGG HHHH','EEEE FFFF GGGG HHHH'+s,10,[49,136,116,11]] as [string,string,number,number[]];
 const {off,on}=await both(lone+sideNote,grow('I'));
 expect(off.m).toMatchObject({pushed:false,overflowInkOverlap:true});expect(off.m.fitStrategy).toBeUndefined();
 expect(on.m).toMatchObject({pushed:false,overflowInkOverlap:false,fitStrategy:'fit-envelope',lineCount:1});
 expect(on.m.envelopeFit).toMatchObject({basis:'own-band'});
 expect(on.m.envelopeFit!.sizeScale).toBeGreaterThanOrEqual(RETYPESET_ENVELOPE_FLOOR);
 // Same fit, envelope and glyph positions as the page without the note.
 const clean=await runUnobserved(lone,grow('I'));
 expect(on.m.envelopeFit).toEqual(clean.m.envelopeFit!);
 const line=(gs:typeof on.glyphs)=>gs.filter(g=>g.state.fontSize===10).map(g=>[g.text,g.x,g.y]);
 expect(line(on.glyphs)).toEqual(line(clean.glyphs));
 // The note itself never moves.
 const note=(gs:typeof on.glyphs)=>gs.filter(g=>g.state.fontSize===8).map(g=>[g.text,g.x,g.y]);
 expect(note(on.glyphs)).toEqual(note(off.glyphs));
});
