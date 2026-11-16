import {describe,expect,test} from 'bun:test';
import {readType1Program} from './type1Program';
import {createFontCoverage} from './coverage';
import {surgicalType1Encoder} from './type1Surgical';
import {nums,tinyType1,widthChar} from './fixtures/type1';
import {italicStemSnapHints,stemSnapHints} from './fixtures/type1StemSnap';
import type {FontInput} from './types';

const read=(hints=stemSnapHints)=>readType1Program({subtype:'Type1',...tinyType1({private:hints})});
// Independently made outline with a known width and bounds, rather than a
// width-only glyph that could accidentally authorize a missing outline.
const outlined=Uint8Array.from([...nums(0,600),13,...nums(10,20),21,...nums(400,0),5,...nums(0,500),5,...nums(-400,0),5,9,14]);
const input=(extra:Partial<FontInput>={}):FontInput=>({subtype:'Type1',programKind:'FontFile',
  ...tinyType1({private:stemSnapHints,glyphs:{'.notdef':widthChar(0),A:outlined,B:Uint8Array.of(14)}}),
  firstChar:65,lastChar:66,widths:[600,600],
  toUnicode:'2 beginbfchar <41> <0041> <42> <0042> endbfchar',...extra});

describe('Private StemSnap interpreter compatibility hints',()=>{
  test('real Nimbus hint-array selection is inert to glyph identity and metrics',()=>{
    const p=read();
    expect(p.verify('A')).toMatchObject({ok:true,width:600});
    expect(p.builtIn.get(65)).toBe('A');
    expect(p.fontMatrix).toEqual([0.001,0,0,0.001,0,0]);
    expect(p.fontBBox).toEqual([0,0,600,700]);
  });
  test('comments, spacing and a proved ND alias terminate the same hint statement',()=>{
    const hints=stemSnapHints.replaceAll('systemdict','% compatibility\n systemdict').replaceAll('if def','if ND');
    expect(read(hints).verify('A')).toMatchObject({ok:true,width:600});
  });
  test('real italic hints compare StemSnapLength with the eight literal entries',()=>{
    expect(read(italicStemSnapHints).verify('A')).toMatchObject({ok:true,width:600});
    const i=input({...tinyType1({private:italicStemSnapHints,glyphs:{A:outlined}})});
    expect(createFontCoverage(i).canEncode('A')).toMatchObject({ok:true,bytes:Uint8Array.of(65)});
  });
  test('identical definitions work; changing either possible value remains contradictory',()=>{
    expect(read(stemSnapHints+'\n'+stemSnapHints).verify('A').ok).toBe(true);
    for(const changed of [stemSnapHints.replace('[33 66]','[33 67]'),stemSnapHints.replace('[33 44 48 55 66 73]','[34 44 48 55 66 73]'),'/StemSnapH [33 44 48 55 66 73] def'])
      expect(()=>read(stemSnapHints+'\n'+changed)).toThrow('type1-ps-unsupported: contradictory /StemSnapH');
  });
  const mutations:Record<string,string>={
    'different dictionary':stemSnapHints.replace('systemdict','userdict'),
    'different lookup':stemSnapHints.replace('/internaldict','/FontDirectory'),
    'different password':stemSnapHints.replace('1183615869','1183615870'),
    'different predicate':stemSnapHints.replace('/StemSnapLength','/FontMatrix'),
    'different comparison':stemSnapHints.replace('get 6 lt','get 6 gt'),
    'mismatched array length':stemSnapHints.replace('get 6 lt','get 5 lt'),
    'executable branch':stemSnapHints.replace('pop pop true','pop pop quit true'),
    'changed fallback branch':stemSnapHints.replace('pop [33 66]','pop /Encoding StandardEncoding def [33 66]'),
    'executable fallback array':stemSnapHints.replace('[33 66]','[33 66 add]'),
    'nested fallback array':stemSnapHints.replace('[33 66]','[[33] 66]'),
    'literal-name fallback array':stemSnapHints.replace('[33 66]','[/A 66]'),
    'procedure fallback':stemSnapHints.replace('[33 66]','{33 66}'),
    'executable initial array':stemSnapHints.replace('[33 44 48 55 66 73]','[33 44 add]'),
    'procedure initial value':stemSnapHints.replace('[33 44 48 55 66 73]','{33 44}'),
    'scalar initial value':stemSnapHints.replace('[33 44 48 55 66 73]','33'),
    'empty initial array':stemSnapHints.replace('[33 44 48 55 66 73]','[]'),
    'empty fallback array':stemSnapHints.replace('[33 66]','[]'),
    'unterminated conditional':stemSnapHints.replace('} if def','if def'),
    'executable leftover':stemSnapHints.replace('if def','if quit def'),
    'executable after definition':stemSnapHints+'\nsystemdict /Encoding known {quit} if',
    'hint expression on metrics':stemSnapHints.replace('/StemSnapH','/StdHW'),
    'literal control word':stemSnapHints.replace('systemdict','/systemdict'),
    'executable dictionary name':stemSnapHints.replace('/internaldict','internaldict'),
    'literal predicate word':stemSnapHints.replace('2 copy known','2 /copy known'),
  };
  for(const [name,hints] of Object.entries(mutations))test(`refuses ${name}`,()=>{
    expect(()=>read(hints)).toThrow('type1-ps-unsupported');
    expect(createFontCoverage(input({...tinyType1({private:hints})})).canEncode('A')).toMatchObject({ok:false,code:'type1-ps-unsupported',terminal:true});
  });
  test('the expression is not accepted as a font-dictionary definition',()=>{
    expect(()=>readType1Program({subtype:'Type1',...tinyType1({clear:stemSnapHints})})).toThrow('type1-ps-unsupported');
  });
});

test('newly parsed hints retain independent charstring and code/name/Unicode/width proofs',()=>{
  const i=input(),p=readType1Program(i),coverage=createFontCoverage(i);
  expect(p.verify('A')).toMatchObject({ok:true,width:600,inkBounds:{x:10,y:20,w:400,h:500}});
  expect(surgicalType1Encoder(coverage)('A')).toMatchObject({ok:true,bytes:Uint8Array.of(65)});
  expect(coverage.mappings?.get('41')).toMatchObject({glyph:{kind:'type1-name',name:'A'},width1000:600,
    replacementProof:{toUnicodeLabel:'A',verifiedGlyphName:'A',glyphNameUnicode:'A'}});
  expect(coverage.canEncode('B')).toMatchObject({ok:false,code:'type1-charstring-invalid'});
  expect(p.verify('.notdef')).toMatchObject({ok:false,code:'glyph-unavailable'});
  for(const [extra,code] of [
    [{widths:[602,600]},'font-metrics-conflict'],
    [{toUnicode:undefined},'missing-tounicode'],
    [{encoding:{differences:{65:'.notdef'}}},'glyph-unavailable'],
    [{toUnicode:'1 beginbfchar <41> <0042> endbfchar'},'glyph-identity-conflict'],
    [{fontMatrix:[1,0,0,1,0,0]},'unsupported-matrix'],
  ] as const)expect(createFontCoverage(input(extra)).canEncode(code==='glyph-identity-conflict'?'B':'A')).toMatchObject({ok:false,code});
});
