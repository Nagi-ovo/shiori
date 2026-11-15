import { expect, test } from 'bun:test';
import { cffEncodingOffset } from './cffEncodingOffset';
const table = { offset: 10, length: 20 };
for (const encoding of [{}, { _startOffset: undefined }, { _startOffset: null }, { _startOffset: '12' }, { _startOffset: 12.5 }, { _startOffset: NaN }, { _startOffset: 9 }, { _startOffset: 30 }]) {
  test(`CFF encoding offset fails closed for ${JSON.stringify(encoding)}`, () => {
    expect(() => cffEncodingOffset(encoding, table)).toThrow('unverified CFF Encoding offset');
  });
}
test('CFF encoding offset accepts only integer offsets within its original table', () => {
  expect(cffEncodingOffset({ _startOffset: 10 }, table)).toBe(10);
  expect(cffEncodingOffset({ _startOffset: 29 }, table)).toBe(29);
  expect(() => cffEncodingOffset({ _startOffset: 12 }, undefined)).toThrow('unverified CFF Encoding offset');
});
