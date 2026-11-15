import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { stage3Scenarios } from './stage3Scenarios';
import { addFixtureAsciiMappings, readSavedGlyphs, assertSavedGlyphs, type OracleGlyph } from './oracleGlyphs';
import { inspectRunPage, resolveRunFonts, replaceRunPage } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import { replaceRunPageWithFallback } from '../../src/pdf/export/contentStreamEdit/fallbackPage';
import { tokenizeContentStream } from '../../src/pdf/export/contentStreamEdit/tokenizer';
import { sfnt, tinyTtf } from '../../src/pdf/export/fontCoverage/fixtures/programs';
const b = (s:string) => new TextEncoder().encode(s);
const loadFont = (name:string) => readFile(name.endsWith('.ttf') ? `node_modules/@docx-editor.dev/fonts/assets/${name}` : `src/assets/fonts/${name}`);
function restrictedFont() {
  const raw=tinyTtf(),v=new DataView(raw.buffer),tables:Record<string,Uint8Array>={};
  for(let i=0;i<v.getUint16(4);i++){const p=12+16*i;tables[new TextDecoder().decode(raw.slice(p,p+4))]=raw.slice(v.getUint32(p+8),v.getUint32(p+8)+v.getUint32(p+12));}
  tables['OS/2']=new Uint8Array(100);tables['OS/2'][9]=2;
  return sfnt(tables);
}
export async function stage3Cases(out:string) {
  const manifest=[];
  for(const c of stage3Scenarios){
    const doc=await PDFDocument.load(await readFile('scripts/pdf-inplace/fixtures/happy.pdf'),{updateMetadata:false});
    const page=doc.getPage(0);
    addFixtureAsciiMappings(page);
    page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.stream(b(`BT /F1 24 Tf 72 700 Td ${c.source} ET`))));
    addFixtureAsciiMappings(page);
    const source=inspectRunPage(page);if(!source.ok)throw Error(source.reason);
    const fonts=resolveRunFonts(page),font=fonts.find(f=>f.resourceName==='F1')!;
    let opIndex=-1,itemIndex=-1,itemBytes=new Uint8Array();
    for(const [i,op]of tokenizeContentStream(source.bytes).entries()){
      const items=op.operator==='TJ'&&op.operands[0]?.kind==='array'?op.operands[0].items:op.operands;
      for(const [j,item]of items.entries())if(item.kind==='string'&&new TextDecoder().decode(item.bytes)===c.old){opIndex=i;itemIndex=op.operator==='TJ'?j:-1;itemBytes=item.bytes;}
    }
    assert(opIndex>=0);
    const before=await doc.save({useObjectStreams:false}), count=doc.context.enumerateIndirectObjects().length;
    const edit={fontResource:'F1',fontObject:font.objectId,opIndex,itemIndex,byteStart:c.start,byteEnd:c.end,expected:itemBytes.slice(c.start,c.end),replacement:c.replacement};
    const plan={sourceHash:source.sourceHash,edits:[edit],allowOverflow:'allowOverflow'in c&&c.allowOverflow};
    const result='fallback'in c?await replaceRunPageWithFallback(page,plan,{loadFont:'restricted'in c?async()=>restrictedFont():loadFont}):replaceRunPage(page,plan);
    const beforeName=`${c.name}.before.pdf`,afterName=`${c.name}.after.pdf`;
    await writeFile(join(out,beforeName),before);
    if('reason'in c){
      assert(!result.ok,`${c.name}: should refuse`);assert(result.reason.includes(c.reason),result.reason);
      assert.equal(doc.context.enumerateIndirectObjects().length,count);
      const after=await doc.save({useObjectStreams:false});assert.deepEqual(after,before);
      await writeFile(join(out,afterName),after);
      manifest.push({name:c.name,before:beforeName,after:afterName,refused:true,sourceText:c.old,reason:result.reason,firstMissing:result.firstMissing??'',offset:result.offset??0});continue;
    }
    assert(result.ok,`${c.name}: ${!result.ok&&result.reason}`);
    const after=await doc.save({useObjectStreams:false});await writeFile(join(out,afterName),after);
    const old=await readSavedGlyphs(before),saved=await readSavedGlyphs(after);
    const target=old.glyphs.flatMap((g,i)=>g.opIndex===opIndex&&g.itemIndex===itemIndex?[i]:[]);
    const start=target[0]!+c.start,n=c.end-c.start;
    const expected=[...old.glyphs];for(let i=start;i<start+n;i++)old.glyphs[i]!.edited=true;
    const afterFonts=resolveRunFonts(page);
    const replacement:OracleGlyph[]=Array.from(c.replacement,unicode=>{
      const f=font.canEncode!(unicode).ok?font:afterFonts.find(f=>f.resourceName.startsWith('ShioriFb')&&[...f.unicodeByCode.values()].includes(unicode))!;
      assert(f,`expected font for ${unicode}`);
      const row=[...f.unicodeByCode].find(([,u])=>u===unicode);assert(row);
      return {fontObject:f.objectId,code:row[0],unicode,opIndex,itemIndex,edited:true,replacement:true};
    });
    expected.splice(start,n,...replacement);assertSavedGlyphs(expected,saved.glyphs);
    const observedBefore=old.glyphs, observedAfter=saved.glyphs.map((g,i)=>({...g,edited:expected[i]!.edited,replacement:expected[i]!.replacement}));
    manifest.push({name:c.name,before:beforeName,after:afterName,beforeGlyphs:observedBefore,afterGlyphs:observedAfter,expectedAfterGlyphs:expected,savedCodesVerified:true,
      fontHashes:{...old.fontHashes,...saved.fontHashes},editBox:[130,690,c.name==='span-longer'?295:205,730],required:[c.expected],absent:[c.old],expectedText:c.expected+(c.source.includes('( tail)')?' tail':'')+(c.source.includes('(next)')?' next':''),embeddedFallback:'fallback'in c,overflow:result.overflow});
  }
  return manifest;
}
