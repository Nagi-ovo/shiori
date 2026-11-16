import {expect,test} from 'bun:test';
import {type1RegionPage} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {streamReflowEvidence} from './reflowEvidence';
import {planStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {overlay} from './fixtures.test-support';

const row=(text:string,y:number,x=50,leading=0)=>`BT /F1 10 Tf ${leading} TL ${x} ${y} Td (${text}) Tj ET `;
async function fixture(stream:string,target=0){
 const f=await type1RegionPage(stream),s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),op=tokenizeContentStream(s.bytes).flatMap((o,i)=>o.operator==='Tj'?[i]:[])[target]!;
 const e=streamReflowEvidence(f.page,s.bytes,fonts,op);
 return {...f,s,fonts,e,plan:(y=150,text='AB AB AB')=>planStreamReflow(f.page,s.bytes,fonts,
  overlay({originalText:'A',text,coverRects:[{x:49.95,y:y-.5,w:6.1,h:8}]}))};
}
for(const rows of [['AB AB AB ','AB AB ','AB '],['AB AB ','AB AB AB ']])test(`ragged group wraps within its maximum observed extent: ${rows.length} rows`,async()=>{
 const f=await fixture(rows.map((s,i)=>row(s,150-14*i)).join('')),p=f.plan();
 expect(f.e.ok).toBe(true);expect(p?.reflow?.layout.strategy).toBe('wrap');
 if(!p?.reflow)throw Error('missing ragged wrap');
 expect(p.reflow.proof.lineSlots.every(s=>s.right===95)).toBe(true);
 expect(p.reflow.layout.origins.every((o,i)=>o[0]+Math.max(p.reflow!.clusters[i]!.advance,p.reflow!.clusters[i]!.ink.x+p.reflow!.clusters[i]!.ink.w)<=95)).toBe(true);
 expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
test('a longest prefix line grants capacity but stays outside the moved tail',async()=>{
 const f=await fixture(row('AB AB AB ',150)+row('AB AB ',136)+row('AB ',122),1),p=f.plan(136,'AB AB');
 if(!p?.reflow)throw Error('missing ragged tail');
 expect(p.reflow.proof.lineSlots.map(s=>s.baseline)).toEqual([136,122]);
 expect(p.reflow.proof.lineSlots.every(s=>s.right===95)).toBe(true);
 expect(p.reflow.clusters.every(t=>!t.original||t.original.y<=136)).toBe(true);
 expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
test('paragraph spacing in one BT keeps the second paragraph out of the first capacity',async()=>{
 const stream='BT /F1 10 Tf 0 TL 50 150 Td (AB AB ) Tj 0 -14 Td (AB ) Tj 0 -28 Td (AB AB AB AB ) Tj 0 -14 Td (AB ) Tj ET';
 const f=await fixture(stream);if(!f.e.ok)throw Error(f.e.detail);
 expect(f.e.proof.lineSlots.map(s=>s.baseline)).toEqual([150,136]);
 expect(f.e.proof.lineSlots.every(s=>s.right===80)).toBe(true);
});
test('ragged capacity never borrows the column gutter',async()=>{
 const f=await fixture(row('AB AB AB ',150)+row('AB ',136)+'/Artifact BMC '+row('AB AB AB ',150,130)+' EMC');
 if(!f.e.ok)throw Error(f.e.detail);
 expect(f.e.proof.lineSlots.every(s=>s.right===95)).toBe(true);
 expect(f.plan(150,'ABABABABABAB')).toBeNull();
});
test('interleaved columns refuse instead of selecting a convenient short window',async()=>{
 const f=await fixture(row('AB AB AB ',150)+row('AB AB AB ',150,130)+row('AB ',136)+row('AB ',136,130));
 expect(f.e).toMatchObject({ok:false,blocker:'boundary'});expect(f.plan()).toBeNull();
});
test('observed pitch grows below the group end without TL',async()=>{
 const f=await fixture(row('AB AB AB ',150)+row('AB AB ',136)),p=f.plan();
 expect(p?.reflow?.layout.strategy).toBe('wrap');
 expect(p?.reflow?.proof.lineSlots.map(s=>s.baseline)).toEqual([150,136,122]);
 if(!p)throw Error('missing observed-pitch growth');expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
test('a one-line group cannot infer pitch or borrow another group extent',async()=>{
 const f=await fixture(row('AB ',150)+'/Artifact BMC '+row('AB AB AB ',122)+' EMC');
 if(!f.e.ok)throw Error(f.e.detail);
 expect(f.e.proof.lineSlots).toEqual([{left:50,right:65,baseline:150,kind:'observed'}]);
 expect(f.plan()).toBeNull();
});
for(const variant of ['translated','unwrapped','in-bt','partial-bt','scale','shear','rotate'] as const)test(`whole-BT cm safety: ${variant}`,async()=>{
 const rows=['AB AB AB ','AB AB ','AB '];
 const stream=rows.map((s,i)=>{
  const cm=variant==='scale'?'2 0 0 1 0 0':variant==='shear'?'1 0 .1 1 0 0':variant==='rotate'?'0 1 -1 0 0 0':`1 0 0 1 ${i*3} ${i*2}`;
  const body=row(s,150-16*i,50-i*3,14);
  if(variant==='unwrapped')return body+(i===0?'1 0 0 1 3 2 cm ':'');
  if(variant==='in-bt')return body.replace(' Td ',` Td ${cm} cm `);
  if(variant==='partial-bt')return body.replace('BT ','BT q ').replace(' ET ',` ET ${cm} cm Q `);
  return `q ${cm} cm ${body}Q `;
 }).join('');
 const f=await fixture(stream),p=f.plan();
 if(variant!=='translated'){expect(p).toBeNull();return;}
 expect(p?.reflow?.layout.strategy).toBe('wrap');if(!p)throw Error('missing translated wrap');
 expect(compileReflowPlan(f.s.bytes,f.fonts,p).ok).toBe(true);
});
