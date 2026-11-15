import { expect, test } from 'bun:test';
import { assertReplacementGlyphs } from './glyphEvidence';
const outline = [{ type: 2, point: [0, 0], closed: false }, { type: 0, point: [100, 0], closed: true }];
const missing = [{ type: 2, point: [0, 0], closed: false }, { type: 0, point: [10, 0], closed: true }];
const probes = [{ scalar: 0xfffe, path: missing }, { scalar: 0xffff, path: missing }];
const glyph = { nativePath: outline, notdefProbes: probes, unicode: 'A', replacement: true, glyphId: 1, pathSegments: outline.length, inkPixels: 10 };
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

test('inked native .notdef fails even with a forged positive coverage GID', () => {
  expect(() => assertReplacementGlyphs([{ ...glyph, glyphId: 7, nativePath: missing, pathSegments: missing.length }])).toThrow('native .notdef path match');
});
test('same segment count with different geometry is a real glyph', () => {
  expect(() => assertReplacementGlyphs([{ ...glyph, pathSegments: outline.length }])).not.toThrow();
});
for (const notdefProbes of [undefined, [], [{ scalar: 0xffff, path: missing }]]) {
  test('missing native probe evidence fails closed', () => {
    expect(() => assertReplacementGlyphs([{ ...glyph, notdefProbes }])).toThrow('native .notdef probe unavailable');
  });
}
test('disagreeing native probe paths fail closed', () => {
  expect(() => assertReplacementGlyphs([{ ...glyph, notdefProbes: [probes[0]!, { scalar: 0xffff, path: outline }] }])).toThrow('native .notdef probe ambiguous');
});
test('absent native path and inconsistent segment count fail as blank evidence', () => {
  for (const nativePath of [undefined, null, []]) {
    expect(() => assertReplacementGlyphs([{ ...glyph, nativePath }])).toThrow('absent/blank native replacement glyph');
  }
});
test('path segment type and closure are part of native geometry comparison', () => {
  for (const nativePath of [
    missing.map((p, i) => i === 1 ? { ...p, type: 1 } : p),
    missing.map((p, i) => i === 1 ? { ...p, closed: false } : p),
  ]) expect(() => assertReplacementGlyphs([{ ...glyph, nativePath, pathSegments: nativePath.length }])).not.toThrow();
});
test('a native .notdef failure has a specific discriminator code', () => {
  let caught: unknown;
  try { assertReplacementGlyphs([{ ...glyph, glyphId: 7, nativePath: missing, pathSegments: missing.length }]); }
  catch (error) { caught = error; }
  expect(caught).toMatchObject({ code: 'native-notdef-match' });
});
test('native proof can be checked independently while coverage validation still rejects a missing GID',async()=>{
 const {assertNativeReplacementGlyphs}=await import('./glyphEvidence');
 const path=[{type:2,point:[1,1],closed:false}];const probe=[{type:2,point:[0,0],closed:false}];
 const glyph={unicode:'A',replacement:true,nativePath:path,pathSegments:1,inkPixels:1,notdefProbes:[{scalar:65534,path:probe},{scalar:65535,path:probe}]};
 expect(assertNativeReplacementGlyphs([glyph])).toBe(1);
 expect(()=>assertReplacementGlyphs([glyph])).toThrow('unverified coverage GID');
});
