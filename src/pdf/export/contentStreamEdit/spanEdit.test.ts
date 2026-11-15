import { expect, test } from 'bun:test';
import { replaceRuns, sourceFingerprint, type RunEdit, type RunPlan, type ResolvedRunFont } from './replaceRun';
import { createFontCoverage } from '../fontCoverage/coverage';
import { tokenizeContentStream } from './tokenizer';
import { walkTextPlacements } from './textState';
const b = (s: string) => new TextEncoder().encode(s);
const font: ResolvedRunFont = {
  resourceName: 'F1', objectId: '7 0 R', bytesPerCode: 1, widthOf: () => 500,
  ascentEm: .8, descentEm: -.2, unicodeByCode: new Map(Array.from({ length: 95 }, (_, i) => [i + 32, String.fromCharCode(i + 32)])),
  canEncode: text => /[^\x20-\x7e]/.test(text) ? { ok: false, reason: 'not in ASCII source', firstMissing: 'é', offset: 1 } : createFontCoverage({ subtype: 'Type1', baseFont: 'Helvetica', encoding: 'WinAnsiEncoding' }).canEncode(text),
};
const fallback: ResolvedRunFont = { ...font, resourceName: 'Fb', objectId: 'new', bytesPerCode: 2,
  unicodeByCode: new Map([[1, 'é'], [2, ' ']]), widthOf: () => 400,
  canEncode: s => s === 'é' ? { ok: true, bytes: new Uint8Array([0,1]), codes: [new Uint8Array([0,1])], preferredApplied: true }
    : s === ' ' ? { ok: true, bytes: new Uint8Array([0,2]), codes: [new Uint8Array([0,2])], preferredApplied: true }
    : { ok: false, reason: 'missing', firstMissing: s, offset: 0 } };
