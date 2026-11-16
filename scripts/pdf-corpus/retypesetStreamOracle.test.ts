import {expect,test} from 'bun:test';
import {PDFDict,PDFDocument,PDFName,PDFRawStream} from 'pdf-lib';
import {fixture} from '../../src/pdf/export/contentText/fixtures.test-support';
import {assertRetypesetStreamIdentity,retypesetSourceOwnership} from './retypesetStreamOracle';

// Failure list: native Unicode alone misses code remaps and invisible spaces;
// stream evidence must preserve both, as well as source font identity and quad.
const owned=[{origin:[50,100]}];
const source='BT /F1 10 Tf 50 100 Td (A) Tj ET BT /F1 10 Tf 200 150 Td (Z ) Tj ET';
test('saved stream codes and fonts remain identical outside the addressed paragraph',async()=>{
 const before=await fixture(source),after=await fixture(source.replace('(A)','(X)'));
 expect(assertRetypesetStreamIdentity(before.page,after.page,owned)).toBe(2);
 const changed=await fixture(source.replace('(A)','(X)').replace('(Z )','(z )'));
 const font=changed.page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).lookup(PDFName.of('F1'),PDFDict);
 font.set(PDFName.of('ToUnicode'),changed.doc.context.register(changed.doc.context.stream('1 beginbfrange <20> <7e> <0020> endbfrange 1 beginbfchar <7a> <005a> endbfchar')));
 expect(()=>assertRetypesetStreamIdentity(before.page,changed.page,owned)).toThrow('codes/font/position');
});
test('untargeted invisible spaces and other text objects cannot disappear',async()=>{
 const before=await fixture(source);
 for(const stream of [source.replace('(Z )','(Z)'),source.replace('(Z )','()'),source.replace('200 150','200.02 150')]){
  const after=await fixture(stream);
  expect(()=>assertRetypesetStreamIdentity(before.page,after.page,owned)).toThrow('codes/font/position');
 }
});

test('source ownership keeps earlier lines and separately scoped text inside paragraph bounds untargeted',async()=>{
 const f=await fixture('BT /F1 10 Tf 14 TL 50 150 Td (ABCDE) Tj 0 -14 Td (ABCDE) Tj ET q BT /F1 10 Tf 60 143 Td (Z) Tj ET Q');
 const native=Array.from('ABCDE', (text,i)=>({text,origin:[50+i*6,136]}));
 const ownership=retypesetSourceOwnership(f.page,native,{originalText:'ABCDE',text:'longer words',coverRects:[{x:49,y:135,w:32,h:2}]});
 expect(ownership.map(g=>g.origin)).toEqual(native.map(g=>g.origin));
 const changed=await fixture('BT /F1 10 Tf 14 TL 50 150 Td (ABCDE) Tj 0 -14 Td (longer words) Tj ET q BT /F1 10 Tf 60 143 Td (X) Tj ET Q');
 expect(()=>assertRetypesetStreamIdentity(f.page,changed.page,ownership)).toThrow('codes/font/position');
});

test('an unrelated object sharing a target origin keeps its own glyph identity',async()=>{
 const source='BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET q BT /F1 10 Tf 50 100 Td (Z) Tj ET Q';
 const before=await fixture(source),after=await fixture(source.replace('(ABCDE)','(new words)').replace('(Z)','(X)'));
 const native=Array.from('ABCDE',(text,i)=>({text,origin:[50+i*6,100]}));
 const ownership=retypesetSourceOwnership(before.page,native,{originalText:'ABCDE',text:'new words',coverRects:[{x:49,y:99,w:32,h:2}]});
 expect(()=>assertRetypesetStreamIdentity(before.page,after.page,ownership)).toThrow('codes/font/position');
});

