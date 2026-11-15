import {expect,test} from 'bun:test';
import {readEditedPageText} from './editedPageText';
import {withFakePdfEngine,fakePdfDocument} from '../../test/fakePdfEngine';
import {fixture,overlay,model} from '../../pdf/export/contentText/fixtures.test-support';
import {PDFDocument} from 'pdf-lib';
import {inspectRunPage} from '../../pdf/export/contentStreamEdit/replaceRunPage';
const original=fakePdfDocument(),derived=fakePdfDocument();let loadedText='';
const pageText=(str:string)=>({content:{items:[{str,dir:'ltr' as const,transform:[1,0,0,10,50,100],width:30,height:10,fontName:'f',hasEOL:false}],styles:{f:{fontFamily:'sans-serif',ascent:.8,descent:-.2,vertical:false}},lang:null},glyphs:null,fontNames:new Map(),faceFamilies:new Map()});
withFakePdfEngine({load:async bytes=>{const pdf=await PDFDocument.load(bytes),content=inspectRunPage(pdf.getPage(0));loadedText=content.ok?new TextDecoder().decode(content.bytes):'';return{doc:derived,bytes};},pageText:async doc=>pageText(doc===derived?'AXCDE':'ABCDE'),destroy:async()=>{}});
test('selection/copy/find readers obtain edited PDFium text rather than the original source',async()=>{
 const{doc}=await fixture();const source=await doc.save();const result=await readEditedPageText(original,model([]).pages[0]!,source,[overlay()]);
 expect(result.content.items[0]).toMatchObject({str:'AXCDE'});expect(loadedText).toContain('58');
});
