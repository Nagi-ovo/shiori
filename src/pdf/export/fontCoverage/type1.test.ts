import {describe,expect,test} from 'bun:test';
import {decryptType1} from './type1Cipher';
import {type1Container} from './type1Container';
import {readType1Program} from './type1Program';
import {ascii,join,nums,pfb,tinyType1,widthChar} from './fixtures/type1';
const read=(extra:Parameters<typeof tinyType1>[0]={})=>{const f=tinyType1(extra);return readType1Program({subtype:'Type1',programKind:'FontFile',...f});};
const failure=(f:()=>unknown,code:string)=>expect(f).toThrow(code);
describe('bounded Type1 containers and cipher',()=>{
  test('independent cipher vector and prefix validation',()=>{
    // Literal ciphertext for plaintext [0,0,0,0,139,248,236,13,14].
    expect([...decryptType1(Uint8Array.of(16,191,49,112,121,200,75,146,91),4330,4)]).toEqual([139,248,236,13,14]);
    failure(()=>decryptType1(Uint8Array.of(1),4330,4),'type1-charstring-invalid');
    failure(()=>decryptType1(ascii('1234'),4330,33),'type1-charstring-invalid');
  });
  for(const hex of [false,true])test(`PFA ${hex?'hex':'binary'} and raw PDF segments`,()=>{
    const f=tinyType1({hex});
    expect(type1Container({subtype:'Type1',...f}).encrypted).toEqual(f.binary);
    expect(type1Container({subtype:'Type1',program:f.program}).encrypted).toEqual(f.binary);
    expect(read({hex}).verify('A')).toMatchObject({ok:true,width:600});
  });
  test('hex-looking first four binary eexec bytes retry raw binary in every container',()=>{
    // These discarded plaintext bytes independently encrypt to ASCII ABCD.
    const f=tinyType1({eexecPrefix:Uint8Array.of(152,7,41,220)});
    expect(f.binary.slice(0,4)).toEqual(ascii('ABCD'));
    for(const input of [{subtype:'Type1',...f},{subtype:'Type1',program:f.program},
      {subtype:'Type1',program:pfb([1,f.clear],[2,f.binary],[1,f.trailer])}]) {
      expect(readType1Program(input).verify('A')).toMatchObject({ok:true,width:600});
    }
  });
  test('PFB multiple records and terminal without length',()=>{
    const f=tinyType1(),p=pfb([1,f.clear],[2,f.binary.slice(0,11)],[2,f.binary.slice(11)],[1,f.trailer]);
    expect(readType1Program({subtype:'Type1',program:p}).verify('A')).toMatchObject({ok:true,width:600});
    for(const bad of [p.slice(0,-1),join(p,ascii('junk')),pfb([2,f.binary],[1,f.clear]),pfb([1,f.clear],[1,f.trailer],[2,f.binary])])failure(()=>type1Container({subtype:'Type1',program:bad}),'type1-container-invalid');
  });
  test('inconsistent lengths, trailer confusion, truncation, huge declared records',()=>{
    const f=tinyType1();
    failure(()=>type1Container({subtype:'Type1',...f,length2:f.length2+1}),'type1-container-invalid');
    failure(()=>type1Container({subtype:'Type1',program:join(f.clear,f.binary,ascii('cleartomark'))}),'type1-container-invalid');
    failure(()=>type1Container({subtype:'Type1',program:Uint8Array.of(128,1,255,255,255,255)}),'type1-container-invalid');
    failure(()=>type1Container({subtype:'Type1',program:new Uint8Array(16*1024*1024+1)}),'parser-budget-exceeded');
  });
  for(const lenIV of [-1,0,1,4])test(`lenIV ${lenIV} separately decrypts strings and subrs`,()=>{
    const p=read({lenIV,subrs:[Uint8Array.from([...nums(0,600),13,11])],glyphs:{A:Uint8Array.from([...nums(0),10,14])}});
    expect(p.verify('A')).toMatchObject({ok:true,width:600});
  });
});
describe('declarative dictionaries and reachable Type1 programs',()=>{
  test('encoding differences, ignored strings/comments and counted delimiter bytes',()=>{
    const p=read({encoding:'256 array 0 1 255 {1 index exch /.notdef put} for dup 7 /A put readonly',clear:'/Notice (eexec /Blend RD) def % /Design\n',glyphs:{A:widthChar(),bad:ascii('/Blend RD end')}});
    expect(p.builtIn.get(7)).toBe('A');expect(p.verify('A').ok).toBe(true);expect(p.verify('bad').ok).toBe(false);
  });
  for(const clear of ['/Blend [] def','/DesignVector [] def','/FontMatrix [1 0 0 1 0 0] def','/Encoding { makearray } def','/X /RD load def','/X true {1} if def','/RD {pop} def'])test(`reject dictionary construction ${clear}`,()=>{
    failure(()=>read({clear}),clear.includes('FontMatrix')?'type1-ps-unsupported':'type1-ps-unsupported');
  });
  test('MMType1 is refused even before container decoding',()=>failure(()=>readType1Program({subtype:'MMType1',program:ascii('bad')}),'type1-ps-unsupported'));
  test('sbw, div and actual hint/path stack effects',()=>{
    const good=Uint8Array.from([...nums(0,0,1200,2),12,12,...nums(0),12,7,...nums(0,20),1,...nums(0,0),21,...nums(50,0),5,9,12,0,14]);
    expect(read({glyphs:{A:good}}).verify('A')).toMatchObject({ok:true,width:600});
  });
  const bad:Record<string,number[]>={arity:[...nums(600),13,14],duplicate:[...nums(0,600),13,...nums(0,600),13,14],vertical:[...nums(0,0,600,1),12,7,14],divide:[...nums(0,600,0),12,12,13,14],hint:[...nums(0,600),13,...nums(1),1,14],noEnd:[...nums(0,600),13],afterEnd:[...nums(0,600),13,14,14],underflow:[10],return:[11],unknown:[...nums(0,600),13,2,14],stack:[...nums(...Array(25).fill(0)),13,14]};
  for(const [name,bytes]of Object.entries(bad))test(`invalid reachable glyph ${name} does not poison valid unused glyph`,()=>{
    const p=read({glyphs:{A:widthChar(),B:Uint8Array.from(bytes)}});expect(p.verify('A').ok).toBe(true);expect(p.verify('B').ok).toBe(false);
  });
  test('missing/recursive direct Subrs, no Type2 bias',()=>{
    for(const subrs of [[],[Uint8Array.from([...nums(0),10,11])]])expect(read({subrs,glyphs:{A:Uint8Array.from([...nums(0),10,14])}}).verify('A')).toMatchObject({ok:false,code:'type1-subr-invalid'});
  });
  test('seac uses StandardEncoding names and validates both components',()=>{
    const composite=Uint8Array.from([...nums(0,600),13,...nums(0,0,0,65,194),12,6]);
    expect(read({glyphs:{A:widthChar(),acute:widthChar(),Aacute:composite}}).verify('Aacute').ok).toBe(true);
    expect(read({glyphs:{A:widthChar(),Aacute:composite}}).verify('Aacute')).toMatchObject({ok:false,code:'glyph-unavailable'});
  });
  test('incomplete flex/hint replacement and unknown OtherSubrs refuse precisely',()=>{
    for(const other of [0,1,2,3,19])expect(read({glyphs:{A:Uint8Array.from([...nums(0,600),13,...nums(0,other),12,16,14])}}).verify('A')).toMatchObject({ok:false,code:'type1-other-subr-unsupported'});
  });
  test('.notdef cannot authorize replacement',()=>expect(read().verify('.notdef')).toMatchObject({ok:false,code:'glyph-unavailable'}));
});

