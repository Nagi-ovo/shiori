import {expect,test} from 'bun:test';
import {solveMeasuredReflow,type MeasuredCluster} from './reflowLayout';
import {detectParagraphRegion} from './regionProof';
import {paragraph} from './regionProof.fixtures';

const token=(unicode:string,advance=10,line=0,x=50):MeasuredCluster=>({
 unicode,advance,ink:{x:1,y:-2,w:advance-2,h:10},em:10,
 original:{line,x,y:700-line*14},gap:0,wordSpace:false,
 fullEmHan:advance===10,
});
function solve(source:MeasuredCluster[],replacement:MeasuredCluster[],start=0,end=1,lefts=[50,50,50]){
 const result=detectParagraphRegion(paragraph(lefts));if(!result.ok)throw Error(result.detail);
 return solveMeasuredReflow({source,replacement,start,end,proof:result.proof,softBreaks:[0,1]});
}
test('spacing absorbs a small overflow and leaves every source follower fixed',()=>{
 const source=[token('A',10),token('Z',10,0,60)];
 const result=solve(source,[token('B',5.02),token('C',5.02)]);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.strategy).toBe('spacing-only');
 expect(result.origins[0]).toEqual([50,700]);
 expect(result.origins[1]![0]).toBeCloseTo(54.98);
 expect(result.origins[2]).toEqual([60,700]);
});
test('suffix shift uses exactly the overflow remaining after maximum safe spacing',()=>{
 const result=solve([token('A'),token('Z',10,0,60)],[token('B',6),token('C',6)]);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.strategy).toBe('suffix-shift');
 expect(result.origins[2]![0]).toBeCloseTo(61.9);
});
test('wrap carries the owned tail onto an existing slot, without moving the prefix',()=>{
 const source=Array.from('甲乙丙丁戊己庚辛壬癸').map((s,i)=>token(s,10,0,50+i*10));
 source.push(token('子',10,1,50));
 const result=solve(source,[token('丑'),token('寅')],8,9);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.strategy).toBe('wrap');
 expect(result.origins.slice(0,8)).toEqual(source.slice(0,8).map(t=>[t.original!.x,700]));
 expect(result.origins[10]).toEqual([50,686]);
});
test('full paragraph refuses instead of inventing a baseline',()=>{
 const source=Array.from({length:30},(_,i)=>token('甲',10,Math.floor(i/10),50+i%10*10));
 expect(solve(source,[token('乙'),token('丙')],0,1)).toMatchObject({ok:false,code:'overflow'});
});
test.each([[[74,50,50]],[[30,50,50]]])('first and hanging indent use each slot left: %j',lefts=>{
 const length=Math.floor((150-lefts[0]!)/10);
 const source=Array.from({length},(_,i)=>token('甲',10,0,lefts[0]!+i*10));
 source.push(token('子',10,1,50));
 const result=solve(source,[token('乙'),token('丙')],length-1,length,lefts);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.origins[0]).toEqual([lefts[0],700]);
 expect(result.strategy).toBe('wrap');
 expect(result.origins.find(p=>p[1]===686)![0]).toBe(50);
});
test('does not tighten without conservative ink clearance',()=>{
 const replacement=[token('A',5.02),token('B',5.02)].map(t=>({...t,ink:{x:0,y:-2,w:5.02,h:10}}));
 const result=solve([token('A'),token('Z',10,0,60)],replacement);
 expect(result.ok).toBe(true);if(result.ok)expect(result.strategy).toBe('suffix-shift');
});
test('Latin words cannot be split at arbitrary characters or NBSP',()=>{
 const replacement=Array.from('indivisible\u00a0word').map(s=>token(s,10));
 expect(solve([token('A')],replacement)).toMatchObject({ok:false,code:'reflow-required'});
});
test('a required hard break cannot be softened by the greedy breaker',()=>{
 const source=[token('甲',10),{...token('乙',10,1,50),hardAfter:true},token('丙',10,2,50)];
 const result=solve(source,[token('丁'),token('戊')]);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.origins.at(-1)![1]).toBe(672);
});
test('spacing budgets include the 2% aggregate cap and literal one-byte word spaces',()=>{
 const source=[token('A',100)];
 const replacement=Array.from({length:100},()=>({...token('A',1.04),ink:{x:.1,y:-2,w:.1,h:10}}));
 const result=solve(source,replacement);
 expect(result).toMatchObject({ok:false,code:'reflow-required'});
});
test('replacement ink may not overlap a neighbouring row inside the overall box',()=>{
 const replacement=[{...token('C',10.04),ink:{x:1,y:-10,w:8,h:18}}];
 expect(solve([token('A'),token('B',10,1,50)],replacement)).toMatchObject({ok:false,code:'overflow'});
});
test('Tw is allocated first, and only for a proven one-byte literal space',()=>{
 const replacement=[token('A',4),{...token(' ',2.5),ink:{x:0,y:0,w:0,h:0},wordSpace:true},token('B',4)];
 const result=solve([token('A',10.4)],replacement);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.strategy).toBe('spacing-only');expect(result.tc).toBe(0);expect(result.tw).toBeCloseTo(.1);
 replacement[1]!.wordSpace=false;
 const cid=solve([token('A',10.4)],replacement);expect(cid.ok).toBe(true);
 if(cid.ok)expect(cid.strategy).toBe('suffix-shift');
});