// Form audit failure list: stream-local op addresses collide across repeated
// uses; untargeted form codes/spaces/font/positions and page text must all be
// audited, and paragraph ownership must map through the Do transform.
test('form-local ownership and saved-stream identity include repeated uses and page text',async()=>{
 const make=async(body:string)=>{
  const f=await fixture('/Fm Do q 1 0 0 1 0 -70 cm /Fm Do Q BT /F1 10 Tf 20 180 Td (PAGE) Tj ET');
  const form=f.doc.context.register(f.doc.context.stream(new TextEncoder().encode(body),{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:f.page.node.Resources()!.clone()}));
  f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Fm:form}));return f;
 };
 const before=await make('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 200 150 Td (Z ) Tj ET');
 const native=Array.from('ABCDE',(text,i)=>({text,origin:[50+i*6,100]}));
 const ownership=retypesetSourceOwnership(before.page,native,{originalText:'ABCDE',text:'longer words',coverRects:[{x:49,y:98,w:32,h:13}]});
 expect(ownership).toHaveLength(5);
 expect(assertRetypesetStreamIdentity(before.page,before.page,ownership)).toBe(13);
 const changed=await make('BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET BT /F1 10 Tf 200 150 Td (Z) Tj ET');
 expect(()=>assertRetypesetStreamIdentity(before.page,changed.page,ownership)).toThrow('codes/font/position');
});

// Compare-before failures: remapped refs and shifted Do addresses are harmless;
// new defects, extra occurrences and rewrites of defective Forms are not.
async function defectiveForms(body='q Q',box=[0,0,0,200],uses=5,padding=0){
 const f=await fixture(`${source} ${Array.from({length:uses},(_,i)=>`/Bad${i%5} Do`).join(' ')}`);
 for(let i=0;i<padding;i++)f.doc.context.register(f.doc.context.obj({Padding:i}));
 const objects=f.doc.context.obj({});
 for(let i=0;i<5;i++)objects.set(PDFName.of(`Bad${i}`),f.doc.context.register(f.doc.context.flateStream(`${body}\n% form ${i}`,{Type:'XObject',Subtype:'Form',BBox:box})));
 f.page.node.Resources()!.set(PDFName.of('XObject'),objects);
 return PDFDocument.load(await f.doc.save({useObjectStreams:false}));
}
test('unchanged invalid Forms survive remapped refs beside page text',async()=>{
 const before=await defectiveForms(),after=await defectiveForms('q Q',[0,0,0,200],5,20);
 expect(before.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict).get(PDFName.of('Bad0'))?.toString())
  .not.toBe(after.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'),PDFDict).get(PDFName.of('Bad0'))?.toString());
 expect(assertRetypesetStreamIdentity(before.getPage(0),after.getPage(0),owned)).toBe(2);
});
test('new defects and extra or rewritten defective Forms fail closed',async()=>{
 const before=await defectiveForms();
 for(const after of [await defectiveForms('q 1 0 0 1 1 0 cm Q'),await defectiveForms('q Q',[0,0,-1,200]),await defectiveForms('q Q',[0,0,0,200],6)])
  expect(()=>assertRetypesetStreamIdentity(before.getPage(0),after.getPage(0),owned)).toThrow(/form.walk|Form|stream glyph walk/);
 const valid=await defectiveForms('q Q',[0,0,300,200]);
 expect(()=>assertRetypesetStreamIdentity(valid.getPage(0),before.getPage(0),owned)).toThrow(/form.walk|Form|stream glyph walk/);
});
test('a rewritten text Form with a newly invalid BBox fails',async()=>{
 const f=await fixture('/Fm Do'),resources=f.page.node.Resources()!.clone();
 const raw=f.doc.context.stream('BT /F1 10 Tf 50 100 Td (A) Tj ET',{Type:'XObject',Subtype:'Form',BBox:[0,0,300,200],Resources:resources});
 f.page.node.Resources()!.set(PDFName.of('XObject'),f.doc.context.obj({Fm:f.doc.context.register(raw)}));
 const before=await PDFDocument.load(await f.doc.save());
 const changed=f.doc.context.stream('BT /F1 10 Tf 50 100 Td (X) Tj ET',{Type:'XObject',Subtype:'Form',BBox:[0,0,0,200],Resources:resources});
 f.page.node.Resources()!.lookup(PDFName.of('XObject'),PDFDict).set(PDFName.of('Fm'),f.doc.context.register(changed));
 expect(changed).toBeInstanceOf(PDFRawStream);
 expect(()=>assertRetypesetStreamIdentity(before.getPage(0),f.page,owned)).toThrow(/form.walk|Form|stream glyph walk/);
});
