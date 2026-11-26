import type {PDFPage} from 'pdf-lib';
import type {ContentOp} from '../contentStreamEdit/tokenizer';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {codes} from '../contentStreamEdit/runEncoding';
import type {planRetypeset} from './retypesetPlan';
import {address,type readRetypesetSource} from './retypesetSource';
import {layoutRetypeset,retypesetClusterState} from './retypesetLayout';
import {detectRetypesetFrame} from './retypesetFrame';
import {retypesetInk} from './retypesetInk';
import {reflowScene} from './reflowScene';
import {contains,intersects} from './regionProof/geometry';
import type {RetypesetAdjustment,RetypesetManifest} from './retypesetTypes';

export const RETYPESET_FRAME_SIZE_FLOOR=.85;
/** Only geometrically bounded text gets a spacing/size search. Every candidate
 * is measured with its emitted state; fit requires all ink inside the frame
 * and clear of every other glyph/graphic. The frame itself stays stationary. */
export function prepareRetypesetFits(page:PDFPage,measurePage:PDFPage,ops:ContentOp[],fonts:ResolvedRunFont[],source:ReturnType<typeof readRetypesetSource>,plans:ReturnType<typeof planRetypeset>[],target:ReadonlySet<string>){
 const ink=retypesetInk(measurePage,fonts,ops);
 const sourceInk=new Map(source.glyphs.map(g=>[address(g.glyph),ink(fonts.find(f=>f.resourceName===g.glyph.fontName)!,g.glyph.code,g.state,g.x,g.y)]));
 const measure=(p:typeof plans[number])=>new Map(p.output.filter(a=>!a.hard).map(a=>{
  const pt=p.frame.global(a.x!,a.y!),code=codes(a.bytes!,a.font!.bytesPerCode)[0]!;
  return [a,ink(a.font!,code,retypesetClusterState(a),pt.x,pt.y)] as const;
 }));
 const m=page.getMediaBox(),scene:{box:ReturnType<typeof ink>['box'];op:number}[]=[];
 reflowScene(page,ops,{x:m.x,y:m.y,w:m.width,h:m.height},(box,kind,op)=>{if(kind!=='backdrop')scene.push({box,op});},.01);
 const stationary=source.glyphs.filter(g=>!target.has(address(g.glyph))).map(g=>sourceInk.get(address(g.glyph))!);
 const results=plans.map(p=>{
  let fit=layoutRetypeset(p),outputInk=measure(p);
  const frame=detectRetypesetFrame(page,ops,p);
  let frameFit:RetypesetManifest['frameFit'];
  if(frame){
   const clear=()=>[...outputInk.values()].every(o=>o.known&&contains(frame.box,o.box)&&
    !stationary.some(s=>intersects(s.box,o.box))&&!scene.some(s=>!frame.paintOps.has(s.op)&&intersects(s.box,o.box)));
   if(!clear()){
    // A font envelope can overhang its advance. Reserve that overhang at the
    // frame edge rather than fitting advances and leaking actual output ink.
    const overhang=Math.max(0,...[...outputInk].map(([a,o])=>o.box.x+o.box.w-p.frame.global(a.x!+a.advance!,a.y!).x));
    const left=Math.max(p.group.left,p.frame.local(frame.box.x,0).x),right=p.frame.local(frame.box.x+frame.box.w-overhang,0).x;
    const attempts:RetypesetAdjustment[]=[.01,.02,.03].map(trackingEm=>({sizeScale:1,trackingEm,wordReductionEm:trackingEm}));
    for(let percent=99;percent>=Math.round(RETYPESET_FRAME_SIZE_FLOOR*100);percent--)attempts.push({sizeScale:percent/100,trackingEm:.03,wordReductionEm:.03});
    for(const adjustment of attempts){
     try{fit=layoutRetypeset(p,adjustment,{left,right});outputInk=measure(p);}catch{continue;}
     const fits=clear();frameFit={frame:frame.box,kind:frame.kind,...adjustment,floor:RETYPESET_FRAME_SIZE_FLOOR,fits};
     if(fits)break;
    }
    // A failed measurement must not leave half-mutated candidate positions.
    if(!frameFit){fit=layoutRetypeset(p);outputInk=measure(p);}
   }
  }
  return {fit,outputInk,frame,frameFit};
 });
 return {sourceInk,results};
}

