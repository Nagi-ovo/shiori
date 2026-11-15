import {expect,test} from 'bun:test';
import {createFontCoverage} from './coverage';
import {assertType1Source,surgicalType1Encoder} from './type1Surgical';
import {tinyType1} from './fixtures/type1';
const f=(differences={65:'A',66:'B'})=>createFontCoverage({subtype:'Type1',...tinyType1(),firstChar:65,widths:[600,600],encoding:{differences},toUnicode:'2 beginbfchar <41> <0041> <42> <0042> endbfchar'},{sourceReuse:true});
test('surgical wrapper makes identity conflict terminal before fallback/permutation',()=>{
  const report=f({65:'B',66:'B'});
  expect(()=>assertType1Source(report,[Uint8Array.of(65)])).toThrow('glyph-identity-conflict');
  expect(()=>surgicalType1Encoder(report)('A')).toThrow('glyph-identity-conflict');
  expect(surgicalType1Encoder(f())('B')).toMatchObject({ok:true,bytes:Uint8Array.of(66)});
});
