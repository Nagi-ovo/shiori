import assert from 'node:assert/strict';

function scalars(text:string){
 const counts=new Map<string,number>();
 for(const scalar of text.replace(/\s/gu,''))counts.set(scalar,(counts.get(scalar)??0)+1);
 return counts;
}
function delta(before:string,after:string){
 const old=scalars(before),actual=scalars(after);
 return [...new Set([...old.keys(),...actual.keys()])].sort().flatMap(scalar=>{
  const count=(actual.get(scalar)??0)-(old.get(scalar)??0);
  return count?[[scalar,count] as const]:[];
 });
}

/** Native local sequence, glyph/ink and untargeted identity were checked first.
 * Poppler independently checks the exact signed scalar delta. Its own source
 * extraction is the baseline: e.g. untouched discretionary hyphens can be '-'
 * in Poppler but U+0002 in PDFium. No character class is discarded/mapped, and
 * neither a missing wrapped character nor an extra copy can cancel baseline
 * disagreement. Spatial order may change when approximate output wraps. */
export function assertRetypesetPopplerText(popplerBefore:string,popplerAfter:string,nativeBefore:string,nativeAfter:string){
 assert.deepEqual(delta(popplerBefore,popplerAfter),delta(nativeBefore,nativeAfter),'Poppler extracted characters mismatch');
 return {popplerComparison:'before-after-scalar-delta' as const,popplerSourceDifferences:delta(nativeBefore,popplerBefore)};
}
