import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {mkdir,writeFile} from 'node:fs/promises';
import {tinyType1,nums,widthChar} from '../fontCoverage/fixtures/type1';
import {fixture,overlay,bytes} from './fixtures.test-support';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {encodeRun} from '../contentStreamEdit/runEncoding';
import {address,readRetypesetSource} from './retypesetSource';
import {planRetypeset,selectRetypeset} from './retypesetPlan';
import {prepareRetypesetFits} from './retypesetFit';
import {planRetypesetPush} from './retypesetPush';
import {tryRetypesetTail} from './retypesetTail';
import {writeRetypeset} from './retypesetWrite';
import {intersects} from './regionProof/geometry';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';

// Failure cases are listed in STATUS.md before these tests and their fixes.
// Use real source codes, layout, ink, and push planning; no policy mocks.
const full='AAAA BBBB CCCC DDDD',grow=full+' ZZZZ',twice=full+' ZZZZ YYYY XXXX WWWW';
async function scenario(options:{rows?:string[];edits?:[number,string][];extra?:string;unicode?:[string,string][]}={}){
 const rows=options.rows??[...Array<string>(7).fill(full),'EEEE'];
 const f=await fixture(`BT /F1 10 Tf 14 TL 50 170 Td ${rows.map((s,i)=>`${i?'T* ':''}(${s}) Tj`).join(' ')} ET ${options.extra??''}`);
 if(options.unicode?.length){
  const fonts=f.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict),font=fonts.lookup(PDFName.of('F1'),PDFDict);
  const entries=Array.from({length:95},(_,i)=>{const code=i+32,c=String.fromCharCode(code);return [code,options.unicode!.find(([a])=>a===c)?.[1]??c] as const;});
  const cmap=entries.length+' beginbfchar '+entries.map(([code,c])=>`<${code.toString(16)}> <${c.charCodeAt(0).toString(16).padStart(4,'0')}>`).join(' ')+' endbfchar';
  font.set(PDFName.of('ToUnicode'),f.doc.context.register(f.doc.context.stream(bytes(cmap))));
  const names=entries.map(([code,c])=>[code,`uni${c.charCodeAt(0).toString(16).padStart(4,'0').toUpperCase()}`] as const);
  const outline=Uint8Array.from([...nums(0,600),13,...nums(100,0),21,...nums(400,0),5,...nums(0,700),5,...nums(-400,0),5,9,14]);
  const program=tinyType1({glyphs:{'.notdef':widthChar(0),...Object.fromEntries(names.map(([code,name])=>[name,code===32?widthChar(600):outline]))}});
  font.set(PDFName.of('BaseFont'),PDFName.of('Tiny'));
  font.set(PDFName.of('Encoding'),f.doc.context.obj({Differences:names.flatMap(([code,name])=>[code,PDFName.of(name)])}));
  font.set(PDFName.of('FontDescriptor'),f.doc.context.obj({Type:'FontDescriptor',FontName:'Tiny',Flags:4,FontBBox:[0,-200,600,800],
   Ascent:800,Descent:-200,CapHeight:700,ItalicAngle:0,StemV:80,FontFile:f.doc.context.register(f.doc.context.flateStream(program.program,{Length1:program.length1,Length2:program.length2,Length3:program.length3}))}));
 }
 const ops=tokenizeContentStream(f.source),source=readRetypesetSource(f.page,ops);
 const edits=(options.edits??[[0,grow]]).map(([line,text])=>{
  const selected=source.glyphs.filter(g=>g.y===170-line*14);
  const edit=overlay({originalText:selected.map(g=>g.text).join(''),text,coverRects:[{x:49,y:169-line*14,w:116,h:12}]});
  return {overlay:edit,selected:selectRetypeset(source.glyphs,edit),reason:'overflow' as const};
 });
 const plan=planRetypeset(source.glyphs,ops,edits);
 expect(plan.group.lines).toHaveLength(rows.length);
 for(const a of plan.output){
  if(a.hard)continue;
  const font=source.fonts.find(f=>f.resourceName===a.home.glyph.fontName)!;
  a.font=font;
  if(!a.bytes){const encoded=encodeRun(a.text,font,new Uint8Array());if(!encoded.ok)throw Error(encoded.reason);a.bytes=encoded.bytes;}
 }
 const target=new Set(plan.tail.map(g=>address(g.glyph)));
 const {sourceInk,results:[result]}=prepareRetypesetFits(f.page,f.page,ops,source.fonts,source,[plan],target);
 const fit=result!.fit;
 const inks=result!.outputInk;
 const internal=plan.blocks.some((b,i)=>plan.blocks.slice(i+1).some(c=>b.output.some(a=>inks.has(a)&&c.output.some(d=>inks.has(d)&&intersects(inks.get(a)!.box,inks.get(d)!.box)))));
 const push=planRetypesetPush(f.page,ops,source,plan,fit,target,[...inks.values()],sourceInk,undefined,[],internal);
 const attempt=()=>tryRetypesetTail(f.page,ops,source,plan,fit,push,sourceInk);
 const write=(allow=true)=>writeRetypeset(f.page,f.source,ops,source,[plan],{},undefined,allow);
 return {...f,ops,source,plan,fit,push,attempt,write};
}
function content(f:Awaited<ReturnType<typeof scenario>>){
 const inspected=inspectRunPage(f.page);if(!inspected.ok)throw Error(inspected.reason);
 return inspected.bytes;
}

