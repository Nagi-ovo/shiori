import {expect,test} from 'bun:test';
import {PDFName} from 'pdf-lib';
import {type1RegionPage} from './reflowRegion.test-support';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {reflowScene} from './reflowScene';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {streamReflowEvidence} from './reflowEvidence';

async function boxes(path:string,parameters='2 w',matrix='1 0 0 1 0 0',lw?:number|string){
 const f=await type1RegionPage();
 if(lw!==undefined)f.page.node.Resources()!.set(PDFName.of('ExtGState'),f.doc.context.obj({Stroke:{LW:lw}}));
 return reflowScene(f.page,tokenizeContentStream(new TextEncoder().encode(`q ${matrix} cm ${parameters} ${path} Q`)),{x:0,y:0,w:300,h:200},undefined,0);
}
for(const cap of [0,1,2])for(const dash of ['', '[3 2] 1 d'])test(`joinless rule stays tight for cap ${cap}, dash ${dash}`,async()=>{
 const [b]=await boxes('50 150 m 150 150 l S',`2 w 10 M ${cap} J ${dash}`),r=Math.SQRT2;
 expect(b?.x).toBeCloseTo(50-r);expect(b?.y).toBeCloseTo(150-r);
 expect(b?.w).toBeCloseTo(100+2*r);expect(b?.h).toBeCloseTo(2*r);
});
test('a non-conformal CTM uses a Frobenius bound for the whole joinless stroke',async()=>{
 const [b]=await boxes('10 10 m 30 10 l S','2 w 0 J','2 1 3 4 0 0'),r=Math.sqrt(30);
 expect(b?.x).toBeCloseTo(50-r);expect(b?.y).toBeCloseTo(50-r);
 expect(b?.w).toBeCloseTo(40+2*r);expect(b?.h).toBeCloseTo(20+2*r);
});
test('a square cap under anisotropic scaling cannot use the smaller Frobenius disk',async()=>{
 const [b]=await boxes('1 50 m 2 51 l S','.1 w 2 J','100 0 0 1 0 0');
 // At 45 degrees in user space the cap extends sqrt(2)*w/2 along x.
 // After scaling x by 100 it needs 7.071 pt, not ||M||F*w/2 = 5.000 pt.
 expect(b!.x).toBeLessThanOrEqual(100-5*Math.SQRT2);
});
for(const path of ['50 150 100 1 re S','50 150 m 150 150 l h S','50 150 m 150 150 l s','50 150 m 150 150 l 160 150 l S','50 150 m 150 150 l 60 150 m S','50 150 m 70 150 90 150 150 150 c S','50 150 m 90 150 150 150 v S','50 150 m 90 150 150 150 y S'])test(`non-joinless stroke keeps its miter envelope: ${path}`,async()=>{
 const [b]=await boxes(path);expect(b?.y).toBeCloseTo(150-20*Math.SQRT2);
});
for(const parameters of ['-1 w','/Unknown w','/Missing gs','4 J'])test(`unknown stroke parameters keep the clip: ${parameters}`,async()=>{
 expect(await boxes('50 150 m 150 150 l S',parameters)).toEqual([{x:0,y:0,w:300,h:200}]);
});
test('an unknown ExtGState cap keeps the conservative clip',async()=>{
 const f=await type1RegionPage();
 f.page.node.Resources()!.set(PDFName.of('ExtGState'),f.doc.context.obj({Stroke:{LW:2,LC:PDFName.of('Unknown')}}));
 const ops=tokenizeContentStream(new TextEncoder().encode('/Stroke gs 50 150 m 150 150 l S'));
 expect(reflowScene(f.page,ops,{x:0,y:0,w:300,h:200},undefined,0)).toEqual([{x:0,y:0,w:300,h:200}]);
});
test('unknown ExtGState LW keeps the clip while a proved LW bounds the rule',async()=>{
 expect(await boxes('50 150 m 150 150 l S','/Stroke gs',undefined,'Unknown')).toEqual([{x:0,y:0,w:300,h:200}]);
 expect((await boxes('50 150 m 150 150 l S','/Stroke gs',undefined,2))[0]?.h).toBeCloseTo(2*Math.SQRT2);
});
test('a hairline retains the conservative half-point envelope',async()=>{
 expect((await boxes('50 150 m 150 150 l S','0 w'))[0]?.h).toBe(1);
});
test('an open title rule no longer swallows the neighbouring title row',async()=>{
 const f=await type1RegionPage('1 w 10 M 40 150 m 150 150 l S BT /F1 10 Tf 14 TL 50 138 Td (AB AB) Tj ET');
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const op=tokenizeContentStream(s.bytes).findIndex(o=>o.operator==='Tj'),e=streamReflowEvidence(f.page,s.bytes,resolveRunFonts(f.page),op);
 expect(e.ok).toBe(true);if(!e.ok)throw Error(e.detail);
 expect(e.proof.lineSlots[0]?.right).toBe(77);
 expect(e.occupancy.items.find(o=>o.kind==='paint')?.box.h).toBeCloseTo(Math.SQRT2+2);
});
