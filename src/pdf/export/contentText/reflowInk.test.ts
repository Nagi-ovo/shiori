import {expect,test} from 'bun:test';
import {PDFDict,PDFName} from 'pdf-lib';
import {type1Fixture} from './type1Wiring.test-support';
import {resolveRunFonts,inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {traceReflowSource} from './reflowTrace';
import {streamInkResolver} from './reflowInk';
import {matrixCff} from './reflowRegion.test-support';
import {widthChar,seacChar} from '../fontCoverage/fixtures/type1';
import {streamReflowEvidence} from './reflowEvidence';
import {substituteInk,inkCovered} from '../contentStreamEdit/substituteInk';
import {substituteSourceFonts} from '../contentStreamEdit/substituteSource';
import {planSubstitution} from '../contentStreamEdit/substitutePlan';
import {overlay} from './fixtures.test-support';
import {readProgram} from '../fontCoverage/program';
import {fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
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

// Failure inventory: substitution must use the same transformed hull as
// reflow even with a declaration; neither placed nor unplaced unknown CFF
// may use an untransformed declaration to clear a neighbouring paragraph.
test.each(['FontFile3','FontFile2'])('proved Type1C in %s supplies substitution ink despite its declared FontBBox',async slot=>{
 const f=await type1Fixture(),d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 d.delete(PDFName.of('FontFile'));d.set(PDFName.of('FontBBox'),f.doc.context.obj([0,0,1000,1000]));
 d.set(PDFName.of(slot),f.doc.context.register(f.doc.context.flateStream(matrixCff(),{Subtype:'Type1C'})));
 expect(measure(f)).toMatchObject({box:{x:0,y:0,w:2,h:2},conservative:false});
 expect(substituteInk(f.page,substituteSourceFonts(f.page))('F1',65)).toEqual({x:0,y:0,w:.2,h:.2});
});
test.each([['placed','glyph'],['unplaced','glyph'],['placed','FD matrix'],['unplaced','FD matrix']])('unproved CFF in FontFile2 cannot grant %s scene clearance (%s)',async(placement,failure)=>{
 const otherShow=placement==='placed'?'200 100 Td (A)':'200 50 Td (D)';
 const f=await type1Fixture({stream:`BT /F1 10 Tf 14 TL 50 100 Td (AB) Tj ET BT /F2 10 Tf ${otherShow} Tj ET`}),ctx=f.doc.context;
 const other=f.font.clone(),d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).clone();
 d.delete(PDFName.of('FontFile'));d.set(PDFName.of('FontBBox'),ctx.obj([0,0,100,100]));
 other.set(PDFName.of('FontDescriptor'),ctx.register(d));f.fonts.set(PDFName.of('F2'),ctx.register(other));
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const target=tokenizeContentStream(s.bytes).findIndex(op=>op.operator==='Tj');
 const evidence=()=>streamReflowEvidence(f.page,s.bytes,substituteSourceFonts(f.page),target);
 const ordinary=evidence();expect(ordinary===null).toBe(false);
 expect(ordinary?.walk.unplacedText).toBe(placement==='unplaced');
 const bytes=failure==='glyph'?matrixCff():fdMatrixCff([2,0,0,2,0,0]);
 if(failure==='glyph')bytes[bytes.length-1]=15;
 d.set(PDFName.of('FontFile2'),ctx.register(ctx.flateStream(bytes)));
 if(failure==='glyph')expect(readProgram(fontInputFromDict(other))).toMatchObject({kind:'fontkit',cff:true});
 else expect(()=>readProgram(fontInputFromDict(other))).toThrow();
 expect(evidence()===null).toBe(true);
});

// A positive declaration can collapse only after the Type3 scale is applied.
// Missing CharProcs prevent an independent outline proof from hiding the bug.
test.each([[0,0], [0,.001], [.001,0]])('Type3 scale %j cannot turn a declaration into empty proved ink',async(sx,sy)=>{
 const f=await type1Fixture(),fonts=resolveRunFonts(f.page),ctx=f.doc.context;
 f.font.set(PDFName.of('Subtype'),PDFName.of('Type3'));
 f.font.delete(PDFName.of('FontDescriptor'));
 f.font.set(PDFName.of('FontBBox'),ctx.obj([0,0,600,700]));
 f.font.set(PDFName.of('FontMatrix'),ctx.obj([sx,0,0,sy,0,0]));
 expect(substituteInk(f.page,fonts)('F1',65)).toBeUndefined();
});

// Failure inventory: point/zero-width/zero-height declarations are unknown;
// proved empty outlines stay empty; unsupported CFF transforms and failed or
// missing glyph hulls cannot fall back to an identity-scaled declaration.
const degenerateBoxes=[[0,0,0,0],[50,0,50,700],[0,40,600,40]].map(b=>[b]);
test.each(degenerateBoxes)('unparsed Type1 with zero-area FontBBox %j cannot prove a reflow region',async bbox=>{
 const f=await type1Fixture({brokenProgram:true,stream:'BT /F1 10 Tf 14 TL 50 100 Td (AB) Tj ET'});
 f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).set(PDFName.of('FontBBox'),f.doc.context.obj(bbox));
 expect(measure(f)).toBeUndefined();
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const target=tokenizeContentStream(s.bytes).findIndex(op=>op.operator==='Tj');
 expect(streamReflowEvidence(f.page,s.bytes,resolveRunFonts(f.page),target)).toBeNull();
});
test.each(degenerateBoxes)('unparsed Type1 with zero-area FontBBox %j cannot authorize substitution cover',async bbox=>{
 const f=await type1Fixture({brokenProgram:true});
 f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).set(PDFName.of('FontBBox'),f.doc.context.obj(bbox));
 const fonts=substituteSourceFonts(f.page),ink=substituteInk(f.page,fonts);
 expect(fonts).toHaveLength(1);expect(ink('F1',65)).toBeUndefined();
 const edit=overlay({originalText:'AB',text:'X',coverRects:[{x:49,y:97,w:14,h:14}]});
 for(const reflow of [false,true])expect(()=>planSubstitution(f.source.bytes,fonts,edit,{},ink,reflow)).toThrow('source ink bounds unproved');
});
test.each(['zero-area','CFF-hull-failure'])('unowned text with %s ink cannot grant clearance to a measured region',async failure=>{
 const f=await type1Fixture({stream:'BT /F1 10 Tf 14 TL 50 100 Td (AB) Tj ET BT /F2 10 Tf 200 100 Td (A) Tj ET'}),ctx=f.doc.context;
 const other=f.font.clone(),d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).clone();
 d.delete(PDFName.of('FontFile'));
 d.set(PDFName.of('FontBBox'),ctx.obj(failure==='zero-area'?[0,0,0,0]:[0,0,100,100]));
 if(failure==='CFF-hull-failure'){
  const bytes=matrixCff();bytes[bytes.length-1]=15;
  d.set(PDFName.of('FontFile3'),ctx.register(ctx.flateStream(bytes,{Subtype:'Type1C'})));
 }
 other.set(PDFName.of('FontDescriptor'),ctx.register(d));f.fonts.set(PDFName.of('F2'),ctx.register(other));
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 expect(streamReflowEvidence(f.page,s.bytes,resolveRunFonts(f.page),tokenizeContentStream(s.bytes).findIndex(op=>op.operator==='Tj'))).toBeNull();
});
test('a degenerate declaration does not erase real outlines or proved empty glyphs',async()=>{
 const painted=await type1Fixture();
 painted.font.lookup(PDFName.of('FontDescriptor'),PDFDict).set(PDFName.of('FontBBox'),painted.doc.context.obj([0,0,0,0]));
 expect(measure(painted)).toMatchObject({box:{x:0,y:0,w:4,h:7},conservative:false});
 const f=await type1Fixture({programOptions:{glyphs:{'.notdef':widthChar(0),A:widthChar(),B:widthChar()}}});
 f.font.lookup(PDFName.of('FontDescriptor'),PDFDict).set(PDFName.of('FontBBox'),f.doc.context.obj([0,0,0,0]));
 expect(measure(f)).toMatchObject({box:{x:0,y:0,w:0,h:0},conservative:false});
 const ink=substituteInk(f.page,substituteSourceFonts(f.page))('F1',65);
 expect(ink).toEqual({x:0,y:0,w:0,h:0});expect(inkCovered(ink!,[])).toBe(true);
});

