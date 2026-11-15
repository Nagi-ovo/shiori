import {readType1Program} from '../../src/pdf/export/fontCoverage/type1Program';
import {simpleNames} from '../../src/pdf/export/fontCoverage/encodings';
import {rejectType1,type Type1Diagnostic} from '../../src/pdf/export/fontCoverage/type1Support';
import type {FontInput} from '../../src/pdf/export/fontCoverage/types';

/** Research precision adapter, NOT export eligibility. Production still uses
 * dictionary widths. PDFium uses the embedded program's fractional advances;
 * retain those only after the production parser's character-space check.
 * Rust receives numbers and never parses Type1.
 */
export function type1ProgramWidths(input:FontInput) {
 if(input.error)throw Error(input.error);
 const program=readType1Program(input),standard=[.001,0,0,.001,0,0];
 if([program.fontMatrix,input.fontMatrix??standard].some(m=>m.length!==6||m.some((n,i)=>n!==standard[i])))
  rejectType1('unsupported-matrix','research Type1 metrics require the standard FontMatrix');
 const widths=new Map<number,number>(),failures:(Type1Diagnostic&{sourceCode:number})[]=[];
 for(const [code,name] of simpleNames(input,program.builtIn)){
  const width=input.firstChar===undefined?undefined:input.widths?.[code-input.firstChar];
  if(width===undefined||!Number.isFinite(width)||code<(input.firstChar??0)||code>(input.lastChar??255)||name==='.notdef')continue;
  const glyph=program.verify(name);
  if(!glyph.ok){failures.push({...glyph,sourceCode:code});continue;}
  if(Math.abs(width-glyph.width)>1){failures.push({code:'font-metrics-conflict',detail:`PDF ${width}, program ${glyph.width}`,sourceCode:code});continue;}
  widths.set(code,glyph.width);
 }
 return {widths,failures};
}
