import {expect,test} from 'bun:test';
import {detectParagraphRegion,type ParagraphInput,type TextTrace} from './regionProof';
import {paragraph} from './regionProof.fixtures';
import {shortStreamRegionResult} from './reflowShortRegion';

const artifact=JSON.stringify([['BDC','Artifact']]),span=JSON.stringify([['BDC','Span']]);
function inputFor(count:number,perGlyph:boolean):ParagraphInput{
 const input=paragraph(Array(count).fill(50),Array.from({length:count},(_,i)=>i===count-1?115:150));
 for(const line of input.lines){
  Object.assign(line.anchor,{scopeSafe:false,scopeKey:artifact});
  for(const s of line.shows)for(const t of [s.before,s.after])Object.assign(t,{scopeSafe:true,scopeKey:span});
 }
 if(perGlyph)input.occupancy={items:[],grid:new Map(),pageBlocked:false,hash:'scene',guardPt:0,glyphs:new Map(),embeddedFonts:new Set()};
 return input;
}
const detect=(input:ParagraphInput)=>input.lines.length>=3?detectParagraphRegion(input):shortStreamRegionResult(input);

for(const perGlyph of [false,true])for(const count of [1,2,3]){
 test(`${count}-line region accepts Artifact positioning with safe Span shows: occupancy=${perGlyph}`,()=>{
  const input=inputFor(count,perGlyph),result=detect(input);
  expect(result.ok).toBe(true);if(!result.ok)throw Error(result.detail);
  expect(result.proof.owned).toEqual(input.lines.flatMap(l=>l.shows.map(s=>s.source)));
  expect(result.proof.lineSlots.map(s=>s.baseline)).toEqual(input.lines.map(l=>l.anchor.tm[5]!));
 });
}
for(const perGlyph of [false,true])for(const count of [1,3]){
 test(`${count}-line region accepts an Artifact continuation after an unmarked anchor: occupancy=${perGlyph}`,()=>{
  const input=inputFor(count,perGlyph),line=input.lines[0]!,continuation=line.anchor;
  input.ops.splice(continuation.opIndex,0,structuredClone(input.ops[continuation.opIndex]!));
  for(const l of input.lines){
   l.anchor.opIndex++;
   for(const s of l.shows){s.source.opIndex++;s.before.opIndex++;s.after.opIndex++;}
  }
  line.anchor={...continuation,opIndex:continuation.opIndex-1,scopeSafe:true,scopeKey:'[]'};
  line.continuations=[continuation];
  expect(detect(input).ok).toBe(true);
 });
 for(const snapshot of ['before','after'] as const)for(const row of new Set([0,count-1])){
  test(`${count}-line region rejects an unsafe ${snapshot} show on row ${row}: occupancy=${perGlyph}`,()=>{
   const input=inputFor(count,perGlyph);
   input.lines[row]!.shows[0]![snapshot].scopeSafe=false;
   expect(detect(input)).toMatchObject({ok:false,blocker:'state'});
  });
 }
 test(`${count}-line region cannot mix two safe show scopes on one line: occupancy=${perGlyph}`,()=>{
  const input=inputFor(count,perGlyph),line=input.lines[0]!,show=line.shows[0]!,next=structuredClone(show);
  input.ops[show.source.opIndex]!.operator='TJ';
  input.ops[show.source.opIndex]!.operands=[{kind:'array',items:[{kind:'string',bytes:new Uint8Array(1)},{kind:'string',bytes:new Uint8Array(2)}]}];
  show.source.itemIndex=0;show.source.byteEnd=1;show.unicode='a';show.after.tm=[1,0,0,1,100,700];
  next.source.itemIndex=1;next.source.byteEnd=2;next.unicode='bc';next.before.tm=show.after.tm;
  next.before.scopeKey=next.after.scopeKey=JSON.stringify([['BDC','P']]);line.shows.push(next);
  expect(detect(input)).toMatchObject({ok:false,blocker:'state'});
 });
}
for(const perGlyph of [false,true])test(`paragraph shows retain scope membership across lines: occupancy=${perGlyph}`,()=>{
 const input=inputFor(3,perGlyph);
 for(const s of input.lines[1]!.shows)for(const t of [s.before,s.after])t.scopeKey=JSON.stringify([['BDC','P']]);
 expect(detect(input)).toMatchObject({ok:false,blocker:'state'});
});
const invalidAnchors:readonly [string,Partial<TextTrace>][]=[
 ['size',{size:0}],['font',{fontObject:''}],['Tr',{renderMode:1}],['nonfinite rise',{rise:NaN}],
 ['shear',{tm:[1,.2,0,1,50,700]}],['frame',{ctm:[2,0,0,1,0,0]}],
 ['safetyHash',{safetyHash:'different'}],['tz',{tz:90}],
];
for(const count of [1,3])test.each(invalidAnchors)(`${count}-line region still rejects invalid Artifact anchor %s`,(_name,patch)=>{
 const input=inputFor(count,true);Object.assign(input.lines[0]!.anchor,patch);
 expect(detect(input)).toMatchObject({ok:false,blocker:'state'});
});