/** Original CID CFF with one FD and a triangle; fixed-width offsets keep the
 * actual FD-local FontMatrix in the embedded bytes (no fontkit mocks). */
function fdMatrixCff(matrix:number[]){
 const idx=(items:number[][])=>{let n=1;return [0,items.length,1,...items.map(i=>{const v=n;n+=i.length;return v;}),n,...items.flat()];};
 const integer=(n:number)=>[29,n>>>24&255,n>>>16&255,n>>>8&255,n&255];
 const chars=idx([[14],[139,139,21,239,139,5,139,239,5,39,39,5,14]]),name=idx([[84,105,110,121]]);
 const dict=(charset:number,charStrings:number,fdSelect:number,fdArray:number)=>[139,139,139,12,30,...integer(charset),15,...integer(charStrings),17,...integer(fdSelect),12,37,...integer(fdArray),12,36];
 const start=4+name.length+idx([dict(0,0,0,0)]).length+4;
 const fd=(privateOffset:number)=>[...(matrix.length?[...matrix.flatMap(integer),12,7]:[]),139,...integer(privateOffset),18];
 const fdArray=start+3+chars.length+3,privateOffset=fdArray+idx([fd(0)]).length;
 return Uint8Array.from([1,0,4,4,...name,...idx([dict(start,start+3,start+3+chars.length,fdArray)]),0,0,0,0,
  0,0,42,...chars,0,0,0,...idx([fd(privateOffset)])]);
}
test('CID CFF without an FD matrix operator preserves proved ink in both resolvers',async()=>{
 const f=await type1Fixture({stream:'BT /F1 10 Tf 14 TL 50 100 Td <002a> Tj ET'}),ctx=f.doc.context;
 const d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 d.delete(PDFName.of('FontFile'));d.set(PDFName.of('FontBBox'),ctx.obj([0,0,1000,1000]));
 d.set(PDFName.of('FontFile3'),ctx.register(ctx.flateStream(fdMatrixCff([]),{Subtype:'CIDFontType0C'})));
 const child=ctx.register(ctx.obj({Type:'Font',Subtype:'CIDFontType0',BaseFont:'Tiny',DW:600,FontDescriptor:f.font.get(PDFName.of('FontDescriptor')),
  CIDSystemInfo:{Registry:'Adobe',Ordering:'Identity',Supplement:0}}));
 f.font.set(PDFName.of('Subtype'),PDFName.of('Type0'));f.font.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));
 f.font.set(PDFName.of('DescendantFonts'),ctx.obj([child]));f.font.delete(PDFName.of('FontDescriptor'));
 f.font.set(PDFName.of('ToUnicode'),ctx.register(ctx.flateStream('1 beginbfchar <002a> <0041> endbfchar')));
 expect(measure(f,42)).toMatchObject({box:{x:0,y:0,w:1,h:1},conservative:false});
 expect(substituteInk(f.page,substituteSourceFonts(f.page))('F1',42)).toEqual({x:0,y:0,w:.1,h:.1});
});
test.each([[[2,0,0,2,0,0]],[[1,1,0,1,0,0]]])('CID FD FontMatrix %j cannot retain an identity FontBBox',async matrix=>{
 const f=await type1Fixture({stream:'BT /F1 10 Tf 14 TL 50 100 Td <002a> Tj ET'}),ctx=f.doc.context;
 const d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict);
 d.delete(PDFName.of('FontFile'));d.set(PDFName.of('FontBBox'),ctx.obj([0,0,100,100]));
 d.set(PDFName.of('FontFile3'),ctx.register(ctx.flateStream(fdMatrixCff(matrix),{Subtype:'CIDFontType0C'})));
 const child=ctx.register(ctx.obj({Type:'Font',Subtype:'CIDFontType0',BaseFont:'Tiny',DW:600,FontDescriptor:f.font.get(PDFName.of('FontDescriptor')),
  CIDSystemInfo:{Registry:'Adobe',Ordering:'Identity',Supplement:0}}));
 f.font.set(PDFName.of('Subtype'),PDFName.of('Type0'));f.font.set(PDFName.of('Encoding'),PDFName.of('Identity-H'));
 f.font.set(PDFName.of('DescendantFonts'),ctx.obj([child]));f.font.delete(PDFName.of('FontDescriptor'));
 f.font.set(PDFName.of('ToUnicode'),ctx.register(ctx.flateStream('1 beginbfchar <002a> <0041> endbfchar')));
 // The same CID program without the unsupported FD operator is readable.
 expect(readProgram({...fontInputFromDict(f.font),program:fdMatrixCff([])})).toMatchObject({kind:'fontkit',cff:true,cid:true});
 const fonts=substituteSourceFonts(f.page);expect(fonts).toHaveLength(1);
 expect(substituteInk(f.page,fonts)('F1',42)).toBeUndefined();
 expect(measure(f,42)).toBeUndefined();
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 expect(streamReflowEvidence(f.page,s.bytes,resolveRunFonts(f.page),tokenizeContentStream(s.bytes).findIndex(op=>op.operator==='Tj'))).toBeNull();
});
test.each(['missing-gid','broken-hull'])('CFF %s cannot retain an untransformed declared envelope',async failure=>{
 const f=await type1Fixture(),d=f.font.lookup(PDFName.of('FontDescriptor'),PDFDict),bytes=matrixCff();
 if(failure==='broken-hull')bytes[bytes.length-1]=15; // CFF2-only vsindex in a CFF1 glyph.
 d.delete(PDFName.of('FontFile'));d.set(PDFName.of('FontBBox'),f.doc.context.obj([0,0,100,100]));
 d.set(PDFName.of('FontFile3'),f.doc.context.register(f.doc.context.flateStream(bytes,{Subtype:'Type1C'})));
 const program=readProgram(fontInputFromDict(f.font));if(program.kind!=='fontkit')throw Error('expected CFF program');
 expect(program.simpleGid(65,'A')).toBe(1);expect(program.presence(1,'A')).toBeUndefined();
 expect(substituteInk(f.page,substituteSourceFonts(f.page))('F1',failure==='missing-gid'?67:65)).toBeUndefined();
 expect(measure(f,failure==='missing-gid'?67:65)).toBeUndefined();
});
