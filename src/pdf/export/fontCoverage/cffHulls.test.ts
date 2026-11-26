import {expect,test} from 'bun:test';
import {cffHullMatrix,isCffProgram} from './cffHulls';
import {sfnt,tinyCff,tinyTtf} from './fixtures/programs';

// Failure inventory: parser-supplied absent/default FD and top matrices must
// allow the default text-space transform. A different FD matrix is unproved;
// finite top transforms are applied to hulls, never ignored for a /1000 box.
const identity=[.001,0,0,.001,0,0];
test.each([[undefined],[identity]])('default FD matrix %j supports a proved CFF hull',matrix=>{
 expect(cffHullMatrix({FDArray:[{FontMatrix:matrix}]})).toEqual(identity);
 expect(cffHullMatrix({FontMatrix:identity,FDArray:[{FontMatrix:matrix}]})).toEqual(identity);
});
test.each([[[2,0,0,2,0,0]],[[.001,0,0,.001,1,0]],[[.001,0,0]],[[NaN,0,0,.001,0,0]]])('unsupported FD matrix %j leaves CFF hull unknown',matrix=>{
 expect(cffHullMatrix({FDArray:[{}, {FontMatrix:matrix}]})).toBeUndefined();
});
test('a supported nonstandard top matrix is retained for the hull transform',()=>{
 const top=[.002,0,.001,.003,1,-1];
 expect(cffHullMatrix({FontMatrix:top,FDArray:[{FontMatrix:identity}]})).toEqual(top);
});
test.each([[[.001,0,0]],[[.001,0,0,Infinity,0,0]]])('invalid top matrix %j leaves CFF hull unknown',matrix=>{
 expect(cffHullMatrix({FontMatrix:matrix})).toBeUndefined();
});
test('CFF matrix risk is known from raw and sfnt containers even before glyph parsing',()=>{
 expect(isCffProgram(tinyCff())).toBe(true);
 expect(isCffProgram(sfnt({'CFF ':tinyCff()},true))).toBe(true);
 expect(isCffProgram(sfnt({'CFF ':new Uint8Array()},true))).toBe(true);
 expect(isCffProgram(tinyTtf())).toBe(false);
 expect(isCffProgram(new Uint8Array())).toBe(false);
});
