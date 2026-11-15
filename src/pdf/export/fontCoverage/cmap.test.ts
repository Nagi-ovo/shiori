import { expect, test } from 'bun:test';
import { parseCMap } from './cmap';

test('sequential bfrange increments big-endian bytes and preserves width',()=>{
  const parsed=parseCMap('1 beginbfrange <0001> <0003> <00ff> endbfrange');
  expect([...parsed.unicode]).toEqual([['0001','ÿ'],['0002','Ā'],['0003','ā']]);
});
test('comments and PostScript dictionaries do not confuse section parsing',()=>{
  expect(parseCMap('/CIDSystemInfo << /Ordering (UCS) >> def % comment\n1 beginbfchar <01> <0041> endbfchar').unicode.get('01')).toBe('A');
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
