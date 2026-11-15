import {standardNames} from './encodings';
import {Type1Lexer} from './type1Lexer';
import type {PSToken} from './type1Lexer';
import {rejectType1,type1Budget,type1Limits} from './type1Support';
export type Type1Dictionary={builtIn:Map<number,string>;fontMatrix:number[];fontBBox:number[];lenIV:number;subrs:Map<number,Uint8Array>;chars:Map<string,Uint8Array>};
const fail=(s:string):never=>rejectType1('type1-ps-unsupported',s);
class Reader {
  pending?:PSToken;
  readonly lexer:Type1Lexer;
  constructor(lexer:Type1Lexer){this.lexer=lexer;}
  peek(){return this.pending??=this.lexer.next();}
  take():PSToken {const t=this.peek();this.pending=undefined;if(!t)return fail('unexpected end of dictionary');if((t.kind==='name'||t.kind==='word')&&/^(?:Blend|Design|WeightVector|NormalizeDesignVector|ConvertDesignVector)/.test(t.value))fail(t.value);return t;}
  value(s:string){
    const t=this.take(),kind=['Private','CharStrings','FontName'].includes(s)?'name':/^[0-9]+$/.test(s)?'number':'[]{}'.includes(s)?'delimiter':'word';
    if(t.value!==s||t.kind!==kind)fail(`expected ${s}, got ${t.value}`);return t;
  }
  number(){const t=this.take();if(t.kind!=='number')return fail('expected literal number');return +t.value;}
  name(){const t=this.take();if(t.kind!=='name')return fail('expected literal name');return t.value;}
  list(open:string,close:string,depth=0):PSToken[] {
    if(depth>=type1Limits.nesting)type1Budget('type1-dictionary','nesting');
    this.value(open);const out:PSToken[]=[];
    while(this.peek()?.value!==close){const t=this.peek();if(!t)fail('unterminated literal');if(t!.value==='['||t!.value==='{'){const a=t!.value,b=a==='['?']':'}';out.push({kind:'delimiter',value:a,start:0,end:0},...this.list(a,b,depth+1),{kind:'delimiter',value:b,start:0,end:0});}else out.push(this.take());}
    this.value(close);return out;
  }
  literal():PSToken[] {
    const t=this.peek();if(!t)return fail('missing literal');
    if(t.value==='['||t.value==='{')return this.list(t.value,t.value==='['?']':'}');
    const value=this.take();if(!['number','name','string'].includes(value.kind)&&!['true','false'].includes(value.value))fail(`executable literal ${value.value}`);return [value];
  }
  finish(kind:'def'|'put'='def'){
    if(['readonly','noaccess'].includes(this.peek()?.value??''))this.take();this.value(kind);
  }
}
const safeKeys=new Set(['FontName','FontType','PaintType','UniqueID','XUID','version','Notice','Copyright','FullName','FamilyName','Weight','ItalicAngle','isFixedPitch','UnderlinePosition','UnderlineThickness','FSType','BlueValues','OtherBlues','FamilyBlues','FamilyOtherBlues','BlueScale','BlueShift','BlueFuzz','StdHW','StdVW','StemSnapH','StemSnapV','ForceBold','LanguageGroup','ExpansionFactor','RndStemUp','MinFeature','password']);
function boundedCount(n:number){if(!Number.isInteger(n)||n<0)fail('invalid count');if(n>type1Limits.strings)type1Budget('type1-dictionary','string-count');return n;}
function literalSafe(tokens:PSToken[]){for(const t of tokens)if(t.kind==='word'&&!['true','false'].includes(t.value))fail(`executable literal ${t.value}`);}
/** Deliberately a statement grammar, not an evaluator. New idioms require fixtures. */
export function type1Dictionary(clear:Uint8Array,privateBytes:Uint8Array):Type1Dictionary {
  const result:Type1Dictionary={builtIn:new Map(),fontMatrix:[],fontBBox:[],lenIV:4,subrs:new Map(),chars:new Map()};
  const seen=new Map<string,string>();
  const readers=new Set<string>(),defs=new Set<string>(),puts=new Set<string>();
  const endDefinition=(r:Reader)=>{if(defs.has(r.peek()?.value??''))r.take();else r.finish();};
  const define=(key:string,tokens:PSToken[],scope:string)=>{const value=JSON.stringify(tokens.map(t=>[t.kind,t.value])),id=scope+':'+key;const old=seen.get(id);if(old!==undefined&&old!==value)fail(`contradictory /${key}`);seen.set(id,value);};
  const simple=(r:Reader,key:string,scope:string)=>{
    if(!safeKeys.has(key)&&!['FontMatrix','FontBBox','lenIV'].includes(key))fail(`unsupported definition /${key}`);
    if(['FontMatrix','FontBBox','FontType','PaintType','FontName'].includes(key)&&scope!=='font')fail(`/${key} in unsupported dictionary`);
    const v=r.literal();literalSafe(v);define(key,v,scope);
    if(key==='FontMatrix'||key==='FontBBox'){
      const n=v.map(t=>t.kind==='number'?+t.value:NaN);if(n.length!==(key==='FontMatrix'?6:4)||n.some(x=>!Number.isFinite(x)))fail(`invalid /${key}`);
      result[key==='FontMatrix'?'fontMatrix':'fontBBox']=n;
    }
    if(key==='FontType'&&(v.length!==1||v[0]!.value!=='1'))fail('non-Type1 FontType');
    if(key==='PaintType'&&(v.length!==1||v[0]!.value!=='0'))fail('non-fill PaintType');
    if(key==='lenIV'){if(v.length!==1||v[0]!.kind!=='number'||!Number.isInteger(+v[0]!.value)||+v[0]!.value< -1||+v[0]!.value>32)fail('invalid lenIV');result.lenIV=+v[0]!.value;}
    endDefinition(r);
  };
  const encoding=(r:Reader)=>{
    const map=new Map<number,string>();
    if(r.peek()?.value==='StandardEncoding'){r.take();for(const e of standardNames)map.set(...e);}
    else if(r.peek()?.value==='['){const v=r.list('[',']');if(v.length!==256||v.some(t=>t.kind!=='name'))fail('Encoding must be 256 literal names');v.forEach((t,i)=>map.set(i,t.value));}
    else {
      if(r.number()!==256)fail('Encoding length');r.value('array');
      r.value('0');r.value('1');r.value('255');const init=r.list('{','}').map(t=>t.kind==='name'?'/'+t.value:t.value).join(' ');
      if(init!=='1 index exch /.notdef put')fail('unsupported Encoding initialization');r.value('for');
      for(let i=0;i<256;i++)map.set(i,'.notdef');
    }
    const differences=new Map<number,string>();
    while(r.peek()?.value==='dup'){
      r.take();const code=r.number();if(!Number.isInteger(code)||code<0||code>255)fail('Encoding code');const name=r.name();r.value('put');
      if(differences.has(code)&&differences.get(code)!==name)fail('contradictory Encoding slot');differences.set(code,name);map.set(code,name);
    }
    const marker=JSON.stringify([...map]);if(seen.has('encoding')&&seen.get('encoding')!==marker)fail('contradictory Encoding');seen.set('encoding',marker);result.builtIn=map;r.finish();
  };
  const tokenBudget={tokens:0};
  const h=new Reader(new Type1Lexer(clear,tokenBudget));boundedCount(h.number());h.value('dict');h.value('begin');
  while(h.peek()?.kind==='name'){
    const key=h.name();
    if(key==='Encoding')encoding(h);
    else if(key==='FontInfo'){
      boundedCount(h.number());h.value('dict');h.value('dup');h.value('begin');while(h.peek()?.kind==='name')simple(h,h.name(),'FontInfo');h.value('end');h.finish();
    }else simple(h,key,'font');
  }
  h.value('currentdict');h.value('end');h.value('currentfile');h.value('eexec');if(h.peek())fail('extra clear program');
  if(!seen.has('encoding')||!result.fontMatrix.length)fail('missing Encoding / FontMatrix');
  const r=new Reader(new Type1Lexer(privateBytes,tokenBudget));
  r.value('dup');r.value('Private');boundedCount(r.number());r.value('dict');r.value('dup');r.value('begin');
  const endDef=(set:Set<string>)=>{if(set.has(r.peek()?.value??''))r.take();else r.finish();};
  const raw=()=>{const n=r.number(),alias=r.take();if(alias.kind!=='word'||!readers.has(alias.value))return fail('unverified RD reader');return r.lexer.raw(n);};
  const chars=()=>{
    r.value('CharStrings');const count=boundedCount(r.number());r.value('dict');r.value('dup');r.value('begin');
    while(r.peek()?.kind==='name'){
      const name=r.name();if(result.chars.size>=count)fail('CharStrings count exceeded');const bytes=raw();if(result.chars.has(name))fail('duplicate CharString');result.chars.set(name,bytes);endDef(defs);
    }
    r.value('end');
  };
  let gotChars=false,gotSubrs=false;
  while(r.peek()?.value!=='end'){
    if(r.peek()?.value==='2'){r.take();r.value('index');chars();gotChars=true;break;}
    const key=r.name();
    if(key==='CharStrings')fail('CharStrings requires declared dictionary context');
    if(key==='Subrs'){
      if(gotSubrs)fail('duplicate Subrs');gotSubrs=true;const count=boundedCount(r.number());r.value('array');
      while(r.peek()?.value==='dup'){
        r.take();const index=r.number();if(!Number.isInteger(index)||index<0||index>=count||result.subrs.has(index))fail('invalid Subrs index');
        result.subrs.set(index,raw());if(puts.has(r.peek()?.value??''))r.take();else {if(r.peek()?.value==='noaccess')r.take();r.value('put');}
      }
      endDef(defs);
    }else if(r.peek()?.value==='{'&&['RD','ND','NP','-|','|-','|'].includes(key)){
      const body=r.list('{','}').map(t=>t.value).join(' ');
      if(body==='string currentfile exch readstring pop')readers.add(key);
      else if(body==='noaccess def')defs.add(key);
      else if(body==='noaccess put')puts.add(key);
      else fail(`unsupported alias /${key}`);
      define(key,[{kind:'string',value:body,start:0,end:0}],'Private');if(r.peek()?.value==='executeonly')r.take();r.finish();
    }else if(key==='OtherSubrs'){
      // Procedure bodies are inert data here. Every callothersubr refuses.
      // At array level only literal procedures and access modifiers are legal;
      // executable array generation is never evaluated.
      const v=r.list('[',']');define(key,v,'Private');let nesting=0,hadProc=false;
      for(const t of v){
        if(t.value==='{'){nesting++;hadProc=true;}
        else if(t.value==='}'){if(--nesting<0)fail('OtherSubrs procedure');}
        else if(nesting===0&&!(hadProc&&['executeonly','readonly','noaccess'].includes(t.value)))fail('executable OtherSubrs array');
      }
      if(nesting)fail('OtherSubrs procedure');endDefinition(r);
    }else simple(r,key,'Private');
  }
  if(!gotChars)fail('missing CharStrings');
  r.value('end');r.finish('put');r.finish('put');
  r.value('dup');r.value('FontName');r.value('get');r.value('exch');r.value('definefont');r.value('pop');
  r.value('mark');r.value('currentfile');r.value('closefile');
  // Only whitespace may follow the declared closefile, never guessed cipher padding.
  if(r.peek())fail('extra encrypted program');
  if(h.lexer.count+r.lexer.count>type1Limits.tokens)type1Budget('type1-dictionary','tokens');
  return result;
}
