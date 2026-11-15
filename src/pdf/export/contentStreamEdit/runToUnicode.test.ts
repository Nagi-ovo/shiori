import { expect, test } from 'bun:test';
import { runToUnicode } from './runToUnicode';

const mapping = '1 beginbfchar <41> <0041> endbfchar';
for (const codespace of [
  '2 begincodespacerange <00> <ff> endcodespacerange',
  '1 begincodespacerange <0000> <ffff> endcodespacerange',
  '1 begincodespacerange <80> <ff> endcodespacerange',
  '1 begincodespacerange <ff> <00> endcodespacerange',
]) test(`rejects malformed or inconsistent codespace: ${codespace}`, () => {
  expect(runToUnicode(codespace + ' ' + mapping, 1)).toBeNull();
});
test('supports bfchar, scalar and array bfrange mappings with valid codespace', () => {
  const result = runToUnicode('1 begincodespacerange <00> <ff> endcodespacerange ' + mapping +
    ' 1 beginbfrange <42> <43> <0042> endbfrange 1 beginbfrange <44> <45> [<0044> <d83dde00>] endbfrange', 1);
  expect([...result!]).toEqual([[65, 'A'], [66, 'B'], [67, 'C'], [68, 'D'], [69, '😀']]);
});
for (const bad of [
  '1 beginbfchar <41> <d800> endbfchar',
  '2 beginbfchar <41> <0041> <41> <0042> endbfchar',
  '1 beginbfrange <41> <42> <ffff> endbfrange',
]) test(`rejects invalid Unicode, conflicting codes or inherited maps: ${bad}`, () => {
  expect(runToUnicode(bad, 1)).toBeNull();
});