test('partial tail slack cannot move the lowest baseline below the paragraph',async()=>{
 // N=8, p=14, line 0 grows by 2p, tail absorbs only p. The original
 // bottom (142) is above the last source line (72); candidate bottom is 58.
 const options={edits:[[0,twice]] as [number,string][],extra:'45 45 150 1 re f'};
 const f=await scenario(options),baseline=await scenario(options),before=await f.doc.save();
 expect(f.fit.addedHeight).toBe(28);
 expect(Math.min(...f.plan.output.filter(a=>!a.hard).map(a=>a.y!))).toBe(142);
 expect(f.push).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(Boolean(f.attempt())).toBe(false);
 const [actual]=await f.write(),[original]=await baseline.write(false);
 expect(actual).toEqual(original);
 expect(content(f)).toEqual(content(baseline));
 const dir='test-artifacts/r32-p2c/partial-slack';await mkdir(dir,{recursive:true});
 const command='bun test src/pdf/export/contentText/retypesetTailPolicy.test.ts';
 await writeFile(`${dir}/before.pdf`,before);await writeFile(`${dir}/after.pdf`,await f.doc.save());
 await writeFile(`${dir}/report.json`,JSON.stringify({command,originalAddedHeightPt:28,originalLowestBaselinePt:142,
  paragraphLastBaselinePt:72,tailAccepted:false,original,actual,unchangedStream:true},null,2));
 await writeFile(`${dir}/README.md`,`Regenerate the saved-byte regression: ${command}\n`);
});

test('tail retry never introduces a push that the original blocked plan lacked',async()=>{
 // A 28pt move is blocked at y=35; after partial absorption a 14pt move
 // would succeed. Tail reflow must not start moving that follower.
 const f=await scenario({edits:[[0,twice]],extra:'BT /F1 10 Tf 50 55 Td (EE) Tj ET 45 35 150 1 re f'});
 expect(f.push).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(Boolean(f.attempt())).toBe(false);
});

test('already-clear rows skip tail reflow',async()=>{
 const f=await scenario();
 const {sourceInk}=prepareRetypesetFits(f.page,f.page,f.ops,f.source.fonts,f.source,[f.plan],new Set(f.plan.tail.map(g=>address(g.glyph))));
 // The previous decision is an input to this policy. Exercise the clear-row
 // state explicitly; no planning function or candidate measurement is mocked.
 const clear={...f.push,pushed:false,overflowInkOverlap:false};
 expect(Boolean(tryRetypesetTail(f.page,f.ops,f.source,f.plan,f.fit,clear,sourceInk))).toBe(false);
});

test('a full zero-height tail win can remove an existing push',async()=>{
 const f=await scenario();
 expect(f.push).toMatchObject({pushed:true,pushedDeltaPt:14});
 const accepted=f.attempt();
 expect(accepted).toBeDefined();
 expect(accepted!.fit.addedHeight).toBe(0);
 expect(accepted!.push).toMatchObject({pushed:false,overflowInkOverlap:false,pushedDeltaPt:0});
});

test('a still-needed push keeps its exact delta and moved glyph set',async()=>{
 const f=await scenario({edits:[[0,twice]]}),baseline=await scenario({edits:[[0,twice]]});
 expect(f.push).toMatchObject({pushed:true,pushedDeltaPt:28});
 const moved=[...f.push.glyphDeltas];
 expect(Boolean(f.attempt())).toBe(false);
 const [actual]=await f.write(),[original]=await baseline.write(false);
 expect(actual).toEqual(original);
 expect(content(f)).toEqual(content(baseline));
 expect([...f.push.glyphDeltas]).toEqual(moved);
});

