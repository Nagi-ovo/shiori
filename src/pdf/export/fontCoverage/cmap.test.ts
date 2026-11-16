import { expect, test } from 'bun:test';
import { parseCMap } from './cmap';

test('sequential bfrange increments big-endian bytes and preserves width',()=>{
  const parsed=parseCMap('1 beginbfrange <0001> <0003> <00ff> endbfrange');
  expect([...parsed.unicode]).toEqual([['0001','ÿ'],['0002','Ā'],['0003','ā']]);
});
test('comments and PostScript dictionaries do not confuse section parsing',()=>{
  expect(parseCMap('/CIDSystemInfo << /Ordering (UCS) >> def % comment\n1 beginbfchar <01> <0041> endbfchar').unicode.get('01')).toBe('A');
});
// Short codes require a complete wider space; numeric inclusion alone loses
// byte identity. Codespaces describe bounds without expanding every code.
test.each(['<0000> <FFFF>', '<000000> <FFFFFF>', '<00000000> <FFFFFFFF>'])('complete codespace %s accepts shorter explicit sources',range=>{
  const parsed=parseCMap(`1 begincodespacerange ${range} endcodespacerange 1 beginbfchar <41> <0041> endbfchar`);
  expect([...parsed.unicode]).toEqual([['41','A']]);
});
test.each([
  ['<40> <4F>', '4a'], ['<0000> <FFFF>', '0041'],
  ['<000000> <FFFFFF>', 'ffffff'], ['<00000000> <FFFFFFFF>', 'ffffffff'],
])('same-width codespace %s retains source %s', (range,key)=>{
  expect(parseCMap(`1 begincodespacerange ${range} endcodespacerange 1 beginbfchar <${key}> <0041> endbfchar`).unicode.get(key)).toBe('A');
});
test.each([
  ['<0000> <00FF>', '41'], ['<000041> <000042>', '41'],
  ['<000000> <00FFFF>', '41'], ['<00000000> <00FFFFFF>', '41'],
  ['<00> <FFFF>', '41'], ['<0000> <FF>', '41'],
  ['<00> <FF>', '0041'], ['<42> <FF>', '41'], ['<00> <40>', '41'],
])('codespace %s refuses incompatible source %s',(range,key)=>{
  expect(()=>parseCMap(`1 begincodespacerange ${range} endcodespacerange 1 beginbfchar <${key}> <0041> endbfchar`)).toThrow();
});
test('an unequal-width codespace invalidates an otherwise matching map',()=>{
  expect(()=>parseCMap('2 begincodespacerange <00> <ff> <00> <ffff> endcodespacerange 1 beginbfchar <41> <0041> endbfchar')).toThrow();
});
test('a wide codespace does not relax mapping expansion limits',()=>{
  expect(()=>parseCMap('1 begincodespacerange <00000000> <FFFFFFFF> endcodespacerange 1 beginbfrange <000000> <010000> <0041> endbfrange')).toThrow();
});
for(const source of [
  '1 beginbfrange <01> <02> [<0041>] endbfrange',
  '1 beginbfchar <0g> <0041> endbfchar',
  '1 beginbfchar <01> <0041>',
  '1 begincidchar <01> -1 endcidchar',
  '1 beginbfrange <02> <01> <0041> endbfrange',
  'endbfchar',
]) test(`invalid CMap raises a bounded parse error: ${source}`,()=>{
  expect(()=>parseCMap(source)).toThrow();
});