test('alias definitions terminate private hints and inert OtherSubrs never execute',()=>{
  const f=tinyType1({private:'/BlueValues [0 10] ND\n/OtherSubrs [{} {} {} {systemdict /internaldict known {pop} {pop} ifelse}] ND'});
  expect(readType1Program({subtype:'Type1',...f}).verify('A').ok).toBe(true);
});
test('all definitions and inert procedures are checked for MM declarations before glyph execution',()=>{
  failure(()=>read({private:'/OtherSubrs [{/DesignVector [] def}] def'}),'type1-ps-unsupported');
});

test('nesting, declared string/count and reachable depth/operation budgets are precise',()=>{
  failure(()=>read({private:'/Subrs 65537 array def'}),'parser-budget-exceeded');
  failure(()=>read({clear:'/XUID '+ '['.repeat(65)+'0'+']'.repeat(65)+' def'}),'parser-budget-exceeded');
  failure(()=>read({glyphs:{A:new Uint8Array(1024*1024+1)}}),'parser-budget-exceeded');
  const chain=Array.from({length:18},(_,i)=>Uint8Array.from([...nums(i+1),10,11]));
  expect(read({subrs:chain,glyphs:{A:Uint8Array.from([...nums(0),10,14])}}).verify('A')).toMatchObject({ok:false,code:'parser-budget-exceeded',data:{parser:'type1-charstring',limit:'depth'}});
  const busy=Uint8Array.from([...nums(0,600),13,...Array.from({length:100001},()=>[12,0]).flat(),14]);
  expect(read({glyphs:{A:busy}}).verify('A')).toMatchObject({ok:false,code:'parser-budget-exceeded',data:{limit:'glyph-ops'}});
});
test('literal names cannot impersonate executable dictionary control words',()=>{
  const f=tinyType1(),privateBytes=ascii('dup Private 1 dict dup begin /lenIV -1 def end');
  const binary=encryptFixture(privateBytes);
  failure(()=>readType1Program({subtype:'Type1',program:join(f.clear,binary,f.trailer),length1:f.clear.length,length2:binary.length,length3:f.trailer.length}),'type1-ps-unsupported');
});
function encryptFixture(bytes:Uint8Array){
  let r=55665;return join(Uint8Array.of(0,0,0,0),bytes).map(b=>{const c=b^(r>>>8);r=((c+r)*52845+22719)&65535;return c;});
}
test('mixed Subr/component depth shares one closure limit',()=>{
  const seac=(base:number)=>Uint8Array.from([...nums(0,0,0,base,194),12,6]);
  const subrs=Array.from({length:18},(_,i)=>i===8?seac(65):i===17?seac(66):Uint8Array.from([...nums(i+1),10]));
  const root=(index:number)=>Uint8Array.from([...nums(0,600),13,...nums(index),10]);
  const p=read({subrs,glyphs:{Z:root(0),A:root(9),B:widthChar(),acute:widthChar()}});
  expect(p.verify('Z')).toMatchObject({ok:false,code:'parser-budget-exceeded',data:{limit:'depth'}});
});
test('literal horizontal WMode is accepted while vertical WMode stays unsupported',()=>{
 expect(read({clear:'/WMode 0 def'}).verify('A').ok).toBe(true);
 failure(()=>read({clear:'/WMode 1 def'}),'type1-ps-unsupported');
});
test('Type1 ink encloses cubic controls and reachable Subrs independently of FontBBox',()=>{
 const curve=Uint8Array.from([...nums(0,600),13,...nums(100,20),21,...nums(0),10,14]);
 const subr=Uint8Array.from([...nums(50,200,100,-50,50,-100),8,11]);
 expect(read({glyphs:{A:curve},subrs:[subr]}).verify('A')).toMatchObject({ok:true,inkBounds:{x:100,y:20,w:200,h:200}});
 expect(read({glyphs:{A:widthChar()}}).verify('A')).toMatchObject({ok:true,inkBounds:null});
});
