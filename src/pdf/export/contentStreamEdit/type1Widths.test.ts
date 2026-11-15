import {expect,test} from 'bun:test';
import {PDFDocument,PDFName} from 'pdf-lib';
import {contentFontInfo} from './glyphWidths';
import {resolveRunFonts} from './replaceRunPage';
import {createSourceFontEncoder} from './sourceFontEncoder';
import {fontCoverageFromDict} from '../fontCoverage/pdfLibAdapter';
import {assertType1Source,surgicalType1Encoder} from '../fontCoverage/type1Surgical';
import {type1Fixture} from '../contentText/type1Wiring.test-support';
import {walkTextPlacements} from './textState';
import {tokenizeContentStream} from './tokenizer';
import {tinyType1} from '../fontCoverage/fixtures/type1';
test('AFM metrics opt in retains explicit PDF widths and excludes subsets/embedded faces',async()=>{
  const ctx=(await PDFDocument.create()).context;
  const resolve=(extra={},options={standard14Afm:true})=>contentFontInfo(ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica',...extra}),options);
  const afm=resolve();expect(afm).toMatchObject({ok:true,verification:'assumed-standard'});if(afm.ok)expect(afm.widthOf(65)).toBe(667);
  const explicit=resolve({FirstChar:65,Widths:[700]});if(!explicit.ok)throw Error(explicit.reason);expect(explicit.widthOf(65)).toBe(700);
  expect(resolve({BaseFont:'ABCDEF+Helvetica'}).ok).toBe(false);
  expect(resolve({},{}).ok).toBe(false);
  const f=tinyType1();expect(resolve({FontDescriptor:ctx.obj({FontFile:ctx.register(ctx.flateStream(f.program,{Length1:f.length1,Length2:f.length2,Length3:f.length3}))})}).ok).toBe(false);
});
test('Type1 enabled widths compare character space, refuse absent PDF metrics/custom matrix',async()=>{
  const ctx=(await PDFDocument.create()).context,f=tinyType1();
  const resolve=(widths: number[]|undefined,extra={})=>contentFontInfo(ctx.obj({Subtype:'Type1',BaseFont:'Tiny',FirstChar:65,...(widths?{Widths:widths}:{}),ToUnicode:ctx.register(ctx.flateStream('1 beginbfchar <41> <0041> endbfchar')),FontDescriptor:ctx.obj({FontFile:ctx.register(ctx.flateStream(f.program,{Length1:f.length1,Length2:f.length2,Length3:f.length3}))}),...extra}),{sourceReuse:true});
  for(const width of [600,601]){const result=resolve([width]);expect(result.ok).toBe(true);if(result.ok)expect(result.widthOf(65)).toBe(width);}
  expect(resolve([602])).toMatchObject({ok:false,reason:expect.stringContaining('font-metrics-conflict')});
  expect(resolve(undefined)).toMatchObject({ok:false,reason:expect.stringContaining('font-metrics-missing')});
  expect(resolve([600],{FontMatrix:[1,0,0,1,0,0]})).toMatchObject({ok:false,reason:expect.stringContaining('unsupported-matrix')});
});
for(const options of [{},{sourceReuse:true}])test(`MMType1 retains placement widths but refuses source reuse: ${JSON.stringify(options)}`,async()=>{
  const f=await type1Fixture({stream:'BT /F1 10 Tf 50 100 Td (AB) Tj /Target 10 Tf (A) Tj ET'});
  const ctx=f.doc.context;
  f.font.set(PDFName.of('Subtype'),PDFName.of('MMType1'));
  f.fonts.set(PDFName.of('Target'),ctx.register(ctx.obj({Subtype:'Type1',BaseFont:'Courier',FirstChar:65,Widths:[600]})));
  const info=contentFontInfo(f.font,options);
  expect(info.ok).toBe(true);if(!info.ok)throw Error(info.reason);
  expect(info.widthOf(65)).toBe(600);
  const fonts=resolveRunFonts(f.page,options),mm=fonts.find(font=>font.resourceName==='F1');
  expect(mm?.widthOf(66)).toBe(600);
  const walk=walkTextPlacements(tokenizeContentStream(f.source.bytes),{resolveFont:name=>{
    const font=fonts.find(font=>font.resourceName===name);return font?{...font,ok:true,appliesWordSpacing:true}:null;
  }});
  expect(walk.ok).toBe(true);if(!walk.ok)throw Error(walk.reason);
  expect(walk.glyphs.at(-1)?.coreQuad[0].x).toBe(62);
  const coverage=fontCoverageFromDict(f.font,options);
  expect(coverage.canEncode('A')).toMatchObject({ok:false,code:'type1-ps-unsupported'});
  expect(()=>assertType1Source(coverage,[Uint8Array.of(65)])).toThrow('type1-ps-unsupported');
  expect(()=>surgicalType1Encoder(coverage)('A')).toThrow('type1-ps-unsupported');
  expect(createSourceFontEncoder(f.font)).toBeNull();
});
