import {expect,test} from 'bun:test';
import {planSuffixGlue} from './reflowJustify';
import {solveMeasuredReflow,type MeasuredCluster} from './reflowLayout';
import {detectParagraphRegion} from './regionProof';
import {paragraph} from './regionProof.fixtures';

const row={left:0,right:200,baseline:100,kind:'observed-row' as const};
const glyph=(x:number,gap=0):MeasuredCluster=>({unicode:'A',code:Uint8Array.of(65),advance:5,
 ink:{x:0,y:0,w:4,h:7},em:10,wordSpace:false,gap,tjGap:gap>0?true:undefined,original:{line:0,x,y:100}});
const space=(x:number,width=3):MeasuredCluster=>({...glyph(x),unicode:' ',code:Uint8Array.of(32),
 wordSpace:true,advance:width,ink:{x:0,y:0,w:0,h:0}});
const sum=(values:readonly number[])=>values.reduce((n,v)=>n+v,0);

test('no suffix word gap, unproved positioning and locked glue refuse',()=>{
 for(const tokens of [[],[glyph(0)],[glyph(0),glyph(5)],
  [{...glyph(0,3),tjGap:undefined},glyph(8)],[{...glyph(0,3),lockedAfter:true},glyph(8)]])
  expect(planSuffixGlue(tokens,row,.1)).toBeNull();
});
test('gaps at the extraction floor cannot lose their word break',()=>{
 for(const width of [1.9,2,2.01]){
  expect(planSuffixGlue([glyph(0),space(5,width),glyph(5+width)],row,.02)).toBeNull();
  expect(planSuffixGlue([glyph(0,width),glyph(5+width)],row,.02)).toBeNull();
 }
});
test('literal spaces are uniformly tightened before the TJ tier',()=>{
 const tokens=[glyph(0),space(5),glyph(8,3),glyph(16),space(21),glyph(24,3),glyph(32)];
 const first=planSuffixGlue(tokens,row,.6);expect(first).not.toBeNull();if(!first)return;
 expect(first.reductions).toEqual([0,.3,0,0,.3,0,0]);
 const both=planSuffixGlue(tokens,row,1.4);expect(both).not.toBeNull();if(!both)return;
 expect(both.reductions[1]).toBe(.5);expect(both.reductions[4]).toBe(.5);
 expect(both.reductions[2]).toBeCloseTo(.2,12);expect(both.reductions[5]).toBeCloseTo(.2,12);
 expect(Math.abs(sum(both.reductions)-1.4)).toBeLessThanOrEqual(1e-7);
});
test('space width includes its retained positioning gap',()=>{
 const p=planSuffixGlue([glyph(0),{...space(5,1),gap:2},glyph(8)],row,.4);
 expect(p?.reductions).toEqual([0,.4,0]);
 expect(planSuffixGlue([space(5),glyph(8)],{...row,previousInkRight:4},.4)?.reductions).toEqual([.4,0]);
});
test('each typographic cap is enforced, including overhanging ink',()=>{
 for(const [width,em,inkWidth,cap]of [[4,10,4,.5],[.3,1.4,.8,.02],[2.1,10,4,.1],[3,10,7.75,.15]]){
  const left={...glyph(0,width),em:em!,ink:{x:0,y:0,w:inkWidth!,h:7}};
  const tokens=[left,{...glyph(5+width!),em:left.em}];
  expect(planSuffixGlue(tokens,row,cap!/2)).not.toBeNull();
  expect(planSuffixGlue(tokens,row,cap!+.001)).toBeNull();
 }
});
test('2% row budget, sum of caps and uniform per-tier cap are hard limits',()=>{
 expect(planSuffixGlue([glyph(0,3),glyph(8)],{...row,right:13},.26)).not.toBeNull();
 expect(planSuffixGlue([glyph(0,3),glyph(8)],{...row,right:13},.261)).toBeNull();
 expect(planSuffixGlue([glyph(0,3),glyph(8)],row,.51)).toBeNull();
 expect(planSuffixGlue([glyph(0,2.1),glyph(7.1,3),glyph(15.1)],row,.3)).toBeNull();
});
test('an exact-capacity plan tolerates only machine roundoff',()=>{
 const tokens=Array.from({length:6},(_,i)=>glyph(i*8,i===5?0:3));
 expect(planSuffixGlue(tokens,row,20.8-18-.3)).not.toBeNull();
 expect(planSuffixGlue(tokens,row,2.5+1e-8)).toBeNull();
});
test('a code-32 glyph with ink and a two-byte space are not Tw glue',()=>{
 for(const s of [{...space(5),ink:{x:0,y:0,w:.1,h:.1}},
  {...space(5),code:Uint8Array.of(0,32),wordSpace:false},
  {...space(5),code:Uint8Array.of(33)}])
  expect(planSuffixGlue([glyph(0),s,glyph(8)],row,.1)).toBeNull();
 const cid=[glyph(0,3),glyph(8)].map(t=>({...t,code:Uint8Array.of(0,65)}));
 expect(planSuffixGlue(cid,row,.4)?.reductions).toEqual([.4,0]);
});
test('rise, hard breaks, multiple lines and invalid measurements refuse',()=>{
 for(const bad of [{...glyph(8),original:{line:0,x:8,y:101}},
  {...glyph(8),original:{line:1,x:8,y:100}},{...glyph(8),original:undefined},
  {...glyph(8),em:NaN},{...glyph(8),hardAfter:true},{...glyph(8),original:{line:0,x:4,y:100}}])
  expect(planSuffixGlue([glyph(0,3),bad],row,.1)).toBeNull();
 for(const delta of [NaN,Infinity,-1])expect(planSuffixGlue([glyph(0,3),glyph(8)],row,delta)).toBeNull();
});
test('fractional glue has bounded monotone shifts and exactly fixes the last glyph',()=>{
 const tokens=Array.from({length:201},(_,i)=>glyph(i*(5+10/3),i===200?0:10/3));
 const delta=.73123456789,p=planSuffixGlue(tokens,{...row,right:2000},delta);
 expect(p).not.toBeNull();if(!p)return;
 expect(Math.abs(delta-sum(p.reductions))).toBeLessThanOrEqual(1e-7);
 expect(p.shifts[0]).toBe(delta);expect(p.shifts.at(-1)).toBe(0);
 expect(tokens.at(-1)!.original!.x+p.shifts.at(-1)!).toBe(tokens.at(-1)!.original!.x);
 p.shifts.forEach((s,i)=>{expect(s).toBeGreaterThanOrEqual(0);expect(s).toBeLessThanOrEqual(delta);
  if(i)expect(s).toBeLessThanOrEqual(p.shifts[i-1]!);
 });
});
test('solver tightens only a single row at its own end, including rowLocal',()=>{
 const base=detectParagraphRegion(paragraph());if(!base.ok)throw Error(base.detail);
 const source=[glyph(0),glyph(5,3),glyph(13,3),glyph(21)],replacement=[{...glyph(0),advance:5.4}];
 const proof={...base.proof,occupancyHash:'measured',lineSlots:[{...row,right:26}]};
 for(const rowLocal of [undefined,true]as const){
  const p=solveMeasuredReflow({source,replacement,start:0,end:1,proof:{...proof,rowLocal},softBreaks:[],allowSuffix:true,allowWrap:true});
  expect(p).toMatchObject({ok:true,strategy:'row-justify'});if(!p.ok)continue;
  expect(p.origins[1]![0]).toBeCloseTo(5.4,12);expect(p.origins.at(-1)![0]).toBe(21);
  expect(p.clusters.map(t=>t.advance)).toEqual([5.4,5,5,5]);
 }
 const wider=solveMeasuredReflow({source,replacement,start:0,end:1,proof:{...proof,lineSlots:[{...row,right:30}]},softBreaks:[]});
 expect(wider).toMatchObject({ok:true,strategy:'suffix-shift'});
 const multi=solveMeasuredReflow({source:[...source,{...glyph(0),original:{line:1,x:0,y:86}}],replacement,start:0,end:1,
  proof:{...proof,lineSlots:[...proof.lineSlots,{...row,baseline:86,right:26}]},softBreaks:[]});
 expect(multi.ok&&multi.strategy==='row-justify').toBe(false);
 const noGlue=source.map(t=>({...t,tjGap:undefined}));
 expect(solveMeasuredReflow({source:noGlue,replacement,start:0,end:1,proof:{...proof,rowLocal:true},softBreaks:[],allowSuffix:true,allowWrap:true})).toMatchObject({ok:false,code:'overflow'});
});
test('a leading suffix space measures replacement overhang in the shifted suffix frame',()=>{
 const base=detectParagraphRegion(paragraph());if(!base.ok)throw Error(base.detail);
 const source=[{...glyph(0),advance:100,ink:{x:0,y:0,w:102.4,h:7}},space(100),glyph(103)];
 const replacement=[{...glyph(0),advance:100.4,ink:{x:0,y:0,w:102.8,h:7}}];
 const p=solveMeasuredReflow({source,replacement,start:0,end:1,softBreaks:[],
  proof:{...base.proof,occupancyHash:'measured',rowLocal:true,lineSlots:[{...row,right:108}]}});
 expect(p).toMatchObject({ok:true,strategy:'row-justify'});
 if(p.ok){expect(p.origins[1]![0]).toBeCloseTo(100.4,12);expect(p.origins[2]![0]).toBe(103);}
});
