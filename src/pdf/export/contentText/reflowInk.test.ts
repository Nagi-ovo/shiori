import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {type1Fixture} from './type1Wiring.test-support';
import {resolveRunFonts,inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {traceReflowSource} from './reflowTrace';
import {streamInkResolver} from './reflowInk';
import {matrixCff} from './reflowRegion.test-support';
import {widthChar,seacChar} from '../fontCoverage/fixtures/type1';
function measure(f:Awaited<ReturnType<typeof type1Fixture>>,code=65){
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);const fonts=resolveRunFonts(f.page),trace=traceReflowSource(tokenizeContentStream(s.bytes),fonts,s.sourceHash);
 return streamInkResolver(f.page,fonts)('F1',code,[...trace.shows.values()][0]!.before);
}
test('declared PDF FontBBox supplies exact conservative ink without an invented em or advance envelope',async()=>{
 const f=await type1Fixture({brokenProgram:true});const d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 d.set(PDFName.of('FontBBox'),f.doc.context.obj([125,-50,375,650]));
 expect(measure(f)?.box).toEqual({x:1.25,y:-.5,w:2.5,h:7});expect(measure(f)?.conservative).toBe(true);
});
test.each([[undefined],[[10,0,0,700]],[[0,0,NaN,700]]])('missing/invalid declared ink stays unknown: %j',async bbox=>{
 const f=await type1Fixture({brokenProgram:true}),d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 d.delete(PDFName.of('FontBBox'));if(bbox)d.set(PDFName.of('FontBBox'),f.doc.context.obj(bbox));
 expect(measure(f,67)).toBeUndefined();
});
test('Type1 seac with no proved composite hull refuses even with a declared bbox',async()=>{
 const f=await type1Fixture({programOptions:{glyphs:{'.notdef':widthChar(0),A:widthChar(),C:seacChar,acute:widthChar(0)}}});
 expect(measure(f,67)).toBeUndefined();
});
test('Type1C control hull honours its declared nonstandard FontMatrix',async()=>{
 const f=await type1Fixture(),d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 d.delete(PDFName.of('FontFile'));d.delete(PDFName.of('FontBBox'));
 d.set(PDFName.of('FontFile3'),f.doc.context.register(f.doc.context.flateStream(matrixCff(),{Subtype:'Type1C'})));
 const m=measure(f);expect(m?.box).toEqual({x:0,y:0,w:2,h:2});expect(m?.conservative).toBe(false);
});
