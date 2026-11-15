import {parseCMap} from './cmap';
import {glyphUnicode,simpleNames} from './encodings';
import type {FontCoverage,FontInput,VerifiedCode} from './types';
import type {Type1Program} from './type1Program';
import type {Type1Diagnostic} from './type1Support';
import {Type1Error} from './type1Support';
import {resolveStandardMetrics} from './standardMetrics';
const matrixOk=(m:readonly number[])=>m.length===6&&m.every((n,i)=>n===[0.001,0,0,0.001,0,0][i]);
export function fillType1Coverage(report:FontCoverage,input:FontInput,program:Type1Program|undefined) {
  const afm=program?undefined:resolveStandardMetrics(input);
  const names=program?simpleNames(input,program.builtIn):afm!.names;
  const mappings=new Map<string,VerifiedCode>();report.mappings=mappings;report.failures=[];report.verification=program?'unverified':'assumed-standard';
  const fail=(d:Type1Diagnostic,hex?:string,cluster?:string)=>{
    report.failures!.push({...d,hex,cluster});report.missing.push({code:hex,cluster,reason:`${d.code}: ${d.detail}`});
  };
  let labels:Map<string,string>;
  if(input.toUnicode===undefined){
    // Original labels may be inspected, but names alone never authorize reuse.
    for(const [code,name]of names){const value=glyphUnicode(name);if(value)report.codeToUnicode.set(code.toString(16).padStart(2,'0'),value);}
    fail({code:'missing-tounicode',detail:'replacement requires a ToUnicode label'});return;
  }
  try{labels=parseCMap(input.toUnicode).unicode;}catch(e){if(!(e instanceof Error))throw e;fail({code:'tounicode-malformed',detail:e.message});return;}
  report.codeToUnicode=labels;
  if(program&&(!matrixOk(program.fontMatrix)||(input.fontMatrix!==undefined&&!matrixOk(input.fontMatrix)))){
    fail({code:'unsupported-matrix',detail:'Type1 requires the standard 0.001 diagonal FontMatrix'});return;
  }
  for(const [hex,label]of labels){
    const code=parseInt(hex,16),name=names.get(code);
    const reject=(code:Type1Diagnostic['code'],detail:string)=>fail({code,detail},hex,label);
    if(hex.length!==2||!name||name==='.notdef'){reject('glyph-unavailable','missing selected glyph name');continue;}
    const glyph=program?.verify(name);
    if(glyph&&!glyph.ok){fail(glyph,hex,label);continue;}
    const nameUnicode=glyphUnicode(name);
    if(nameUnicode===undefined){reject('glyph-unavailable',`no verified Unicode for /${name}`);continue;}
    if(nameUnicode!==label){reject('glyph-identity-conflict',`ToUnicode ${JSON.stringify(label)} disagrees with /${name} (${JSON.stringify(nameUnicode)})`);continue;}
    let width:number|undefined,source:VerifiedCode['widthSource']='pdf-widths';
    if(input.widths!==undefined){
      if(Number.isInteger(input.firstChar)&&input.firstChar!>=0&&input.firstChar!<=255&&code>=input.firstChar!&&
          (input.lastChar===undefined||(Number.isInteger(input.lastChar)&&code<=input.lastChar&&input.lastChar<=255)))width=input.widths?.[code-input.firstChar!];
    }else if(afm){width=afm.widthOf(code);source='standard-afm';}
    if(width===undefined||!Number.isFinite(width)){reject('font-metrics-missing',`no finite PDF/AFM width for code ${hex}`);continue;}
    if(glyph?.ok&&Math.abs(width-glyph.width)>1){reject('font-metrics-conflict',`PDF width ${width} differs from Type1 width ${glyph.width}`);continue;}
    mappings.set(hex,{bytes:Uint8Array.of(code),unicode:label,glyph:program?{kind:'type1-name',programHash:program.programHash,name}:{kind:'standard14',face:afm!.face,name},width1000:width,widthSource:source,unicodeSource:'to-unicode',replacementProof:{toUnicodeLabel:label,verifiedGlyphName:name,glyphNameUnicode:nameUnicode}});
    const values=report.encodable.get(label)??[];values.push(Uint8Array.of(code));report.encodable.set(label,values);
  }
  report.verification=program?(report.failures.length?'unverified':'verified'):'assumed-standard';
  if(afm)report.warnings.push('non-embedded standard font');
  for(const values of report.encodable.values())values.sort((a,b)=>a[0]!-b[0]!);
}
export function recordType1Error(report:FontCoverage,error:unknown):boolean {
  if(!(error instanceof Type1Error))return false;
  report.failures=[error.diagnostic];return true;
}
