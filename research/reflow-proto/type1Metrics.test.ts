import {expect,test} from 'bun:test';
import {tinyType1,widthChar} from '../../src/pdf/export/fontCoverage/fixtures/type1';
import {type1ProgramWidths} from './type1Metrics';

test('compares program and dictionary widths in character space and retains precision',()=>{
 const input={subtype:'Type1',...tinyType1({glyphs:{A:widthChar(600)}}),
  firstChar:65,lastChar:65,widths:[599.6],encoding:'StandardEncoding'};
 expect(type1ProgramWidths(input).widths.get(65)).toBe(600);
});
test('a real metrics disagreement is refused rather than rescaled or hidden',()=>{
 const result=type1ProgramWidths({subtype:'Type1',...tinyType1(),firstChar:65,lastChar:66,
  widths:[598,600],encoding:'StandardEncoding'});
 expect(result.widths.has(65)).toBe(false);
 expect(result.widths.get(66)).toBe(600);
 expect(result.failures[0]).toMatchObject({code:'font-metrics-conflict',sourceCode:65});
});
test('a nonstandard FontMatrix is not silently normalized',()=>{
 expect(()=>type1ProgramWidths({subtype:'Type1',...tinyType1(),fontMatrix:[.002,0,0,.002,0,0],
  firstChar:65,lastChar:65,widths:[600]})).toThrow('unsupported-matrix');
});
