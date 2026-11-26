import { expect, test } from 'bun:test';
import { createFontCoverage } from './coverage';
import { parseCMap } from './cmap';
import { readProgram } from './program';
import { format4Table, format12Table, tinyCff, tinyTtf, sfnt, format4Points } from './fixtures/programs';
import { namedTtf } from './symbolicCmap.test-support';

const symbolic = (entries: [number,number][]) => createFontCoverage({
  subtype:'TrueType',flags:4,
  program:namedTtf({maps:[{platform:3,encoding:0,entries:[],subtable:format4Points(entries)}]}),
  toUnicode:'2 beginbfchar <41> <0041> <53> <0053> endbfchar',
});

test('Standard14 .notdef is absent even when AFM supplies a width',()=>{
  const f=createFontCoverage({subtype:'Type1',baseFont:'Helvetica',encoding:'StandardEncoding',toUnicode:'1 beginbfchar <00> <0041> endbfchar'});
  expect(f.canEncode('A').ok).toBe(false);
  expect(f.missing).toContainEqual({code:'00',cluster:'A',reason:'glyph not in standard font'});
});
test('Standard14 rejects a ToUnicode alias with no other encoding candidate',()=>{
  const f=createFontCoverage({subtype:'Type1',baseFont:'Helvetica',encoding:{base:'StandardEncoding',differences:{65:'.notdef'}},toUnicode:'1 beginbfchar <00> <0041> endbfchar'});
  expect(f.canEncode('A').ok).toBe(false);
});
test('symbolic high-byte aliases to the same GID remain encodable',()=>{
  const f=symbolic([[65,7],[0xf041,7],[83,1]]);
  expect(f.canEncode('AS')).toMatchObject({ok:true,bytes:Uint8Array.of(65,83)});
});
test('ambiguous symbolic code is rejected without clearing unrelated coverage',()=>{
  const f=symbolic([[65,7],[0xf041,2],[83,1]]);
  expect(f.canEncode('A')).toMatchObject({ok:false,reason:expect.stringContaining('symbolic-cmap-ambiguous')});
  expect(f.canEncode('S')).toMatchObject({ok:true,bytes:Uint8Array.of(83)});
  expect(f.missing).toContainEqual({code:'41',cluster:'A',reason:expect.stringContaining('symbolic-cmap-ambiguous')});
});
// Explicit .notdef must not be conflated with a hole at another candidate base.
for(const zero of [0,0xf000,0xf100,0xf200])test(`explicit GID0 at base ${zero} vetoes a nonzero alias`,()=>{
  const nonzero=zero===0?0xf000:0;
  expect(symbolic([[zero+65,0],[nonzero+65,7],[83,1]]).canEncode('A'))
    .toMatchObject({ok:false,reason:expect.stringContaining('symbolic-cmap-ambiguous')});
});
for(const [platform,encoding] of [[3,1],[1,0]])test(`both flags with standard Encoding keep nonsymbolic (${platform},${encoding}) selection`,()=>{
  const f=createFontCoverage({subtype:'TrueType',flags:36,encoding:{base:'WinAnsiEncoding',differences:{65:'S'}},
    program:tinyTtf({maps:[{platform:platform!,encoding:encoding!,entries:[[83,1]]}]}),toUnicode:'1 beginbfchar <41> <0053> endbfchar'});
  expect(f.canEncode('S')).toMatchObject({ok:true,bytes:Uint8Array.of(65)});
});
for(const wrapped of [false,true])test(`CFF supplement bit refuses before fontkit can hide its override (OpenType=${wrapped})`,()=>{
  const cff=tinyCff(false,true);
  const program=wrapped?sfnt({'CFF ':cff,head:new Uint8Array(54),maxp:Uint8Array.of(0,0,0x50,0,0,3)},true):cff;
  const f=createFontCoverage({subtype:'Type1',program});
  expect(f.canEncode('A')).toMatchObject({ok:false,reason:'unsupported CFF encoding supplements'});
});
test('WMode ignores comment text but accepts a real token definition',()=>{
  expect(parseCMap('% /WMode 1 def\n/WMode 0 def').vertical).toBe(false);
  expect(parseCMap('/WMode % continued definition\n1 def').vertical).toBe(true);
});
test('preferred code success and miss are observable, including count mismatch',()=>{
  const f=createFontCoverage({subtype:'Type1',baseFont:'Helvetica',encoding:'WinAnsiEncoding'});
  expect(f.canEncode('A')).toMatchObject({ok:true,preferredApplied:true});
  expect(f.canEncode('A',{preferredCodes:[Uint8Array.of(65)]})).toMatchObject({ok:true,preferredApplied:true});
  expect(f.canEncode('A',{preferredCodes:[Uint8Array.of(66)]})).toMatchObject({ok:true,preferredApplied:false});
  expect(f.canEncode('AB',{preferredCodes:[Uint8Array.of(65)]})).toMatchObject({ok:true,preferredApplied:false});
  expect(f.canEncode('A',{preferredCodes:[Uint8Array.of(65),Uint8Array.of(66)]})).toMatchObject({ok:true,preferredApplied:false});
  expect(f.canEncode('',{preferredCodes:[Uint8Array.of(65)]})).toMatchObject({ok:true,preferredApplied:false});
});
for(const [format,table,expected] of [
  [4,format4Table(),[[65,1],[66,2],[67,0],[83,7],[84,0],[85,3]]],
  [12,format12Table(),[[65,1],[66,2],[67,3],[68,0],[83,7],[84,0],[0x10000,5],[0x10001,6],[0x10002,7]]],
] as const)test(`format ${format} resolves independently specified GIDs, holes and .notdef`,()=>{
  const program=readProgram({subtype:'TrueType',flags:32,encoding:'WinAnsiEncoding',program:tinyTtf({maps:[{platform:3,encoding:1,entries:[],subtable:table}]})});
  for(const [cp,gid] of expected)expect(program.simpleGid(cp,`u${cp.toString(16).padStart(4,'0')}`)).toBe(gid);
});
