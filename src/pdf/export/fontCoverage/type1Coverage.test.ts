import {expect,test} from 'bun:test';
import {createFontCoverage} from './coverage';
import {readProgram} from './program';
import {tinyType1,widthChar} from './fixtures/type1';
import {resolveStandardMetrics} from './standardMetrics';
import {stage5Type1,type1RunDiagnostic} from './type1Support';
import type {FontInput} from './types';
const input=(extra:Partial<FontInput>={}):FontInput=>({subtype:'Type1',baseFont:'Tiny',programKind:'FontFile',...tinyType1(),firstChar:65,lastChar:66,widths:[600,600],toUnicode:'2 beginbfchar <41> <0041> <42> <0042> endbfchar',...extra});
const coverage=(extra:Partial<FontInput>={})=>createFontCoverage(input(extra),{sourceReuse:true});
test('raw Type1 dispatch precedes fontkit and stays production default-off',()=>{
  expect(readProgram(input())).toMatchObject({kind:'type1'});
  expect(stage5Type1).toEqual({sourceReuse:false,standard14Afm:false});
  expect(createFontCoverage(input()).canEncode('A').ok).toBe(false);
  expect(coverage().canEncode('AB')).toMatchObject({ok:true,bytes:Uint8Array.of(65,66)});
  expect(coverage().glyphIds.size).toBe(0);
  expect(coverage().mappings?.get('41')).toMatchObject({width1000:600,widthSource:'pdf-widths',glyph:{kind:'type1-name',name:'A'}});
});
for(const width of [600,601,602])test(`character-space width 600 versus ${width}`,()=>{
  const result=coverage({widths:[width,600]}).canEncode('A');
  expect(result).toMatchObject(width<=601?{ok:true}:{ok:false,code:'font-metrics-conflict'});
});
test('no program width substitution, nonstandard matrices and holes in PDF widths refuse',()=>{
  expect(coverage({widths:undefined}).canEncode('A')).toMatchObject({ok:false,code:'font-metrics-missing'});
  expect(coverage({widths:[0.6,600]}).canEncode('A')).toMatchObject({ok:false,code:'font-metrics-conflict'});
  expect(coverage({fontMatrix:[1,0,0,1,0,0]}).canEncode('A')).toMatchObject({ok:false,code:'unsupported-matrix'});
  expect(coverage({widths:[NaN,600]}).canEncode('A')).toMatchObject({ok:false,code:'font-metrics-missing'});
});
test('ToUnicode /A selecting /B is terminal even when another A candidate exists',()=>{
  const f=coverage({encoding:{differences:{65:'B',66:'A'}},toUnicode:'2 beginbfchar <41> <0041> <42> <0041> endbfchar'});
  expect(f.codeToUnicode.get('41')).toBe('A');
  expect(f.canEncode('A')).toMatchObject({ok:false,code:'glyph-identity-conflict',terminal:true});
  expect(type1RunDiagnostic({code:'glyph-identity-conflict',detail:'test'})).toMatchObject({code:'font-unavailable',terminal:true});
});
test('matching ligature names, partial labels and preferred original bytes',()=>{
  const f=coverage({firstChar:1,lastChar:3,widths:[600,600,600],encoding:{differences:{1:'f_i',2:'f_i',3:'A'}},toUnicode:'2 beginbfchar <01> <00660069> <02> <00660069> endbfchar'});
  expect(f.canEncode('fi',{preferredCodes:[Uint8Array.of(2)]})).toMatchObject({ok:true,preferredApplied:true,bytes:Uint8Array.of(2)});
  expect(f.canEncode('A').ok).toBe(false);
  expect(coverage({toUnicode:undefined}).canEncode('A')).toMatchObject({ok:false,code:'missing-tounicode'});
});
test('a broken reachable glyph does not upgrade an entire Type1 font to verified',()=>{
  const f=coverage({...tinyType1({glyphs:{A:widthChar(),B:Uint8Array.of(14)}})});
  expect(f.canEncode('A').ok).toBe(true);expect(f.canEncode('B').ok).toBe(false);
  expect(f.verification).toBe('unverified');
});
test('Standard14 AFM uses selected names only for exact unembedded faces',()=>{
  const base:FontInput={subtype:'Type1',baseFont:'Helvetica',encoding:{differences:{65:'B'}}};
  expect(resolveStandardMetrics(base)?.widthOf(65)).toBe(667);
  expect(resolveStandardMetrics({...base,baseFont:'ABCDEF+Helvetica'})).toBeUndefined();
  expect(resolveStandardMetrics({...base,program:tinyType1().program})).toBeUndefined();
  const f=createFontCoverage({...base,toUnicode:'1 beginbfchar <41> <0042> endbfchar'},{standard14Afm:true});
  expect(f.verification).toBe('assumed-standard');expect(f.canEncode('B').ok).toBe(true);
  expect(createFontCoverage(base,{standard14Afm:true}).canEncode('B')).toMatchObject({ok:false,code:'missing-tounicode'});
  expect(coverage({baseFont:'Helvetica',widths:undefined}).canEncode('A')).toMatchObject({ok:false,code:'font-metrics-missing'});
});
test('unencoded glyphs and a missing nonstandard Type1 program have precise refusals',()=>{
  expect(coverage().canEncode('fi')).toMatchObject({ok:false,code:'glyph-unavailable'});
  expect(createFontCoverage({subtype:'Type1',baseFont:'Tiny'}).canEncode('A')).toMatchObject({ok:false,code:'font-program-missing'});
  expect(createFontCoverage({subtype:'MMType1',baseFont:'Helvetica'}).canEncode('A')).toMatchObject({ok:false,code:'type1-ps-unsupported'});
});
test('the default-off gate also refuses deletion through an empty replacement',()=>{
  expect(createFontCoverage(input()).canEncode('').ok).toBe(false);
});
test('an unknown glyph-name Unicode is unavailable, not a proven identity conflict',()=>{
  const f=coverage({...tinyType1({glyphs:{customUnknown:widthChar()}}),encoding:{differences:{65:'customUnknown'}},toUnicode:'1 beginbfchar <41> <0041> endbfchar'});
  expect(f.canEncode('A')).toMatchObject({ok:false,code:'glyph-unavailable'});
});
