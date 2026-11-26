import {beforeAll,expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import {PDFArray,PDFDict,PDFDocument,PDFHexString,PDFName,PDFNumber,PDFRawStream,PDFRef,PDFString} from 'pdf-lib';
import {loadExportFonts} from '../exportFonts';
import {tinyTtf} from '../fontCoverage/fixtures/programs';
import {runResourceStamp} from './resourceStamp';

let bytes:Uint8Array;
beforeAll(async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage();
 const program=doc.context.register(doc.context.flateStream(tinyTtf(),{Length1:tinyTtf().length}));
 const descriptor=doc.context.register(doc.context.obj({Type:'FontDescriptor',FontName:'Tiny',Flags:32,
  FontBBox:[0,-200,1000,800],Ascent:800,Descent:-200,FontFile2:program}));
 const font=doc.context.register(doc.context.obj({Type:'Font',Subtype:'TrueType',BaseFont:'Tiny',
  FirstChar:65,LastChar:66,Widths:[500,500],FontDescriptor:descriptor,
  Encoding:{Type:'Encoding',BaseEncoding:'WinAnsiEncoding',Differences:[65,'A','B']},
  ToUnicode:doc.context.register(doc.context.stream('2 beginbfchar <41> <0041> <42> <0042> endbfchar'))}));
 page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:font},Properties:{Tag:doc.context.register(doc.context.obj({MCID:0,ActualText:PDFString.of('AB')}))}}));
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream('BT /F1 12 Tf (AB) Tj ET')));
 bytes=await doc.save();
});
async function fixture(){
 const doc=await PDFDocument.load(bytes),page=doc.getPage(0),resources=page.node.Resources()!;
 const fonts=resources.lookup(PDFName.of('Font'),PDFDict),font=fonts.lookup(PDFName.of('F1'),PDFDict);
 const descriptor=font.lookup(PDFName.of('FontDescriptor'),PDFDict),encoding=font.lookup(PDFName.of('Encoding'),PDFDict);
 const program=descriptor.lookup(PDFName.of('FontFile2'),PDFRawStream),unicode=font.lookup(PDFName.of('ToUnicode'),PDFRawStream);
 const properties=resources.lookup(PDFName.of('Properties'),PDFDict),marked=properties.lookup(PDFName.of('Tag'),PDFDict);
 return {doc,page,resources,fonts,font,descriptor,encoding,program,unicode,properties,marked};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
test('identical page bytes loaded twice have the same resource revision',async()=>{
 expect(runResourceStamp((await fixture()).page)).toBe(runResourceStamp((await fixture()).page));
});
for(const cjk of [false,true])test(`export font allocation preserves a copied embedded font revision${cjk?' with CJK':''}`,async()=>{
 const source=await PDFDocument.create();source.registerFontkit(fontkit);
 const ownFont=await source.embedFont(await readFile('node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf'),{subset:true});
 source.addPage().drawText('ABC',{font:ownFont});
 const direct=await PDFDocument.load(await source.save()),out=await PDFDocument.create();
 const fonts=await loadExportFonts(out,cjk?[{type:'text',id:'cjk',pageId:'page',rect:{x:0,y:0,w:100,h:20},
  text:'漢字',fontSize:12,color:'#000000',bold:false,align:'left',fontFamily:'notoSansSc'}]:[],
  'flatten',cjk?{unicodeFontBytes:await readFile('src/assets/fonts/NotoSansSC-Regular.otf')}:{});
 if(cjk)expect(fonts.unicodePathFont).not.toBeNull();
 const [copied]=await out.copyPages(direct,[0]);out.addPage(copied!);
 const stamp=runResourceStamp(direct.getPage(0));
 expect(runResourceStamp(copied!)).toBe(stamp);
 expect(runResourceStamp((await PDFDocument.load(await out.save())).getPage(0))).toBe(stamp);
});
test('dictionary entry order does not change a resource revision',async()=>{
 const f=await fixture(),stamp=runResourceStamp(f.page);
 for(const dict of [f.resources,f.fonts,f.font,f.descriptor,f.encoding,f.program.dict,f.unicode.dict,f.properties,f.marked]){
  const entries=dict.entries().reverse();for(const [key]of entries)dict.delete(key);
  for(const [key,value]of entries)dict.set(key,value);
 }
 expect(runResourceStamp(f.page)).toBe(stamp);
});
test('direct, indirect and shared equal values have the same revision',async()=>{
 const f=await fixture();f.fonts.set(PDFName.of('F2'),f.fonts.get(PDFName.of('F1'))!);
 const stamp=runResourceStamp(f.page);
 f.fonts.set(PDFName.of('F1'),f.font.clone());
 f.font.set(PDFName.of('Widths'),f.doc.context.register(f.font.lookup(PDFName.of('Widths'),PDFArray)));
 f.marked.set(PDFName.of('ActualText'),PDFHexString.of('4142'));
 expect(runResourceStamp(f.page)).toBe(stamp);
});
const changes:[string,(f:Fixture)=>void][]=[
 ['font program bytes',f=>{f.program.getContents()[0]!^=1;}],
 ['ToUnicode bytes',f=>{f.unicode.getContents()[0]!^=1;}],
 ['stream Filter',f=>f.program.dict.set(PDFName.of('Filter'),PDFName.of('ASCIIHexDecode'))],
 ['stream DecodeParms',f=>f.program.dict.set(PDFName.of('DecodeParms'),f.doc.context.obj({Predictor:12,Columns:4}))],
 ['stream Length1',f=>f.program.dict.set(PDFName.of('Length1'),PDFNumber.of(42))],
 ['BaseFont',f=>f.font.set(PDFName.of('BaseFont'),PDFName.of('Changed'))],
 ['widths',f=>f.font.lookup(PDFName.of('Widths'),PDFArray).set(0,PDFNumber.of(501))],
 ['FirstChar',f=>f.font.set(PDFName.of('FirstChar'),PDFNumber.of(64))],
 ['LastChar',f=>f.font.set(PDFName.of('LastChar'),PDFNumber.of(67))],
 ['Encoding',f=>f.encoding.set(PDFName.of('BaseEncoding'),PDFName.of('MacRomanEncoding'))],
 ['Differences',f=>f.encoding.lookup(PDFName.of('Differences'),PDFArray).set(1,PDFName.of('C'))],
 ['flags',f=>f.descriptor.set(PDFName.of('Flags'),PDFNumber.of(33))],
 ['FontBBox',f=>f.descriptor.lookup(PDFName.of('FontBBox'),PDFArray).set(2,PDFNumber.of(999))],
 ['metrics',f=>f.descriptor.set(PDFName.of('Ascent'),PDFNumber.of(801))],
 ['Properties value',f=>f.marked.set(PDFName.of('MCID'),PDFNumber.of(1))],
 ['Properties text',f=>f.marked.set(PDFName.of('ActualText'),PDFString.of('AC'))],
];
for(const [name,change]of changes)test(`${name} changes the resource revision`,async()=>{
 const f=await fixture(),stamp=runResourceStamp(f.page);change(f);
 expect(runResourceStamp(f.page)).not.toBe(stamp);
});
for(const scope of ['Font','Properties'])for(const action of ['add','remove','rename'])test(`${action} a ${scope} resource changes its revision`,async()=>{
 const f=await fixture(),dict=scope==='Font'?f.fonts:f.properties,key=PDFName.of(scope==='Font'?'F1':'Tag');
 const stamp=runResourceStamp(f.page),value=dict.get(key)!;
 if(action!=='remove')dict.set(PDFName.of('Alias'),value);
 if(action!=='add')dict.delete(key);
 expect(runResourceStamp(f.page)).not.toBe(stamp);
});
test('unrelated page resources and unreachable document objects do not change the revision',async()=>{
 const f=await fixture(),stamp=runResourceStamp(f.page);
 f.doc.context.register(f.doc.context.obj({Type:'Font',BaseFont:'Unused'}));
 f.resources.set(PDFName.of('XObject'),f.doc.context.obj({Image:f.doc.context.register(f.doc.context.stream('pixels'))}));
 f.resources.set(PDFName.of('ExtGState'),f.doc.context.obj({GS1:{CA:0.5}}));
 expect(runResourceStamp(f.page)).toBe(stamp);
});
test('cyclic dependencies survive renumbering and still observe content changes',async()=>{
 const f=await fixture();f.marked.set(PDFName.of('Parent'),f.properties);
 const stamp=runResourceStamp(f.page),out=await PDFDocument.create();await loadExportFonts(out,[],'flatten',{});
 const [copied]=await out.copyPages(f.doc,[0]);
 expect(runResourceStamp(copied!)).toBe(stamp);
 f.marked.set(PDFName.of('MCID'),PDFNumber.of(1));expect(runResourceStamp(f.page)).not.toBe(stamp);
});
test('reference-only cycles terminate independently of object numbers',async()=>{
 const f=await fixture(),a=f.doc.context.nextRef(),b=f.doc.context.nextRef();
 f.doc.context.assign(a,b);f.doc.context.assign(b,a);f.fonts.set(PDFName.of('Cycle'),a);
 const stamp=runResourceStamp(f.page),c=PDFRef.of(b.objectNumber+10),d=PDFRef.of(b.objectNumber+11);
 f.doc.context.assign(c,d);f.doc.context.assign(d,c);f.fonts.set(PDFName.of('Cycle'),c);
 expect(runResourceStamp(f.page)).toBe(stamp);
});
