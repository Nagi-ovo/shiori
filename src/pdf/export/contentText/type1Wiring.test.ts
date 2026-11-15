import {expect,test} from 'bun:test';
import {PDFDocument,PDFName} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {exportPdf} from '../exportPdf';
import {fontCoverageFromDict} from '../fontCoverage/pdfLibAdapter';
import {stage5Type1} from '../fontCoverage/type1Support';
import {inspectRunPage,replaceRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {compileRunPageWithFallback,replaceRunPageWithFallback} from '../contentStreamEdit/fallbackPage';
import {replaceRuns} from '../contentStreamEdit/replaceRun';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {applyContentTextEdits} from './apply';
import {model,overlay} from './fixtures.test-support';
import {type1Fixture} from './type1Wiring.test-support';

const enabled={sourceReuse:true};
const optIn={stage5Type1:enabled};
const loadFont=async(name:string)=>new Uint8Array(await readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`));
function contents(page:Parameters<typeof inspectRunPage>[0]) {
  const source=inspectRunPage(page);if(!source.ok)throw Error(source.reason);return source.bytes;
}
test('omitted Type1 options reuse verified source codes; explicit off retains legacy refusal',async()=>{
  const {page}=await type1Fixture();
  const font=resolveRunFonts(page)[0]!;
  expect(font.canEncode!('B')).toMatchObject({ok:true});
  expect(font.canEncode!('')).toMatchObject({ok:true});
  expect(resolveRunFonts(page,{sourceReuse:false})[0]!.canEncode!('B')).toMatchObject({ok:false});
  const f=await type1Fixture();
  expect(replaceRunPage(f.page,f.plan(''),{sourceReuse:false})).toMatchObject({ok:false});
  expect(replaceRunPage(f.page,f.plan(''))).toMatchObject({ok:true});
  expect(stage5Type1).toEqual({sourceReuse:true,standard14Afm:false});
});
for(const type1Options of [{},optIn])for(const mode of ['flatten','annotations'] as const)test(`export default/opt-in reuses a good Type1 code despite an unrelated bad glyph (${mode})`,async()=>{
  const f=await type1Fixture({stream:'BT /F1 10 Tf 50 100 Td (AA) Tj ET',widths:[600,600,602]});
  expect(fontCoverageFromDict(f.font,enabled).verification).toBe('unverified');
  let loads=0;
  const result=await exportPdf(await f.doc.save(),model([overlay({originalText:'AA',text:'BA'})]),
    {mode,...type1Options,inPlaceFallback:{loadFont:async name=>{loads++;return loadFont(name);}}});
  expect(result.contentTextOutcomes).toEqual([{overlayId:'edit',mode:'in-place'}]);
  expect(loads).toBe(0);
  const out=await PDFDocument.load(result.bytes),source=contents(out.getPage(0));
  expect(tokenizeContentStream(source).filter(op=>op.operator==='BT')).toHaveLength(1);
  expect(new TextDecoder().decode(source)).toContain('<42>');
  expect(new TextDecoder().decode(source)).toContain('<41>');
});
for(const boundary of [compileRunPageWithFallback,replaceRunPageWithFallback]) {
  for(const replacement of ['','BA','C'])test(`${boundary.name}: conflicting addressed source refuses ${JSON.stringify(replacement)} without fallback`,async()=>{
    // The second addressed code conflicts, so validating only the first is insufficient.
    const f=await type1Fixture({differences:[65,'A','A']});
    const fonts=resolveRunFonts(f.page,enabled);
    expect(fonts[0]!.unicodeByCode.get(66)).toBe('B');
    let loads=0;
    const before=contents(f.page),count=f.doc.context.enumerateIndirectObjects().length;
    const result=await boundary(f.page,f.plan(replacement),{...optIn,loadFont:async name=>{loads++;return loadFont(name);}});
    expect(result).toMatchObject({ok:false,terminal:true,reason:expect.stringContaining('glyph-identity-conflict')});
    expect(loads).toBe(0);
    expect(contents(f.page)).toEqual(before);
    expect(f.doc.context.enumerateIndirectObjects()).toHaveLength(count);
  });
}
test('replacement identity conflict is terminal even with a good addressed source',async()=>{
  const f=await type1Fixture({differences:[67,'A']});let loads=0;
  const result=await replaceRunPageWithFallback(f.page,f.plan('C'),{...optIn,loadFont:async name=>{loads++;return loadFont(name);}});
  expect(result).toMatchObject({ok:false,terminal:true,reason:expect.stringContaining('glyph-identity-conflict')});
  expect(loads).toBe(0);
});
test('raw Type1 adapter failure retains legacy permutation without authorizing new codes',async()=>{
  const f=await type1Fixture();
  f.font.set(PDFName.of('Encoding'),PDFName.of('UnsupportedEncoding'));
  for(const options of [{sourceReuse:false},enabled]) {
    expect(replaceRuns(f.source.bytes,resolveRunFonts(f.page,options),f.plan('BA')).ok).toBe(true);
    const result=replaceRuns(f.source.bytes,resolveRunFonts(f.page,options),f.plan('C'));
    expect(result).toMatchObject({ok:false,code:'font-coverage'});
    expect(result.bytes).toEqual(f.source.bytes);
  }
});
const invalidSources:[NonNullable<Parameters<typeof type1Fixture>[0]>,string][]=[
  [{widths:[600,602,600]},'font-metrics-conflict'],
];
for(const [options,reason] of invalidSources) {
  test(`pure compiler and page boundary assert source before deletion/permutation: ${reason}`,async()=>{
    for(const replacement of ['','BA']) {
      const f=await type1Fixture(options),plan=f.plan(replacement);
      for(const result of [replaceRuns(f.source.bytes,resolveRunFonts(f.page,enabled),plan),replaceRunPage(f.page,plan,enabled)]) {
        expect(result).toMatchObject({ok:false,terminal:true,reason:expect.stringContaining(reason)});
        expect(result.bytes).toEqual(f.source.bytes);
      }
    }
  });
}
for(const bad of [{widths:[602,600,600]},{brokenProgram:true}])test(`untargeted Type1 retains PDF placement widths before another font: ${JSON.stringify(bad)}`,async()=>{
  const f=await type1Fixture({...bad,stream:'BT /F1 10 Tf 50 100 Td (A) Tj /Target 10 Tf (ABCDE) Tj ET'});
  const ctx=f.doc.context;
  f.fonts.set(PDFName.of('Target'),ctx.register(ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Courier',FirstChar:32,Widths:Array(95).fill(600),Encoding:'WinAnsiEncoding',
    ToUnicode:ctx.register(ctx.flateStream('1 beginbfrange <20> <7e> <0020> endbfrange'))})));
  const result=await applyContentTextEdits(f.page,[overlay({coverRects:[{x:56,y:98,w:31,h:13}]})],optIn);
  expect(result.outcomes).toEqual([{overlayId:'edit',mode:'in-place'}]);
  expect(new TextDecoder().decode(contents(f.page))).toContain('58');
});
test('opt-in falls back only for unavailable clusters and retains proven source clusters',async()=>{
  const f=await type1Fixture({stream:'BT /F1 10 Tf 50 100 Td (ABBA) Tj ET'});
  const requested:string[]=[];
  const result=await exportPdf(await f.doc.save(),model([overlay({originalText:'ABBA',text:'AZAA'})]),
    {mode:'flatten',...optIn,inPlaceFallback:{loadFont:async name=>{requested.push(name);return loadFont(name);}}});
  expect(result.contentTextOutcomes).toEqual([{overlayId:'edit',mode:'fallback-font'}]);
  expect(requested.length).toBeGreaterThan(0);
  const out=await PDFDocument.load(result.bytes),ops=tokenizeContentStream(contents(out.getPage(0)));
  const selected=ops.filter(op=>op.operator==='Tf').map(op=>op.operands[0]);
  expect(selected).toContainEqual({kind:'name',value:'F1'});
  expect(selected.some(op=>op?.kind==='name'&&op.value.startsWith('ShioriFb'))).toBe(true);
});

const unsupportedPrograms:[NonNullable<Parameters<typeof type1Fixture>[0]>,string][]=[
  [{programOptions:{clear:'/WMode 0 def'}},'type1-ps-unsupported'],
  [{programOptions:{private:'/OtherSubrs 1 array dup 0 {} put def'}},'type1-ps-unsupported'],
  [{brokenProgram:true},'type1-container-invalid'],
];
for(const [options,reason] of unsupportedPrograms)for(const boundary of [compileRunPageWithFallback,replaceRunPageWithFallback]) {
  test(`${boundary.name}: global ${reason} preserves legacy fallback with sourceReuse on`,async()=>{
    for(const stage5Type1 of [{sourceReuse:false},enabled]) {
      const f=await type1Fixture(options),before=contents(f.page);
      expect(fontCoverageFromDict(f.font,enabled).canEncode('Z')).toMatchObject({ok:false,code:reason});
      let loads=0;
      const result=await boundary(f.page,f.plan('Z'),{stage5Type1,loadFont:async name=>{loads++;return loadFont(name);}});
      expect(result).toMatchObject({ok:true,usedFallback:true});
      expect(loads).toBeGreaterThan(0);
      expect(new TextDecoder().decode(result.bytes)).toContain('/ShioriFb');
      if(boundary===compileRunPageWithFallback)expect(contents(f.page)).toEqual(before);
    }
  });
}
