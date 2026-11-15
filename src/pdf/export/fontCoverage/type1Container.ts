import type {FontInput} from './types';
import {Type1Lexer,psSpace} from './type1Lexer';
import {rejectType1,type1Budget,type1Limits} from './type1Support';
function fail(s:string):never {return rejectType1('type1-container-invalid',`Type1 ${s}`);}
const text=(b:Uint8Array)=>new TextDecoder('latin1').decode(b);
const join=(parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));let p=0;for(const b of parts){out.set(b,p);p+=b.length;}return out;};
function clearEnd(bytes:Uint8Array):number {
  const l=new Type1Lexer(bytes);let last='';
  for(let t=l.next();t;t=l.next()){
    if(t.kind==='word'&&t.value==='eexec'){
      if(last!=='currentfile')fail('eexec without currentfile');
      if(!psSpace(bytes[l.pos]??-1))fail('eexec separator missing');
      if(bytes[l.pos]===13&&bytes[l.pos+1]===10)l.pos++;
      return l.pos+1;
    }
    last=t.kind==='word'?t.value:'';
  }
  return fail('eexec not found');
}
function trailerValid(bytes:Uint8Array,required:boolean) {
  if(!bytes.length&&!required)return;
  if(!/^[\s0]*cleartomark\s*(?:%[^\r\n]*(?:[\r\n]|$)\s*)*$/.test(text(bytes)))fail('invalid trailer');
}
function decodeEncrypted(bytes:Uint8Array,allowHex=true):{encrypted:Uint8Array;binaryRetry?:Uint8Array} {
  if(bytes.length<4)fail('encrypted segment truncated');
  const prefix=bytes.slice(0,4);
  if(allowHex&&[...prefix].every(c=>/[\da-f]/i.test(String.fromCharCode(c)))){
    const s=text(bytes).replace(/\s/g,'');
    // A hex-looking binary prefix is possible. Keep raw ciphertext until the
    // decrypted dictionary has proved which interpretation is valid.
    if(/^[\da-f]+$/i.test(s)&&s.length%2===0)return {encrypted:Uint8Array.from(s.match(/../g)!,h=>parseInt(h,16)),binaryRetry:bytes.slice()};
  }
  return {encrypted:bytes.slice()};
}
export function type1Container(input:FontInput):{clear:Uint8Array;encrypted:Uint8Array;trailer:Uint8Array;binaryRetry?:Uint8Array} {
  const bytes=input.program;if(!bytes?.length)fail('missing Type1 data');
  if(bytes.length>type1Limits.bytes)type1Budget('type1-container','decoded-bytes');
  const lengths=[input.length1,input.length2,input.length3];
  if(bytes[0]===128){
    if(lengths.some(n=>n!==undefined))fail('PFB wrapper with PDF segment lengths');
    let p=0,phase=0,terminal=false;const parts:Uint8Array[][]=[[],[],[]];
    while(p<bytes.length){
      if(bytes[p++]!==128)fail('PFB marker');const kind=bytes[p++];
      if(kind===3){terminal=true;if(phase<1||p!==bytes.length)fail('PFB terminal order');break;}
      if(kind!==1&&kind!==2||p+4>bytes.length)fail('PFB record header');
      const n=new DataView(bytes.buffer,bytes.byteOffset+p,4).getUint32(0,true);p+=4;
      if(n===0||n>bytes.length-p)fail('PFB record length');
      if(kind===2){if(phase===2)fail('PFB encrypted record after trailer');phase=1;}
      else if(phase===1)phase=2;
      parts[phase]!.push(bytes.slice(p,p+n));p+=n;
    }
    if(!terminal||!parts[0]!.length||!parts[1]!.length)fail('incomplete PFB');
    const [clear,encrypted,trailer]=parts.map(join) as [Uint8Array,Uint8Array,Uint8Array];
    if(clearEnd(clear)!==clear.length)fail('clear segment boundary');trailerValid(trailer,false);
    return {clear,...decodeEncrypted(encrypted,false),trailer};
  }
  if(lengths.some(n=>n!==undefined)){
    if(lengths.some(n=>!Number.isSafeInteger(n)||n!<0)||(input.length1!+input.length2!+input.length3!)!==bytes.length)fail('conflicting PDF Length1/2/3');
    const a=input.length1!,b=a+input.length2!;
    const clear=bytes.slice(0,a),trailer=bytes.slice(b);
    if(clearEnd(clear)!==a)fail('PDF clear segment boundary');trailerValid(trailer,false);
    return {clear,...decodeEncrypted(bytes.slice(a,b)),trailer};
  }
  const a=clearEnd(bytes),suffix=text(bytes.slice(a));
  // An anchored conventional 512-zero trailer is the only standalone boundary
  // supported. Never search ciphertext for PostScript keywords.
  const match=/\r?\n((?:0[\t \r\n]*){512})cleartomark\s*(?:%[^\r\n]*(?:[\r\n]|$)\s*)*$/.exec(suffix);
  if(!match)fail('ambiguous standalone eexec boundary');
  const b=a+match.index,trailer=bytes.slice(b);trailerValid(trailer,true);
  return {clear:bytes.slice(0,a),...decodeEncrypted(bytes.slice(a,b)),trailer};
}
