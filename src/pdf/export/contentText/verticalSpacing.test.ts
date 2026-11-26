import {expect,test} from 'bun:test';
import {tightenedColumnOffsets} from './verticalSpacing';
import {intersects} from './regionProof/geometry';

// Failure list: first row moves; rows reverse or collapse below 0.8 em;
// adjacent or taller non-adjacent ink collides; a multi-glyph cell splits;
// malformed geometry produces a candidate; rows expand instead of tighten.
test('spacing candidates keep the anchor and whole cells while separating all ink',()=>{
 const rows=[
  {y:100,boxes:[{x:0,y:99,w:8,h:9}]},
  {y:88,boxes:[{x:0,y:87,w:3,h:4},{x:4,y:87,w:3,h:4}]},
  {y:76,boxes:[{x:0,y:75,w:8,h:9}]},
 ];
 const candidates=[...tightenedColumnOffsets(rows,10,12)];expect(candidates.length).toBeGreaterThan(0);
 for(const offsets of candidates){
  expect(offsets[0]).toBe(0);expect(offsets[2]).toBeGreaterThan(0);
  for(let i=1;i<rows.length;i++)expect(rows[i-1]!.y+offsets[i-1]!-rows[i]!.y-offsets[i]!).toBeGreaterThanOrEqual(8-1e-9);
  const moved=rows.map((r,i)=>r.boxes.map(b=>({...b,y:b.y+offsets[i]!})));
  for(let i=0;i<moved.length;i++)for(let j=i+1;j<moved.length;j++)expect(moved[i]!.some(a=>moved[j]!.some(b=>intersects(a,b)))).toBe(false);
 }
});

test('tall ink is checked against all preceding cells, even across disjoint ink',()=>{
 const rows=[{y:100,boxes:[{x:0,y:85,w:8,h:20}]},{y:88,boxes:[{x:20,y:87,w:3,h:4}]},{y:76,boxes:[{x:0,y:75,w:8,h:9}]}];
 for(const dy of tightenedColumnOffsets(rows,10,12))expect(rows[2]!.boxes[0]!.y+9+dy[2]!).toBeLessThan(85);
});

test('unproved rows and ink that would need expanded spacing give no candidate',()=>{
 for(const rows of [[],[{y:NaN,boxes:[]}],[{y:100,boxes:[{x:0,y:0,w:8,h:100}]},{y:88,boxes:[{x:0,y:87,w:8,h:10}]}]])expect([...tightenedColumnOffsets(rows,10,12)]).toEqual([]);
});