test('same-baseline collisions between changed blocks refuse tail ownership',async()=>{
 const f=await scenario({edits:[[0,twice+' VVVV UUUU TTTT SSSS'],[2,grow]]});
 expect(f.plan.blocks).toHaveLength(2);
 expect(f.plan.blocks[0]!.output.some(a=>a.y===142)).toBe(true);
 expect(f.plan.blocks[1]!.output.some(a=>a.y===142)).toBe(true);
 const candidate=f.attempt();
 if(candidate){
  // Characterize the buggy candidate itself before checking its refusal:
  // both changed blocks really do paint at x=50, y=142.
  expect(candidate.plan.blocks[0]!.output.some(a=>a.x===50&&a.y===142)).toBe(true);
  expect(candidate.plan.blocks[1]!.output.some(a=>a.x===50&&a.y===142)).toBe(true);
 }
 expect(Boolean(candidate)).toBe(false);
});

for(const [left,right,unicode] of [
 ['CCCCc','DDDD',[['c','か']]],
 ['CCCCc','DDDD',[['c','カ']]],
 ...['。','、','，','」','）'].map(p=>['CCCCc','DDDD',[['c',p]]]),
 ['CCCC','cDDDD',[['c','漢']]],
 ['CCCC','cDDDD',[['c','カ']]],
 ['CCCC','cDDDD',[['c','。']]],
 ['trans-','form',[]],
] as [string,string,[string,string][]][])test(`untouched tail break ${left}/${right} ${JSON.stringify(unicode)} keeps text without an ASCII join`,async()=>{
 const rows=[full,full,full,full,left,right,'EEEE','FFFF'];
 const f=await scenario({rows,unicode}),accepted=f.attempt();
 expect(accepted).toBeDefined();
 const actual=accepted!.plan.output.filter(a=>a.home.y===114||a.home.y===100).map(a=>a.text).join('');
 const decode=(s:string)=>Array.from(s,c=>unicode.find(([code])=>c===code)?.[1]??c).join('');
 // The join before line 4 is legitimate Latin spacing. The untouched break
 // inside this pair must preserve its exact text, including the hyphen.
 expect(actual).toBe(' '+decode(left)+decode(right));
});

test('ordinary Latin tail breaks still separate words',async()=>{
 const f=await scenario({rows:[full,full,full,full,'trans','form','EEEE','FFFF']}),accepted=f.attempt();
 expect(accepted).toBeDefined();
 expect(accepted!.plan.output.filter(a=>a.home.y===114||a.home.y===100).map(a=>a.text).join('')).toBe(' trans form');
});

for(const [source,replacement,joined] of [
 [full+'-',full+' extra',full+' extra form'],
 [full,full+' new-',full+' new-form'],
 [full,full+' new ',full+' new form'],
] as const)test(`edited last-line ending ${JSON.stringify(source)} → ${JSON.stringify(replacement)} controls its tail join`,async()=>{
 const rows=[source,'form',full,full,full,full,'EEEE','FFFF'];
 const f=await scenario({rows,edits:[[0,replacement]]});
 expect(f.plan.blocks.at(-1)!.lastLine).toBe(0);
 expect(f.fit.addedHeight).toBeGreaterThan(0);
 const accepted=f.attempt();
 expect(accepted).toBeDefined();
 expect(accepted!.plan.output.map(a=>a.text).join('')).toBe([joined,...rows.slice(2)].join(' '));
});

test('a known inset graphic blocks rewriting a short tail through its ink',async()=>{
 const f=await scenario({rows:[...Array<string>(5).fill(full),'EEEE','FFFF','GGGG'],extra:'95 98 100 7 re f'});
 expect(f.push).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(Boolean(f.attempt())).toBe(false);
});


test('known stationary caption ink blocks an overlapping tail retry',async()=>{
 const f=await scenario({rows:[...Array<string>(5).fill(full),'EEEE','FFFF','GGGG'],extra:'BT /F1 9 Tf 95 100 Td (FIGURE CAPTION LONG) Tj ET'});
 expect(f.push).toMatchObject({pushed:false,overflowInkOverlap:true});
 expect(Boolean(f.attempt())).toBe(false);
});


test('actual source spaces at CJK and hyphen breaks are retained',async()=>{
 for(const [left,unicode] of [['trans- ',[]],['CCCCc ',[['c','カ']]]] as [string,[string,string][]][]){
  const f=await scenario({rows:[full,full,full,full,left,'DDDD','EEEE','FFFF'],unicode}),accepted=f.attempt();
  expect(accepted).toBeDefined();
  expect(accepted!.plan.output.filter(a=>a.home.y===114||a.home.y===100).map(a=>a.text).join('')).toBe(' '+left.replace('c','カ')+'DDDD');
 }
});
