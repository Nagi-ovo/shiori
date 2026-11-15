import {standardNames} from './encodings';
import {decryptType1} from './type1Cipher';
import type {Type1Dictionary} from './type1Dictionary';
import {Type1Error,rejectType1,type1Budget,type1Limits} from './type1Support';
import type {Type1Diagnostic} from './type1Support';
export type Type1Glyph={ok:true;name:string;width:number;sidebearing:readonly [number,number];dependencies:readonly string[]};
export type Type1GlyphResult=Type1Glyph|({ok:false}&Type1Diagnostic);
/** Proves the complete reachable closure. Widths are raw character-space units. */
export function type1CharStrings(dict:Type1Dictionary) {
  const cache=new Map<string,Type1GlyphResult>();let fontOps=0;
  const prove=(name:string,ancestors:readonly string[]=[],shared?:{ops:number},baseDepth=0):Type1GlyphResult=>{
    if(ancestors.includes(name))return {ok:false,code:'type1-subr-invalid',detail:`recursive component ${name}`};
    // Cached closures are not used in component execution: all reachable work
    // counts against the caller's operation/depth budget, including repeats.
    if(!ancestors.length&&cache.has(name))return cache.get(name)!;
    const work=shared??{ops:0};
    try {
      if(name==='.notdef'||!dict.chars.has(name))rejectType1('glyph-unavailable',`missing or .notdef glyph ${name}`);
      if(baseDepth>type1Limits.depth)type1Budget('type1-charstring','depth');
      const stack:number[]=[],dependencies:string[]=[];let width:number|undefined,sb:[number,number]=[0,0],path=false;
      const bad=(s:string):never=>rejectType1('type1-charstring-invalid',`${name}: ${s}`);
      const exact=(n:number)=>{if(stack.length!==n)bad(`arity ${stack.length}, expected ${n}`);};
      const push=(n:number)=>{if(!Number.isFinite(n))bad('nonfinite operand');if(stack.length>=type1Limits.stack)type1Budget('type1-charstring','operands');stack.push(n);};
      const pop=()=>{if(!stack.length)return bad('operand underflow');return stack.pop()!;};
      const execute=(cipher:Uint8Array,subr:boolean,calls:readonly number[]):'return'|'end'=>{
        if(baseDepth+calls.length>type1Limits.depth)type1Budget('type1-charstring','depth');
        const bytes=decryptType1(cipher,4330,dict.lenIV);let p=0;
        const byte=()=>{if(p>=bytes.length)return bad('truncated number/operator');return bytes[p++]!;};
        while(p<bytes.length){
          const b=byte();
          if(b>=32){
            let n:number;if(b<=246)n=b-139;else if(b<=250)n=(b-247)*256+byte()+108;else if(b<=254)n=-(b-251)*256-byte()-108;else n=(byte()<<24)|(byte()<<16)|(byte()<<8)|byte();
            push(n);continue;
          }
          if(++work.ops>type1Limits.glyphOps)type1Budget('type1-charstring','glyph-ops');
          if(++fontOps>type1Limits.fontOps)type1Budget('type1-charstring','font-ops');
          const op=b===12?1200+byte():b;
          if(op===1212){const divisor=pop(),numerator=pop();if(divisor===0)bad('division by zero');push(numerator/divisor);continue;}
          if(op===10){
            const index=pop();if(!Number.isInteger(index)||!dict.subrs.has(index)||calls.includes(index))rejectType1('type1-subr-invalid',`${name}: missing/recursive Subr ${index}`);
            dependencies.push(`subr:${index}`);const outcome=execute(dict.subrs.get(index)!,true,[...calls,index]);
            if(outcome==='end'){if(p!==bytes.length)bad('bytes after terminated Subr');return 'end';}continue;
          }
          if(op===11){if(!subr||p!==bytes.length)rejectType1('type1-subr-invalid',`${name}: invalid return`);return 'return';}
          if(op===1216||op===1217)rejectType1('type1-other-subr-unsupported',`${name}: OtherSubr/pop requires a dedicated proof`);
          if(op===13||op===1207){
            if(width!==undefined)bad('duplicate width');exact(op===13?2:4);
            if(op===13){sb=[stack[0]!,0];width=stack[1]!;}else {sb=[stack[0]!,stack[1]!];width=stack[2]!;if(stack[3]!==0)bad('nonhorizontal width');}
            stack.length=0;continue;
          }
          if(width===undefined)bad('operator before width');
          if(op===14){exact(0);if(p!==bytes.length)bad('bytes after endchar');return 'end';}
          if(op===1206){
            exact(5);const [asb,,,base,accent]=stack;
            for(const code of [base!,accent!])if(!Number.isInteger(code)||code<0||code>255)bad('invalid seac code');
            const names=[standardNames.get(base!)??'.notdef',standardNames.get(accent!)??'.notdef'];
            const components=names.map(component=>{
              dependencies.push(`glyph:${component}`);const proof=prove(component,[...ancestors,name],work,baseDepth+calls.length+1);
              if(!proof.ok)rejectType1(proof.code,proof.detail,proof.data);return proof;
            });
            if(components[0]!.width!==width||components[0]!.sidebearing[0]!==sb[0]||components[0]!.sidebearing[1]!==sb[1]||components[1]!.sidebearing[0]!==asb)bad('seac metrics disagree');
            stack.length=0;if(p!==bytes.length)bad('bytes after seac');return 'end';
          }
          const arities:Record<number,number>={1:2,3:2,4:1,5:2,6:1,7:1,8:6,9:0,21:2,22:1,30:4,31:4,1200:0,1201:6,1202:6,1233:2};
          const arity=arities[op];if(arity===undefined)rejectType1('type1-charstring-unsupported',`${name}: operator ${op}`);
          exact(arity);
          if([4,21,22,1233].includes(op))path=true;
          if([5,6,7,8,9,30,31].includes(op)&&!path)bad('path without initial move');
          stack.length=0;
        }
        return bad(subr?'Subr without return':'CharString without endchar');
      };
      if(execute(dict.chars.get(name)!,false,[])!=='end'||width===undefined)bad('invalid termination');
      const result:Type1Glyph={ok:true,name,width:width!,sidebearing:sb,dependencies};if(!ancestors.length)cache.set(name,result);return result;
    }catch(e){if(!(e instanceof Type1Error))throw e;const result={ok:false as const,...e.diagnostic};if(!ancestors.length)cache.set(name,result);return result;}
  };
  return {verify:(name:string)=>prove(name),glyphs:cache};
}
