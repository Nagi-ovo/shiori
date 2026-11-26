import {PDFDocument,type PDFPage} from 'pdf-lib';
import type {FallbackOptions} from '../contentStreamEdit/fallbackFont';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import {encodeRetypesetClusters,retypesetFontGroups} from './retypesetFontGroups';
import type {retypesetFontSelector} from './retypesetFontSelection';
import type {planRetypeset} from './retypesetPlan';
import type {readRetypesetSource} from './retypesetSource';
import type {RetypesetManifest} from './retypesetTypes';
import type {planRetypesetPush} from './retypesetPush';

type Plan=ReturnType<typeof planRetypeset>;
type Source=ReturnType<typeof readRetypesetSource>;

export async function prepareRetypesetFontFit(page:PDFPage,ops:ContentOp[],source:Source,input:readonly Plan[],
 options:FallbackOptions,select:ReturnType<typeof retypesetFontSelector>,genericPlans:ReadonlySet<number>){
 // Encoding and layout write through shared cluster references. Give each
 // trial its own atoms while retaining identity within that trial's blocks.
 const plans=input.map(plan=>{
  const atoms=new Map(plan.paragraphOutput.map(a=>[a,{...a}]));
  return {...plan,paragraphOutput:plan.paragraphOutput.map(a=>atoms.get(a)!),
   output:plan.output.map(a=>atoms.get(a)!),
   blocks:plan.blocks.map(b=>({...b,output:b.output.map(a=>atoms.get(a)!)}))};
 });
 const scratch=await PDFDocument.create(),fonts=[...source.fonts];
 const groups=retypesetFontGroups(page,ops,scratch,fonts,options,'retypeset','ShioriRt',select);
 const names=[],fitAlternatives=[];
 for(const [i,plan] of plans.entries()){
  const prefix=plan.group.lines.slice(0,plan.firstLine).flatMap(l=>l.glyphs.map(g=>g.text??'')).join('');
  const paragraph=prefix+plan.output.map(a=>a.text).join('');
  names.push(await encodeRetypesetClusters(plan.output,paragraph,fonts,groups,genericPlans.has(i)));
  if(groups.hasFitAlternative)fitAlternatives.push(i);
 }
 return {plans,scratch,fonts,names,prepared:groups.prepared.map(({p})=>p),fitAlternatives};
}

type Candidate=Awaited<ReturnType<typeof prepareRetypesetFontFit>>;

export async function chooseRetypesetFontFit<T extends {identity:()=>string}>(
 prepare:(genericPlans:ReadonlySet<number>)=>Promise<Candidate>,prove:(candidate:Candidate)=>T){
 const generic=new Set<number>(),primary=await prepare(generic);
 const tryGeneric=async()=>{
  try{
   const selected=await prepare(generic);
   return {selected,proved:prove(selected)};
  }catch(error){if(!(error instanceof Error))throw error;}
 };
 let choice:{selected:Candidate;proved:T};
 try{choice={selected:primary,proved:prove(primary)};}catch(error){
  if(!primary.fitAlternatives.length)throw error;
  // If the primary layout cannot be proved, only a fully proved alternate
  // can recover it.
  primary.fitAlternatives.forEach(i=>generic.add(i));
  const alternate=await tryGeneric();
  if(!alternate)throw error;
  return alternate;
 }
 // Each changed paragraph can keep its primary independently. The proof
 // still sees the entire batch, including the ink of other edited paragraphs.
 for(const i of primary.fitAlternatives){
  generic.add(i);
  const alternate=await tryGeneric();
  if(alternate&&alternate.proved.identity()!==choice.proved.identity())choice=alternate;
  else generic.delete(i);
 }
 return choice;
}

/** Widths are allowed to differ within a line. Compare the actual output
 * baseline for every atom and the layout/flow proofs affected by those widths. */
export function retypesetFitIdentity(plans:Plan[],manifests:Omit<RetypesetManifest,'reason'>[],pushes:ReturnType<typeof planRetypesetPush>[]){
 return JSON.stringify(manifests.map((m,i)=>({
  lines:plans[i]!.blocks.map(b=>[b.firstLine,b.lastLine,b.output.map(a=>a.y),b.output.find(a=>a.fit)?.fit]),
  lineCount:m.lineCount,overflowed:m.overflowed,overlap:m.overflowInkOverlap,
  fit:m.fitStrategy,frameFits:m.frameFit?.fits,envelopeStep:m.envelopeFit?.step,
  pushed:m.pushed,pushReason:m.pushReason,delta:m.pushedDeltaPt,
  moved:[...pushes[i]!.glyphDeltas.keys()].sort(),paint:[...pushes[i]!.paintDeltas.keys()].sort((a,b)=>a-b),
 })));
}
