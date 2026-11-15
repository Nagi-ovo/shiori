import { describe, expect, test } from 'bun:test';
import { createFontCoverage } from './coverage';
import { tinyCff, tinyTtf } from './fixtures/programs';
const cmap = (pairs: string) => `begincmap 1 begincodespacerange <00> <ff> endcodespacerange ${pairs} endcmap`;
const simple = (extra = {}) => createFontCoverage({ subtype:'TrueType', baseFont:'ABCDEF+Sans', flags:32,
  encoding:'WinAnsiEncoding', program:tinyTtf(), toUnicode:cmap('4 beginbfchar <53> <0053> <61> <0061> <6e> <006e> <64> <0064> endbfchar'), ...extra });
const cid = (extra = {}) => createFontCoverage({ subtype:'Type0', cidSubtype:'CIDFontType2', baseFont:'Subset',
  encoding:'Identity-H', program:tinyTtf(), toUnicode:'2 beginbfchar <0001> <0053> <002a> <0041> endbfchar', ...extra });
const bytes = (result: ReturnType<ReturnType<typeof simple>['canEncode']>) => {
  if (!result.ok) throw new Error(result.reason);
  return [...result.bytes];
};
describe('font program coverage', () => {
  test('subset cannot encode Sand when the mapped d is .notdef', () => {
    const f = simple(); expect(bytes(f.canEncode('San'))).toEqual([83,97,110]);
    expect(f.canEncode('Sand')).toMatchObject({ok:false, firstMissing:'d'});
    expect(f.missing.some(m=>m.cluster==='d' && m.reason.includes('notdef'))).toBe(true);
  });
  test('ToUnicode does not override the glyph selected by Encoding', () => {
    // S is present at GID1; d selects nonzero GID2, whose subset slot
    // is absent. Looking up ToUnicode S instead of rendering d would pass.
    const f = simple({program:tinyTtf({maps:[{platform:3,encoding:1,entries:[[83,1],[100,2]]}],empty:[2]}),
      toUnicode:cmap('1 beginbfchar <64> <0053> endbfchar')});
    expect(f.canEncode('S').ok).toBe(false);
    expect(f.canEncode('d').ok).toBe(false);
    expect(f.missing).toContainEqual({code:'64',cluster:'S',reason:'absent subset glyf entry'});
  });
  test('removed glyf entry is absent, but space/mark/zero width are valid', () => {
    expect(simple({program:tinyTtf({empty:[1]})}).canEncode('S').ok).toBe(false);
    const f = simple({encoding:{base:'WinAnsiEncoding',differences:{1:'space',2:'uni0301',3:'uni200B'}},toUnicode:undefined});
    expect(bytes(f.canEncode(' \u0301\u200b'))).toEqual([1,2,3]);
  });
  test('duplicate Unicode retains all codes and prefers the source code', () => {
    const f = simple({encoding:{base:'WinAnsiEncoding',differences:{1:'S',2:'S'}},toUnicode:cmap('2 beginbfchar <01> <0053> <02> <0053> endbfchar')});
    expect(f.encodable.get('S')?.map(b=>[...b])).toEqual([[1],[2]]);
    expect(bytes(f.canEncode('S',{preferredCodes:[Uint8Array.of(2)]}))).toEqual([2]);
  });
  test('ligature ToUnicode maps fi to one code, preserving the cluster', () => {
    const f = simple({toUnicode:cmap('1 beginbfchar <53> <00660069> endbfchar')});
    expect(bytes(f.canEncode('fifi'))).toEqual([83,83]);
    expect(f.canEncode('f').ok).toBe(false);
  });
  test('encoding can backtrack past a longer cluster with an unencodable suffix', () => {
    const f = simple({encoding:{base:'WinAnsiEncoding',differences:{1:'S',2:'S',3:'S'}},toUnicode:cmap('3 beginbfchar <01> <00610062> <02> <0061> <03> <00620063> endbfchar')});
    expect(bytes(f.canEncode('abc'))).toEqual([2,3]);
  });
  test('no ToUnicode uses glyph names, suffixes, AGL and Differences', () => {
    const f = simple({encoding:{base:'WinAnsiEncoding',differences:{1:'S.alt',2:'uni0061',3:'n'}},toUnicode:undefined});
    expect(bytes(f.canEncode('San'))).toEqual([1,2,3]);
  });
  test('ToUnicode preserves supplementary Unicode and bfrange clusters', () => {
    const f = cid({toUnicode:'1 beginbfrange <0001> <0003> [<D83DDE00> <00660069> <006e>] endbfrange'});
    expect(bytes(f.canEncode('😀fin'))).toEqual([0,1,0,2,0,3]);
  });
  test('non-symbolic MacRoman selects (1,0), not arbitrary Unicode cmap', () => {
    const f = simple({program:tinyTtf({maps:[{platform:1,encoding:0,entries:[[83,1]]}]}),toUnicode:undefined,encoding:'MacRomanEncoding'});
    expect(bytes(f.canEncode('S'))).toEqual([83]);
  });
  for (const high of [0,0xf000,0xf100,0xf200]) test(`symbolic (3,0) cmap selects high byte ${high}`, () => {
    const f = simple({flags:4, program:tinyTtf({maps:[{platform:3,encoding:0,entries:[[high+65,7]]},{platform:3,encoding:1,entries:[[65,0]]}]}),
      toUnicode:cmap('1 beginbfchar <41> <0041> endbfchar')});
    expect(bytes(f.canEncode('A'))).toEqual([65]);
  });
  test('symbolic Mac cmap ignores Differences', () => {
    const f = simple({flags:4,toUnicode:undefined,encoding:{differences:{83:'d'}},program:tinyTtf({maps:[{platform:1,encoding:0,entries:[[83,1]]}]})});
    expect(bytes(f.canEncode('S'))).toEqual([83]);
    expect(f.canEncode('d').ok).toBe(false);
  });
  test('CIDToGIDMap stream maps CID42 to GID7', () => {
    const map = new Uint8Array(86); map[85]=7;
    expect(bytes(cid({cidToGid:map}).canEncode('A'))).toEqual([0,42]);
    expect(cid({cidToGid:map}).canEncode('S').ok).toBe(false);
  });
  test('omitted CIDToGIDMap defaults Identity; bounds are checked', () => {
    expect(bytes(cid().canEncode('S'))).toEqual([0,1]);
    expect(cid().canEncode('A').ok).toBe(false);
  });
  test('Identity-V has coverage without pretending it is horizontal', () => {
    const f=cid({encoding:'Identity-V'}); expect(f.vertical).toBe(true);
    expect(bytes(f.canEncode('S'))).toEqual([0,1]);
  });
  test('embedded mixed-width CMap resolves code→CID→GID', () => {
    const f=cid({encoding:{cmap:'2 begincodespacerange <00> <7f> <8100> <81ff> endcodespacerange 1 begincidchar <41> 1 endcidchar 1 begincidrange <8101> <8102> 2 endcidrange'},
      toUnicode:'3 beginbfchar <41> <0053> <8101> <0061> <8102> <006e> endbfchar'});
    expect(bytes(f.canEncode('San'))).toEqual([65,129,1,129,2]);
  });
  test('predefined CMap is explicitly unsupported', () => {
    expect(cid({encoding:'UniJIS-UTF16-H'}).canEncode('S')).toMatchObject({ok:false,reason:expect.stringContaining('unsupported predefined CMap')});
  });
  test('CID CFF uses charset, not CID=GID', () => {
    const f=cid({cidSubtype:'CIDFontType0',program:tinyCff(),toUnicode:'2 beginbfchar <002a> <0041> <0001> <0053> endbfchar'});
    expect(bytes(f.canEncode('A'))).toEqual([0,42]); expect(f.canEncode('S').ok).toBe(false);
  });
  test('simple raw CFF Type1 resolves names and checks charstrings', () => {
    const f=simple({subtype:'Type1',program:tinyCff(false),toUnicode:undefined});
    expect(bytes(f.canEncode('A'))).toEqual([65]); expect(f.canEncode('S').ok).toBe(false);
  });
  test('nonembedded Standard14 assumes viewer glyphs and flags it', () => {
    const f=simple({subtype:'Type1',baseFont:'Helvetica',program:undefined,toUnicode:undefined});
    expect(bytes(f.canEncode('Sand'))).toEqual([83,97,110,100]);
    expect(f.verification).toBe('assumed-standard'); expect(f.warnings).toContain('non-embedded standard font');
  });
  test('nonembedded arbitrary font is unverified', () => {
    expect(simple({program:undefined}).canEncode('S')).toMatchObject({ok:false,reason:expect.stringContaining('not embedded')});
  });
  test('Type3 lists defined CharProcs codes only', () => {
    const f=simple({subtype:'Type3',program:undefined,encoding:{differences:{1:'S',2:'a'}},charProcs:['S'],toUnicode:undefined});
    expect(f.definedCodes.map(b=>[...b])).toEqual([[1],[83]]);
    expect(bytes(f.canEncode('S'))).toEqual([1]); expect(f.canEncode('a').ok).toBe(false);
    expect(f.warnings).toContain('type3: encode only codes already defined in /CharProcs');
  });
  for (const data of [new Uint8Array(),Uint8Array.of(0,1,0,0),tinyTtf().slice(0,140)]) test(`truncated program (${data.length}) returns reason`, () => {
    const f=simple({program:data}); expect(f.canEncode('S')).toMatchObject({ok:false,reason:expect.stringContaining('font program')});
  });
  for (const text of ['1 beginbfchar <53> endbfchar','1 beginbfrange <00> <ffffffff> <0041> endbfrange','/Unknown usecmap','1 beginbfchar <53> <d800> endbfchar']) test(`malformed/unsupported ToUnicode refuses: ${text}`,()=>{
    expect(simple({toUnicode:text}).canEncode('S').ok).toBe(false);
  });
  test('empty text succeeds and partial encoding never escapes',()=>{
    expect(bytes(simple().canEncode(''))).toEqual([]);
    expect(simple().canEncode('San🦉')).toMatchObject({ok:false,firstMissing:'🦉',offset:3});
  });
});