function edit(start = 1, end = 3, replacement = 'X'): RunEdit {
  return { fontResource: 'F1', fontObject: '7 0 R', opIndex: 3, itemIndex: -1, byteStart: start, byteEnd: end, expected: b('ABCDE'.slice(start,end)), replacement };
}
function run(s: Uint8Array, edits = [edit()], extra: Partial<RunPlan> = {}) {
  return replaceRuns(s, [font], { sourceHash: sourceFingerprint(s), edits, ...extra });
}
function glyphs(s: Uint8Array, fonts = [font, fallback]) {
  const out = walkTextPlacements(tokenizeContentStream(s), { resolveFont: name => {
    const f = fonts.find(f => f.resourceName === name)!;
    return { ...f, ok: true, appliesWordSpacing: f.bytesPerCode === 1 };
  } });
  if (!out.ok) throw Error(out.reason);
  return out.glyphs.map(g => ({ code: g.code, font: g.fontName, x: g.coreQuad[0].x, y: g.coreQuad[0].y }));
}
const source = b('BT /F1 10 Tf 50 100 Td (ABCDE) Tj (Z) Tj 0 -20 Td (Q) Tj ET');
for (const [start,end,replacement,expected] of [[1,3,'X','AXDEZQ'], [0,2,'','CDEZQ'], [3,5,'X','ABCXZQ'], [2,2,'','ABCDEZQ']] as const) {
  test(`partial span ${start}:${end} ${replacement} keeps every untouched origin`, () => {
    const out = run(source, [edit(start,end,replacement)]);
    expect(out.ok).toBe(true);
    const actual = glyphs(out.bytes);
    expect(actual.map(g => String.fromCharCode(g.code)).join('')).toBe(expected);
    for (const g of actual.filter(g => g.code !== 88)) expect(g).toEqual(glyphs(source).find(old => old.code === g.code)!);
  });
}
test('two disjoint spans in one string use original offsets, regardless of edit order', () => {
  const out = run(source, [edit(3,4,'Y'), edit(1,2,'X')]);
  expect(out.ok).toBe(true);
  expect(glyphs(out.bytes).map(g => String.fromCharCode(g.code)).join('')).toBe('AXCYEZQ');
  expect(glyphs(out.bytes).at(-3)).toEqual({ code: 69, font: 'F1', x: 70, y: 100 });
});
test('TJ kerns, tracking, rise, scale and line matrix survive a partial edit in MCID', () => {
  const s = b('BT /F1 10 Tf 2 Tc 4 Tw 80 Tz 3 Ts 20 TL 50 100 Td /P <</MCID 0>> BDC [(ABCDE) -120 (Z)] TJ EMC T* (Q) Tj ET');
  const out = run(s, [{ ...edit(), opIndex: 9, itemIndex: 0 }]);
  expect(out.ok).toBe(true);
  const a = glyphs(out.bytes), old = glyphs(s);
  expect(a.slice(-4)).toEqual(old.slice(-4));
  expect(new TextDecoder().decode(out.bytes)).toContain('-120');
});
test('mixed fallback switches font back and preserves suffix/line origins under Tc/Tw/Tz', () => {
  const s = b('BT /F1 10 Tf 2 Tc 4 Tw 80 Tz 50 100 Td (ABCDE) Tj (Z) Tj 0 -20 Td (Q) Tj ET');
  const out = run(s, [{ ...edit(1,4,'Aé'), opIndex: 6 }], { fallbackFonts: [fallback] });
  expect(out.ok).toBe(true);
  expect(glyphs(out.bytes).map(g => [g.font,g.code])).toEqual([['F1',65],['F1',65],['Fb',1],['F1',69],['F1',90],['F1',81]]);
  glyphs(out.bytes).slice(-3).forEach((g,i) => { const old = glyphs(s).slice(-3)[i]!; expect(g.code).toBe(old.code); expect(g.font).toBe(old.font); expect(g.x).toBeCloseTo(old.x,8); expect(g.y).toBeCloseTo(old.y,8); });
});
test('overflow is explicit and atomic; allowOverflow reports the same measured slot', () => {
  const out = run(source, [edit(1,2,'XX')]);
  expect(out.ok).toBe(false);
  expect(out.bytes).toBe(source);
  if (!out.ok) expect(out.reason).toBe('replacement overflows available space');
  expect(out.overflow).toEqual({ availablePt: 5, neededPt: 10 });
  const allowed = run(source, [edit(1,2,'XX')], { allowOverflow: true });
  expect(allowed.ok).toBe(true);
  expect(allowed.overflow).toEqual(out.overflow);
  expect(glyphs(allowed.bytes).slice(-5)).toEqual(glyphs(source).slice(-5));
});
test('negative TJ kern and explicit edit-box width reduce available space', () => {
  const s = b('BT /F1 10 Tf 50 100 Td [(ABCDE) 200 (Z)] TJ ET');
  const e = { ...edit(0,5,'ABCDE'), itemIndex: 0 };
  const out = run(s, [e]);
  expect(out.ok).toBe(false);
  expect(out.overflow).toEqual({ availablePt: 23, neededPt: 25 });
  const bounded = run(source, [{ ...edit(1,3,'X'), availablePt: 4 }]);
  expect(bounded.ok).toBe(false);
  expect(bounded.overflow).toEqual({ availablePt: 4, neededPt: 5 });
});
for (const patch of [{byteStart:-1}, {byteEnd:6}, {byteStart:1.5}, {byteEnd:0}, {expected:b('ZZ')}, {availablePt:NaN}]) {
  test(`bad span refuses unchanged ${Object.keys(patch)}`, () => {
    const out = run(source, [{ ...edit(), ...patch }]); expect(out.ok).toBe(false); expect(out.bytes).toBe(source);
  });
}
test('overlapping spans refuse atomically', () => {
  const out = run(source, [edit(),edit(2,4,'Y')]); expect(out.ok).toBe(false); expect(out.bytes).toBe(source);
});
test('two-byte code cuts and a range crossing TJ string items refuse', () => {
  const f = { ...font, bytesPerCode: 2 as const };
  const out = replaceRuns(source, [f], {sourceHash:sourceFingerprint(source),edits:[edit()]});
  expect(out.ok).toBe(false); expect(out.bytes).toBe(source);
  const s = b('BT /F1 10 Tf 50 100 Td [(AB) 120 (CD)] TJ ET');
  const cross = run(s, [{...edit(0,4,'X'),itemIndex:0,expected:b('ABCD')}]);
  expect(cross.ok).toBe(false); if (!cross.ok) expect(cross.reason).toContain('span');
});

for (const [name,escaped] of [['F 1','F#201'],['Fé','F#e9']]) test(`fallback restores original resource ${escaped} exactly`, () => {
  const s=b(`BT /${escaped} 10 Tf 50 100 Td (ABCDE) Tj (Z) Tj ET`);
  const out=replaceRuns(s,[{...font,resourceName:name!}],{sourceHash:sourceFingerprint(s),edits:[{...edit(1,4,'é'),fontResource:name!}],fallbackFonts:[fallback]});
  expect(out.ok).toBe(true);
  const walk=walkTextPlacements(tokenizeContentStream(out.bytes),{resolveFont:name=>({...(name==='Fb'?fallback:font),ok:true,appliesWordSpacing:name!=='Fb'})});
  expect(walk.ok).toBe(true);if(walk.ok)expect(walk.glyphs.at(-1)!.fontName).toBe(name!);
});

test('fallback resources cannot shadow source fonts or each other',()=>{
  for(const fallbacks of [[{...fallback,resourceName:'F1'}],[fallback,fallback]]){
    const out=run(source,[edit(1,4,'é')],{fallbackFonts:fallbacks});
    expect(out.ok).toBe(false);expect(out.bytes).toBe(source);
    if(!out.ok)expect(out.reason).toContain('fallback font resource');
  }
});

