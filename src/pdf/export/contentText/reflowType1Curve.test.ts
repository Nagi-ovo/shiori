import {expect,test} from 'bun:test';
import {type1Fixture} from './type1Wiring.test-support';
import {nums,widthChar} from '../fontCoverage/fixtures/type1';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {substituteSourceFonts} from '../contentStreamEdit/substituteSource';
import {substituteInk} from '../contentStreamEdit/substituteInk';
import {streamReflowEvidence} from './reflowEvidence';
import {proveGlyphRegion} from './regionProof/glyphRegion';

// Failure inventory: the corrected Type1 endpoint must reach both source
// ink consumers, the fixed oldInk mask, and occupancy against foreign paint.
// Start (0,0), controls (30,0),(100,200), end (100,240), then up to (100,540).
const curved=Uint8Array.from([...nums(0,600),13,...nums(0,0),21,
 ...nums(30,70,200,40),31,...nums(0,300),5,...nums(-100,0),5,9,14]);
async function evidence(paint=''){
 const f=await type1Fixture({stream:'BT /F1 10 Tf 14 TL 50 100 Td (AB) Tj ET '+paint,
  programOptions:{glyphs:{'.notdef':widthChar(0),A:curved,B:curved}}});
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),e=streamReflowEvidence(f.page,s.bytes,fonts,4);
 if(!e.ok)throw Error(e.detail);
 return {...f,e};
}
test('Type1 curve endpoints bound source ink in reflow, substitution and fixed masks',async()=>{
 const {page,e}=await evidence(),t=e.source[0]!;
 expect(t.ink).toEqual({x:0,y:0,w:1,h:5.4});
 expect(substituteInk(page,substituteSourceFonts(page))('F1',65)).toEqual({x:0,y:0,w:.1,h:.54});
 const origins=e.source.map(t=>[t.original!.x+1,t.original!.y] as const);
 const proof=proveGlyphRegion(e,e.proof,e.source,origins,[]);
 expect(proof?.oldInk).toContainEqual({x:49,y:99,w:3,h:7.4});
});
test('corrected curve ink refuses a destination violating the foreign paint guard',async()=>{
 const clear=await evidence(),blocked=await evidence('65.5 107 .2 .1 re f');
 const move=(e:typeof clear.e)=>{
  const origins=e.source.map(t=>[t.original!.x,t.original!.y] as [number,number]);
  origins[0]=[65,100];return proveGlyphRegion(e,e.proof,e.source,origins,[]);
 };
 expect(move(clear.e)).not.toBeNull();
 expect(move(blocked.e)).toBeNull();
});
