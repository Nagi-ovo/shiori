import { expect, test } from 'bun:test';
import { assertReplacementGlyphs } from './glyphEvidence';
const glyph = { unicode: 'A', replacement: true, glyphId: 1, pathSegments: 3, inkPixels: 10 };
test('native evidence accepts visible replacement and exempts only whitespace', () => {
  expect(() => assertReplacementGlyphs([glyph, { ...glyph, unicode: ' ', pathSegments: 0, inkPixels: 0 }])).not.toThrow();
});
for (const evidence of [{ glyphId: 0 }, { glyphId: undefined }, { glyphId: 1.5 }, { glyphId: -1 }, { pathSegments: 0 }, { inkPixels: 0 }, { pathSegments: undefined }, { inkPixels: undefined }]) {
  test(`native evidence refuses absent/blank replacement: ${JSON.stringify(evidence)}`, () => {
    expect(() => assertReplacementGlyphs([{ ...glyph, ...evidence }])).toThrow();
  });
}
test('untouched glyphs are outside replacement presence check', () => {
  expect(() => assertReplacementGlyphs([{ unicode: 'A', replacement: false }])).not.toThrow();
});