for (const tw of [0,4]) test(`replacing a simple code-32 space includes Tw=${tw} exactly once`,()=>{
  const s=b(`BT /F1 10 Tf 2 Tc ${tw} Tw 80 Tz 50 100 Td (A B) Tj ET`);
  const e={...edit(),opIndex:6,byteStart:1,byteEnd:2,expected:b(' '),replacement:'X'};
  const out=run(s,[e]);expect(out.ok).toBe(true);
  const g=glyphs(out.bytes);expect(g[1]!.x).toBeCloseTo(55.6,8);
  expect(g[2]!.x).toBeCloseTo(61.2+tw*.8,8);
  expect(tokenizeContentStream(out.bytes).flatMap(op=>op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items.flatMap(v=>v.kind==='number'?[v.value]:[]):[])).toEqual([tw===0?0:-100*tw]);
});
for (const cid of [2,32]) test(`fallback CID space ${cid} ignores Tw while the source space receives it`,()=>{
  const missingSpace={...font,canEncode:(s:string)=>s.includes(' ')?{ok:false as const,reason:'space not encodable',firstMissing:' ',offset:s.indexOf(' ')}:font.canEncode!(s)};
  const cidSpace={...fallback,unicodeByCode:new Map([[cid,' ']]),canEncode:(s:string)=>s===' '?{ok:true as const,bytes:Uint8Array.of(0,cid),codes:[Uint8Array.of(0,cid)],preferredApplied:true}:{ok:false as const,reason:'missing',firstMissing:s,offset:0}};
  const s=b('BT /F1 10 Tf 2 Tc 4 Tw 80 Tz 50 100 Td (A B) Tj ET');
  const out=replaceRuns(s,[missingSpace],{sourceHash:sourceFingerprint(s),edits:[{...edit(),opIndex:6,byteStart:1,byteEnd:2,expected:b(' '),replacement:' '}],fallbackFonts:[cidSpace]});
  expect(out.ok).toBe(true);
  const g=glyphs(out.bytes,[missingSpace,cidSpace]);
  expect(g[1]!.font).toBe('Fb');expect(g[1]!.code).toBe(cid);expect(g[1]!.x).toBeCloseTo(55.6,8);
  expect(g[2]!.x).toBeCloseTo(64.4,8); // source slot: (500/1000*10 + Tc2 + Tw4)*Tz.8
  expect(tokenizeContentStream(out.bytes).flatMap(op=>op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items.flatMap(v=>v.kind==='number'?[v.value]:[]):[])).toEqual([-500]); // new 600 - old 1100; CID gets Tc, zero Tw
});
for(const s of [
  'BT /F1 10 Tf 53 100 Td (Z) Tj 1 0 0 1 50 100 Tm (ABCDE) Tj ET',
  'BT /F1 10 Tf 50 100 Td (ABCDE) Tj 1 0 0 1 70 120 Tm (Q) Tj 1 0 0 1 53 100 Tm (Z) Tj ET',
]) test('overflow considers every other glyph on the baseline, independent of paint order',()=>{
  const bytes=b(s),ops=tokenizeContentStream(bytes),opIndex=ops.findIndex(op=>op.operands.some(v=>v.kind==='string'&&new TextDecoder().decode(v.bytes)==='ABCDE'));
  const out=run(bytes,[{...edit(0,5,'X'),opIndex}]);
  expect(out.ok).toBe(false);expect(out.bytes).toBe(bytes);expect(out.overflow).toEqual({availablePt:3,neededPt:5});
});
test('glyphs behind the span and on another line do not limit its slot',()=>{
  const s=b('BT /F1 10 Tf 45 100 Td (Z) Tj 1 0 0 1 53 120 Tm (Q) Tj 1 0 0 1 50 100 Tm (ABCDE) Tj ET');
  const out=run(s,[{...edit(0,5,'X'),opIndex:7}]);expect(out.ok).toBe(true);
});

test('a following replacement glyph sees only CID space width and Tc, then terminal compensation restores the untouched run',()=>{
  const missingSpace={...font,canEncode:(s:string)=>s.includes(' ')?{ok:false as const,reason:'space not encodable',firstMissing:' ',offset:s.indexOf(' ')}:font.canEncode!(s)};
  const cidSpace={...fallback,unicodeByCode:new Map([[32,' ']]),canEncode:(s:string)=>s===' '?{ok:true as const,bytes:Uint8Array.of(0,32),codes:[Uint8Array.of(0,32)],preferredApplied:true}:{ok:false as const,reason:'missing',firstMissing:s,offset:0}};
  const s=b('BT /F1 10 Tf 2 Tc 4 Tw 80 Tz 50 100 Td (A B) Tj (Z) Tj ET');
  const out=replaceRuns(s,[missingSpace],{sourceHash:sourceFingerprint(s),edits:[{...edit(),opIndex:6,byteStart:0,byteEnd:3,expected:b('A B'),replacement:'A B'}],fallbackFonts:[cidSpace]});
  expect(out.ok).toBe(true);const g=glyphs(out.bytes,[missingSpace,cidSpace]);
  expect(g[2]!.x).toBeCloseTo(60.4,8); // old B=64.4; delta=(4-5-4)*.8=-4
  expect(g[3]!.x).toBeCloseTo(70,8); // end-of-span compensation restores untouched Z
});
