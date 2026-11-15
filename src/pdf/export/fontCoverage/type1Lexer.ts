import {rejectType1,type1Budget,type1Limits} from './type1Support';
export type PSToken={kind:'name'|'word'|'number'|'string'|'delimiter';value:string;start:number;end:number};
export const psSpace=(b:number)=>b===0||b===9||b===10||b===12||b===13||b===32;
const delimit=(b:number)=>psSpace(b)||'()<>[]{}/%'.includes(String.fromCharCode(b));
/** Lexes only structure. Counted binary strings bypass this lexer entirely. */
export class Type1Lexer {
  pos=0;count=0;
  readonly bytes:Uint8Array;
  readonly budget:{tokens:number};
  constructor(bytes:Uint8Array,budget={tokens:0}){this.bytes=bytes;this.budget=budget;}
  next():PSToken|undefined {
    const b=this.bytes;
    while(this.pos<b.length){if(psSpace(b[this.pos]!)){this.pos++;continue;}if(b[this.pos]===37){while(this.pos<b.length&&b[this.pos]!==10&&b[this.pos]!==13)this.pos++;continue;}break;}
    if(this.pos===b.length)return;
    this.count++;
    if(++this.budget.tokens>type1Limits.tokens)type1Budget('type1-dictionary','tokens');
    const start=this.pos,c=b[this.pos++]!;
    let kind:PSToken['kind']='word',value='';
    if(c===40){kind='string';let depth=1;
      while(this.pos<b.length&&depth){const x=b[this.pos++]!;if(x===92){if(this.pos>=b.length)break;this.pos++;}else if(x===40){if(++depth>type1Limits.nesting)type1Budget('type1-dictionary','nesting');}else if(x===41)depth--;}
      if(depth)rejectType1('type1-ps-unsupported','unterminated literal string');
    }else if(c===60&&b[this.pos]!==60){kind='string';while(this.pos<b.length&&b[this.pos]!==62)this.pos++;if(this.pos===b.length)rejectType1('type1-ps-unsupported','unterminated hex string');this.pos++;
    }else if('[]{}<>'.includes(String.fromCharCode(c))){kind='delimiter';if((c===60||c===62)&&b[this.pos]===c)this.pos++;
    }else {
      if(c===47)kind='name';
      while(this.pos<b.length&&!delimit(b[this.pos]!))this.pos++;
      if(c===41)rejectType1('type1-ps-unsupported','unexpected delimiter');
    }
    for(let i=start;i<this.pos;i++)value+=String.fromCharCode(b[i]!);
    if(kind==='name')value=value.slice(1);
    if(kind==='word'&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)){kind='number';if(!Number.isFinite(+value))rejectType1('type1-ps-unsupported','nonfinite number');}
    return {kind,value,start,end:this.pos};
  }
  raw(length:number):Uint8Array {
    if(!Number.isInteger(length)||length<0)rejectType1('type1-ps-unsupported','invalid RD length');
    if(length>type1Limits.stringBytes)type1Budget('type1-dictionary','string-bytes');
    if(!psSpace(this.bytes[this.pos]??-1))rejectType1('type1-ps-unsupported','RD missing separator');
    this.pos++; // readstring consumes bytes after exactly one delimiter.
    if(this.pos+length>this.bytes.length)rejectType1('type1-ps-unsupported','truncated RD string');
    const out=this.bytes.slice(this.pos,this.pos+length);this.pos+=length;return out;
  }
}
