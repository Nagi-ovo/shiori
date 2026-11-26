import {sourceFingerprint,type ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import type {ParagraphInput,SourceAddress,TextTrace} from './regionProof';
import type {ReflowRequest} from './reflowTypes';
import {overlay} from './fixtures.test-support';

/** Explicit numeric R1/R2 test evidence, never used by a production caller. */
export function reflowFixture(lefts=[50,50,50],leadingIndent=false,unowned=false){
 const alphabet=Array.from('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉');
 const unicodeByCode=new Map(alphabet.map((s,i)=>[i+1,s]));
 const font:ResolvedRunFont={resourceName:'F1',objectId:'7 0 R',bytesPerCode:1,
  ascentEm:.8,descentEm:-.2,unicodeByCode,widthOf:()=>1000,
  canEncode:text=>{const codes=Array.from(text).map(s=>Uint8Array.of(alphabet.indexOf(s)+1));
   return {ok:true,bytes:Uint8Array.from(codes.flatMap(c=>[...c])),codes,preferredApplied:false};}};
 const lengths=lefts.map((x,i)=>i===2?3:Math.floor((150-x)/10));
 const items=lengths.map(n=>Uint8Array.from({length:n},(_,i)=>i+1));
 const content=new TextEncoder().encode(`BT /F1 10 Tf 14 TL ${lefts.map((x,i)=>
  `1 0 0 1 ${leadingIndent&&i===0?50:x} ${700-i*14} Tm `+
  (leadingIndent&&i===0?`[${-(x-50)*100} <${Array.from(items[i]!,b=>b.toString(16).padStart(2,'0')).join('')}>] TJ`:
   `<${Array.from(items[i]!,b=>b.toString(16).padStart(2,'0')).join('')}> Tj`)).join(' ')} ${unowned?'0 -14 Td <0102> Tj ':''}ET`);
 const sourceHash=sourceFingerprint(content),ops=tokenizeContentStream(content);
 const trace=(opIndex:number,x:number,y:number,left:number):TextTrace=>({bt:0,opIndex,
  ctm:[1,0,0,1,0,0],tm:[1,0,0,1,x,y],tlm:[1,0,0,1,left,y],fontObject:font.objectId,
  size:10,tc:0,tw:0,tz:100,leading:14,rise:0,renderMode:0,safetyHash:'scope'});
 const paragraph:ParagraphInput={sourceHash,dependencyHash:'deps',ops,rasterGuardPt:0,
  lines:lefts.map((x,i)=>({anchor:trace(3+i*2,leadingIndent&&i===0?50:x,700-i*14,leadingIndent&&i===0?50:x),
   shows:[{source:{streamHash:sourceHash,opIndex:4+i*2,itemIndex:leadingIndent&&i===0?1:-1,byteStart:0,byteEnd:items[i]!.length,fontObject:font.objectId},
    unicode:Array.from(items[i]!,c=>unicodeByCode.get(c)).join(''),
    before:trace(4+i*2,x,700-i*14,leadingIndent&&i===0?50:x),
    after:trace(4+i*2,x+lengths[i]!*10,700-i*14,leadingIndent&&i===0?50:x)}],
   ink:{x:x+1,y:698-i*14,w:lengths[i]!*10-2,h:10}})),
  evidence:{sourceHash,dependencyHash:'deps',obstacleProofHash:'scene',boundaryProofHash:'body',scopeProofHash:'scope',
   completeScene:true,readingOrder:'proven',whitespace:'source-codes',structure:'body-text',columnBoundary:'proven',
   semantics:'plain',inlineFeatures:'plain-prose',crop:{x:0,y:0,w:600,h:800},clip:{x:0,y:0,w:600,h:800},obstacles:[]}};
 const walked=walkTextPlacements(ops,{resolveFont:()=>({...font,ok:true,appliesWordSpacing:true})});
 if(!walked.ok)throw Error(walked.reason);
 const address=(g:typeof walked.glyphs[number]):SourceAddress=>({streamHash:sourceHash,opIndex:g.opIndex,
  itemIndex:g.arrayItemIndex,byteStart:g.byteOffset,byteEnd:g.byteOffset+g.byteLength,fontObject:font.objectId});
 const target=walked.glyphs[lengths[0]!-2]!;
 const request:ReflowRequest={paragraph,dependencyHash:'deps',target:address(target),softBreaks:[0,1],
  sourceInk:walked.glyphs.filter(g=>g.opIndex<=8).map(g=>({source:address(g),box:{x:1,y:-2,w:8,h:10},
   glyph:{kind:'type1-name',programHash:'numeric-fixture',name:unicodeByCode.get(g.code)!},proofHash:'hand-specified-ink'})),
  replacementInk:['卯','辰'].map(unicode=>({unicode,code:Uint8Array.of(alphabet.indexOf(unicode)+1),box:{x:1,y:-2,w:8,h:10},proofHash:'hand-specified-ink'}))};
 const edit=overlay({originalText:unicodeByCode.get(target.code)!,text:'卯辰',
  coverRects:[{x:target.coreQuad[0].x-.1,y:target.coreQuad[0].y-2,w:10.2,h:10}]});
 return {content,font,request,overlay:edit};
}
