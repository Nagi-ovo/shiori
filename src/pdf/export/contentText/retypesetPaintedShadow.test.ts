import {afterEach,beforeEach,expect,test} from 'bun:test';
import {identityScenarios,runPainted,runUnobserved,sideNote,bareSideNote,titleBy} from './retypesetPainted.test-support';
import {title} from './retypesetChain.scenarios.test-support';
import {retypesetPaintedLive} from './retypesetPainted';

// r32 P2-B failure list, written before the shadow. Painted coverage for
// a stationary glyph `retypesetInk` leaves unknown (a non-horizontal glyph
// gets the whole CropBox) can go wrong in these ways:
// (1) the painted re-plan of an existing push, chain push, frame tighten,
//     or witnessed / own-band envelope fit is not the same plan (moved set,
//     delta, byte patches, regions, overlap flag, reason);
// (2) merely observing the shadow changes the written bytes;
// (3) a glyph without an outline, declared or Standard 14 envelope is
//     given one (or read as empty) instead of staying unknown;
// (4) the painted box does not replace the whole-page box for a rotated
//     glyph that has an envelope, so the shadow cannot see the false flag;
// (5) a page with no such glyph gets a different painted map at all.
// Live-mode failures are listed in retypesetPaintedLive.test.ts. These
// tests pin shadow mode: painted ink is observed, never used.
const enabled=retypesetPaintedLive.enabled;
beforeEach(()=>{retypesetPaintedLive.enabled=false;});
afterEach(()=>{retypesetPaintedLive.enabled=enabled;});

for(const [name,c]of Object.entries(identityScenarios))test(`shadow: the ${name} row re-plans identically on painted ink`,async()=>{
 const r=await runPainted(c.stream,c.edit,{image:c.image}),u=await runUnobserved(c.stream,c.edit,{image:c.image});
 expect(r.seen).toHaveLength(1);
 const o=r.seen[0]!;
 expect(o.strategy).toBe(c.strategy);
 expect(r.m.fitStrategy??'none').toBe(c.strategy==='push'?'none':c.strategy);
 // Only the rotated chain pages carry a glyph painted coverage changes.
 expect(o.changed>0).toBe(!!c.rotated);
 expect(o.same).toBe(true);
 expect(r.bytes).toEqual(u.bytes);
});

test('shadow: a rotated margin note with an envelope is seen as a false whole-page flag, and output is unchanged',async()=>{
 const r=await runPainted(title+sideNote),u=await runUnobserved(title+sideNote);
 // Today: the wrapped title meets the whole-page box, so the row is flagged.
 expect(r.m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(r.seen).toHaveLength(1);
 const o=r.seen[0]!;
 expect(o).toMatchObject({strategy:'none',changed:9,flagged:true,paintedClear:true,same:false});
 expect(o.painted.pushed).toBe(false);
 expect(r.bytes).toEqual(u.bytes);
 // Without the note the same edit is a clear wrap with identical bytes for the title.
 const clean=await runUnobserved(title);
 expect(clean.m).toMatchObject({pushed:false,overflowInkOverlap:false});
});

test('shadow: a rotated note with no envelope stays unknown, so painted coverage changes nothing',async()=>{
 const r=await runPainted(title+bareSideNote);
 expect(r.m).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(r.seen[0]).toMatchObject({changed:0,flagged:true,paintedClear:false,same:true});
});

test('shadow: a note the wrapped row really meets stays flagged on painted ink',async()=>{
 // Turned 90 degrees under the wrapped L (x ~56..62, y ~110..130), above a
 // full-width rule it cannot be pushed past.
 const r=await runPainted(title+'BT /F1 8 Tf 0 1 -1 0 62 110 Tm (NOTE) Tj ET 0.4 w 10 105 m 290 105 l S ',titleBy('ABCDEFGHIJKLM'));
 expect(r.m.overflowInkOverlap).toBe(true);
 expect(r.seen[0]).toMatchObject({flagged:true,paintedClear:false});
 expect(r.seen[0]!.painted).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(r.seen[0]!.changed).toBeGreaterThan(0);
});
