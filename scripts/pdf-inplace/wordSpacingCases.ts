// Acceptance: replace an actual code-32 space under Tc/Tw/Tz, and force an
// Identity-H CID 32 space followed by another replacement glyph. Verify both
// the pre-compensation width delta and the fixed untouched neighbour natively.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { inspectRunPage, resolveRunFonts } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import { replaceRuns } from '../../src/pdf/export/contentStreamEdit/replaceRun';
import { prepareFallback } from '../../src/pdf/export/contentStreamEdit/fallbackFont';
import { addFixtureAsciiMappings, readSavedGlyphs, assertSavedGlyphs, type OracleGlyph } from './oracleGlyphs';
const b=(s:string)=>new TextEncoder().encode(s);
export async function wordSpacingCases(out:string) {
  const cases=[];
  for(const cidSpace of [false,true]) {
    const doc=await PDFDocument.load(await readFile('scripts/pdf-inplace/fixtures/happy.pdf'),{updateMetadata:false});
    const page=doc.getPage(0);addFixtureAsciiMappings(page);
    page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(b('BT /F1 24 Tf 2 Tc 4 Tw 80 Tz 72 700 Td (A B) Tj ( tail) Tj ET'))));
    const info=inspectRunPage(page);assert(info.ok);
    const before=await doc.save({useObjectStreams:false}),old=await readSavedGlyphs(before);
    const source=resolveRunFonts(page).find(f=>f.resourceName==='F1')!;
    let fallback:Awaited<ReturnType<typeof prepareFallback>>|undefined;
    if(cidSpace) {
      // Allocate 31 real glyphs before space, making space's PDF code 0x0020. B shares its fallback show so
      // PDFium retains the real whitespace glyph rather than inferring one.
      fallback=await prepareFallback(doc,'SpaceFallback','LiberationSerif-Regular.ttf',[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',' '],{
        loadFont:()=>readFile('node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-Regular.ttf'),
      });
      assert.equal(fallback.resolved.unicodeByCode.get(32),' ');
      const fonts=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict).clone();fonts.set(PDFName.of('SpaceFallback'),fallback.ref);
      const resources=page.node.Resources()!.clone();resources.set(PDFName.of('Font'),fonts);page.node.set(PDFName.of('Resources'),resources);
    }
    // Force the source coverage miss in this compiler acceptance input; the
    // real subset source-coverage/fallback adapter path is tested separately.
    const resolved=cidSpace?{...source,canEncode:(text:string)=>(text.includes(' ')||text.includes('B'))?{ok:false as const,reason:'space/B deliberately unavailable',firstMissing:text.includes(' ')?' ':'B',offset:0}:source.canEncode!(text)}:source;
    const result=replaceRuns(info.bytes,[resolved],{sourceHash:info.sourceHash,allowOverflow:true,
      fallbackFonts:fallback?[fallback.resolved]:[],edits:[{
        fontResource:source.resourceName,fontObject:source.objectId,opIndex:6,itemIndex:-1,
        byteStart:cidSpace?0:1,byteEnd:cidSpace?3:2,expected:b(cidSpace?'A B':' '),replacement:cidSpace?'A B':'c',
      }]});assert(result.ok,!result.ok&&result.reason);
    page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(result.bytes)));
    const after=await doc.save({useObjectStreams:false}),saved=await readSavedGlyphs(after);
    const expected:OracleGlyph[]=old.glyphs.map((g,i)=>({...g,edited:cidSpace?i<3:i===1,replacement:cidSpace?i<3:i===1}));
    if(cidSpace){
      expected[1]={...expected[1]!,fontObject:fallback!.ref.toString(),code:32};
      expected[2]={...expected[2]!,fontObject:fallback!.ref.toString(),code:2};
    }
    else expected[1]={...expected[1]!,unicode:'c',code:99};
    assertSavedGlyphs(expected,saved.glyphs);
    const name=cidSpace?'tw-fallback-cid32-space':'tw-simple-space',beforeName=`${name}.before.pdf`,afterName=`${name}.after.pdf`;
    await writeFile(join(out,beforeName),before);await writeFile(join(out,afterName),after);
    const originChecks=cidSpace?[{beforeIndex:2,afterIndex:2,deltaPt:(250-250)*24/1000*.8-4*.8}]:[{beforeIndex:2,afterIndex:2,deltaPt:0}];
    cases.push({name,before:beforeName,after:afterName,
      beforeGlyphs:old.glyphs.map((g,i)=>({...g,edited:expected[i]!.edited})),
      afterGlyphs:saved.glyphs.map((g,i)=>({...g,edited:expected[i]!.edited,replacement:expected[i]!.replacement})),expectedAfterGlyphs:expected,
      fontHashes:{...old.fontHashes,...saved.fontHashes},editBox:[85,690,110,730],required:[cidSpace?'A B':'AcB'],absent:cidSpace?[]:['A B'],
      expectedText:cidSpace?'A B tail':'AcB tail',embeddedFallback:cidSpace,originChecks});
  }
  return cases;
}
