// A genuinely narrow source program: the second Liberation subset contains
// only Sans. The replacement d must live in an independent fallback resource.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { inspectRunPage, resolveRunFonts } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import { replaceRunPageWithFallback } from '../../src/pdf/export/contentStreamEdit/fallbackPage';
import { readSavedGlyphs, assertSavedGlyphs } from './oracleGlyphs';
export async function subsetFallbackCase(out: string) {
  const doc=await PDFDocument.load(await readFile('scripts/pdf-inplace/fixtures/subset.pdf'),{updateMetadata:false});
  const page=doc.getPage(0),info=inspectRunPage(page);assert(info.ok);
  const before=await doc.save({useObjectStreams:false}),savedBefore=await readSavedGlyphs(before);
  const old=savedBefore.glyphs.at(-1)!;assert.equal(old.unicode,'s');assert.equal(old.code,4);
  const font=resolveRunFonts(page).find(f=>f.objectId===old.fontObject)!;
  assert(!font.canEncode!('d').ok,'fixture must really lack d');
  const result=await replaceRunPageWithFallback(page,{sourceHash:info.sourceHash,allowOverflow:true,edits:[{
    fontResource:font.resourceName,fontObject:font.objectId,opIndex:old.opIndex,itemIndex:old.itemIndex,
    byteStart:6,byteEnd:8,expected:Uint8Array.of(0,4),replacement:'d',
  }]},{loadFont:name=>readFile(name.endsWith('.ttf') ? `node_modules/@docx-editor.dev/fonts/assets/${name}` : `src/assets/fonts/${name}`)});
  assert(result.ok,!result.ok&&result.reason);
  const after=await doc.save({useObjectStreams:false}),savedAfter=await readSavedGlyphs(after);
  const fallback=resolveRunFonts(page).find(f=>f.resourceName.startsWith('ShioriFb'))!;
  assert(fallback);const code=[...fallback.unicodeByCode].find(([,u])=>u==='d')![0];
  old.edited=true;
  const expected=[...savedBefore.glyphs.slice(0,-1),{...old,code,fontObject:fallback.objectId,unicode:'d',replacement:true}];
  assertSavedGlyphs(expected,savedAfter.glyphs);
  const name='fallback-real-subset',beforeName=`${name}.before.pdf`,afterName=`${name}.after.pdf`;
  await writeFile(join(out,beforeName),before);await writeFile(join(out,afterName),after);
  return {name,before:beforeName,after:afterName,beforeGlyphs:savedBefore.glyphs,
    afterGlyphs:savedAfter.glyphs.map((g,i)=>({...g,edited:expected[i]!.edited,replacement:expected[i]!.replacement})),expectedAfterGlyphs:expected,
    savedCodesVerified:true,fontHashes:{...savedBefore.fontHashes,...savedAfter.fontHashes},editBox:[50,90,80,125],required:['Sand'],absent:['Sans'],expectedText:'Liberation Sand',embeddedFallback:true};
}
