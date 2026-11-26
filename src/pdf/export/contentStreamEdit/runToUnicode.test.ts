import { expect, test } from 'bun:test';
import { runToUnicode } from './runToUnicode';

const mapping = '1 beginbfchar <41> <0041> endbfchar';
for (const codespace of [
  '2 begincodespacerange <00> <ff> endcodespacerange',
  '1 begincodespacerange <80> <ff> endcodespacerange',
  '1 begincodespacerange <ff> <00> endcodespacerange',
  '1 begincodespacerange <0000> <00FF> endcodespacerange',
  '1 begincodespacerange <000041> <000042> endcodespacerange',
  '1 begincodespacerange <000000> <00FFFF> endcodespacerange',
  '1 begincodespacerange <00000000> <00FFFFFF> endcodespacerange',
  '1 begincodespacerange <00> <FFFF> endcodespacerange',
  '1 begincodespacerange <0000> <FF> endcodespacerange',
  '2 begincodespacerange <00> <ff> <00> <ffff> endcodespacerange',
]) test(`rejects malformed or inconsistent codespace: ${codespace}`, () => {
  expect(runToUnicode(codespace + ' ' + mapping, 1)).toBeNull();
});
test.each(['<0000> <FFFF>', '<000000> <FFFFFF>', '<00000000> <FFFFFFFF>'])('accepts wider codespace %s with explicit one-byte source codes', range => {
  const result = runToUnicode(`1 begincodespacerange ${range} endcodespacerange ` +
    '2 beginbfchar <20> <0020> <41> <0041> endbfchar', 1);
  expect([...result!]).toEqual([[0x20, ' '], [0x41, 'A']]);
});
test.each(['<000000> <FFFFFF>', '<00000000> <FFFFFFFF>'])('complete codespace %s accepts two-byte source codes', range => {
  expect([...runToUnicode(`1 begincodespacerange ${range} endcodespacerange ` +
    '1 beginbfchar <0041> <0041> endbfchar', 2)!]).toEqual([[0x41, 'A']]);
});
test('a shorter codespace does not contain a longer source code', () => {
  expect(runToUnicode('1 begincodespacerange <00> <ff> endcodespacerange ' +
    '1 beginbfchar <0041> <0041> endbfchar', 2)).toBeNull();
});
test('retains same-width two-byte source mappings', () => {
  expect([...runToUnicode('1 begincodespacerange <0000> <FFFF> endcodespacerange ' +
    '1 beginbfchar <0041> <0041> endbfchar', 2)!]).toEqual([[0x41, 'A']]);
});
for (const source of [
  '1 beginbfchar <0041> <0041> endbfchar',
  '1 beginbfrange <0041> <0042> <0041> endbfrange',
  '1 beginbfrange <41> <0042> <0041> endbfrange',
]) test(`rejects two-byte source codes in a one-byte font: ${source}`, () => {
  expect(runToUnicode('1 begincodespacerange <0000> <FFFF> endcodespacerange ' + source, 1)).toBeNull();
});
test('supports bfchar, scalar and array bfrange mappings with valid codespace', () => {
  const result = runToUnicode('1 begincodespacerange <00> <ff> endcodespacerange ' + mapping +
    ' 1 beginbfrange <42> <43> <0042> endbfrange 1 beginbfrange <44> <45> [<0044> <d83dde00>] endbfrange', 1);
  expect([...result!]).toEqual([[65, 'A'], [66, 'B'], [67, 'C'], [68, 'D'], [69, '😀']]);
});
for (const bad of [
  '1 beginbfchar <41> <d800> endbfchar',
  '1 beginbfchar <41> <dc00> endbfchar',
  '1 beginbfchar <41> <0000> endbfchar',
  '2 beginbfchar <41> <0041> <41> <0042> endbfchar',
  '1 beginbfchar <41> <0041> endbfchar 1 beginbfrange <41> <42> <0041> endbfrange',
  '1 beginbfrange <41> <42> <ffff> endbfrange',
]) test(`rejects invalid Unicode, conflicting codes or inherited maps: ${bad}`, () => {
  expect(runToUnicode(bad, 1)).toBeNull();
});
