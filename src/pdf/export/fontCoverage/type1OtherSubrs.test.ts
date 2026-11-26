import {describe,expect,test} from 'bun:test';
import {readType1Program} from './type1Program';
import {createFontCoverage} from './coverage';
import {flexChar,flexSubrs,flexVectors,hintChar,nums,seacChar,tinyType1,widthChar} from './fixtures/type1';

const read=(glyphs:Record<string,Uint8Array>,subrs=flexSubrs,lenIV=4)=>readType1Program({subtype:'Type1',...tinyType1({glyphs,subrs,lenIV})});
const cs=(...body:number[])=>Uint8Array.from([...nums(0,600),13,...body,14]);
const call=(index:number,...args:number[])=>[...nums(...args,args.length,index),12,16];

describe('canonical Type1 OtherSubrs',()=>{
  for(const lenIV of [-1,0,4])test(`flex records seven points across Subrs with lenIV ${lenIV}`,()=>{
    expect(read({A:flexChar()},flexSubrs,lenIV).verify('A')).toMatchObject({ok:true,width:600,dependencies:['subr:1',...Array(7).fill('subr:2'),'subr:0']});
  });
  test('inline flex transfers two results in x/y order and permits another flex',()=>{
    const vectors=flexVectors.flatMap(v=>[...nums(...v),21,...call(2)]);
    const flex=[...call(1),...vectors,...call(0,50,200,-10),12,17,12,17,12,33];
    // A second zero-distance flex proves the first returned endpoint was x/y.
    const second=[...call(1),...Array.from({length:7},()=>[...nums(0,0),21,...call(2)]).flat(),...call(0,50,200,-10),12,17,12,17,12,33];
    expect(read({A:cs(...nums(100,-10),21,...flex,...second)}).verify('A')).toMatchObject({ok:true,width:600});
  });
  test('hint replacement returns the actual Subr index and preserves lower operands',()=>{
    expect(read({A:hintChar}).verify('A')).toMatchObject({ok:true,width:600,dependencies:['subr:4']});
    const subrs=[...flexSubrs.slice(0,4),Uint8Array.from([...nums(20),1,11])];
    expect(read({A:cs(...nums(0),...call(3,4),12,17,10)},subrs).verify('A')).toMatchObject({ok:true,dependencies:['subr:4']});
    const missing=cs(...call(3,99),12,17,10);
    expect(read({A:missing}).verify('A')).toMatchObject({ok:false,code:'type1-subr-invalid',detail:expect.stringContaining('99')});
  });
  test('procedure bodies remain inert even when a standard OtherSubr is called',()=>{
    const p=readType1Program({subtype:'Type1',...tinyType1({glyphs:{A:hintChar},subrs:flexSubrs,private:'/OtherSubrs [{} {} {} {arbitraryPS quit}] def'})});
    expect(p.verify('A')).toMatchObject({ok:true,width:600});
  });
  for(const index of [4,19,99,-1])test(`unsupported OtherSubr ${index} names the index`,()=>{
    expect(read({A:cs(...call(index))}).verify('A')).toMatchObject({ok:false,code:'type1-other-subr-unsupported',detail:expect.stringContaining(`OtherSubr ${index}`)});
  });
  const malformed:Record<string,Uint8Array>={
    'empty pop':cs(12,17),
    'callothersubr underflow':cs(12,16),
    'callothersubr missing count for index 0':cs(...nums(0),12,16),
    'OtherSubr 1 wrong arity':cs(...call(1,42)),
    'OtherSubr 2 wrong arity':cs(...call(2,42)),
    'OtherSubr 3 wrong arity':cs(...call(3)),
    'OtherSubr 0 wrong arity':cs(...call(0)),
    'OtherSubr 3 invalid count':cs(...nums(-1,3),12,16),
    'OtherSubr 3 truncated arguments':cs(...nums(1,3),12,16),
    'OtherSubr 3 fractional count':cs(...nums(1,2),12,12,...nums(3),12,16),
    'OtherSubr fractional index':cs(...nums(0,3,2),12,12,12,16),
    'OtherSubr 2 without start':cs(...call(2)),
    'OtherSubr 0 without start':cs(...call(0,50,0,0)),
    'OtherSubr 1 nested start':cs(...call(1),...call(1)),
    'OtherSubr 1 unfinished flex':cs(...call(1)),
    'OtherSubr 2 without vector':cs(...call(1),...call(2)),
    'OtherSubr 2 repeated vector':cs(...call(1),...nums(0,0),21,...call(2),...call(2)),
    'OtherSubr 2 unrecorded vector':cs(...call(1),...nums(0,0),21,...nums(1,1),21),
    'OtherSubr 0 six vectors':flexChar({vectors:flexVectors.slice(0,6)}),
    'OtherSubr 2 eight vectors':flexChar({vectors:[...flexVectors,[0,0]]}),
    'OtherSubr 0 mismatched endpoint':flexChar({end:[50,201,-10]}),
    'OtherSubr 1 drawing during flex':cs(...nums(0,0),21,...call(1),...nums(1,1),5),
    'OtherSubr 3 inside flex':cs(...call(1),...call(3,4),12,17,10),
    'OtherSubr 3 unconsumed pop':cs(...call(3,4)),
    'pop extra result':cs(...call(3,4),12,17,12,17),
    'pop delayed by operand':cs(...call(3,4),...nums(0),12,17),
    'pop delayed by operator':cs(...call(3,4),12,0,12,17),
    'OtherSubr 0 missing second pop':flexChar({finish:[...nums(3,0),12,16,12,17,12,33]}),
    'OtherSubr 0 missing setcurrentpoint':flexChar({finish:[...nums(3,0),12,16,12,17,12,17]}),
    'pop missing at glyph EOF':Uint8Array.from([...nums(0,600),13,...call(3,4)]),
    'OtherSubr 1 unfinished flex at EOF':Uint8Array.from([...nums(0,600),13,...call(1)]),
    'OtherSubr 0 missing setcurrentpoint at EOF':flexChar({finish:[...nums(3,0),12,16,12,17,12,17]}).slice(0,-1),
  };
  for(const [name,glyph]of Object.entries(malformed))test(`refuses ${name} without poisoning siblings`,()=>{
    const p=read({A:widthChar(),B:glyph});
    expect(p.verify('A')).toMatchObject({ok:true});
    expect(p.verify('B')).toMatchObject({ok:false,code:'type1-other-subr-unsupported',detail:expect.stringContaining(name.split(' ')[0]!)});
  });
  test('valid flex/hints/seac map per glyph while an unsupported sibling stays unverified',()=>{
    const f=createFontCoverage({subtype:'Type1',...tinyType1({glyphs:{A:flexChar(),B:cs(...call(4)),acute:hintChar,Aacute:seacChar},subrs:flexSubrs}),
      firstChar:65,lastChar:67,widths:[600,600,600],encoding:{differences:{67:'Aacute',194:'B'}},
      toUnicode:'3 beginbfchar <41> <0041> <42> <0042> <43> <00C1> endbfchar'}, {sourceReuse:true});
    expect(f.canEncode('AÁ')).toMatchObject({ok:true,bytes:Uint8Array.of(65,67)});
    expect(f.mappings?.get('43')?.glyph).toMatchObject({kind:'type1-name',name:'Aacute'});
    expect(f.canEncode('B')).toMatchObject({ok:false,code:'type1-other-subr-unsupported',terminal:true,detail:expect.stringContaining('4')});
    expect(f.verification).toBe('unverified');
  });
  test('seac uses StandardEncoding even when the program encoding differs and proves both closures',()=>{
    const p=readType1Program({subtype:'Type1',...tinyType1({encoding:'StandardEncoding dup 65 /B put dup 194 /B put',glyphs:{A:flexChar(),acute:hintChar,Aacute:seacChar},subrs:flexSubrs})});
    expect(p.verify('Aacute')).toMatchObject({ok:true,dependencies:['glyph:A','glyph:acute']});
    for(const component of ['A','acute'])expect(read({A:widthChar(),acute:widthChar(),Aacute:seacChar,[component]:cs(...call(4))}).verify('Aacute')).toMatchObject({ok:false,code:'type1-other-subr-unsupported'});
  });
});
