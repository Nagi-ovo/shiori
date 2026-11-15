import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName} from 'pdf-lib';
import {replaceRunPageWithFallback} from './fallbackPage';
import {type1Fixture} from '../contentText/type1Wiring.test-support';
import {nums,widthChar} from '../fontCoverage/fixtures/type1';
import {inspectRunPage,resolveRunFonts} from './replaceRunPage';
import {walkTextPlacements} from './textState';
import {tokenizeContentStream} from './tokenizer';

const loadFont=(name:string)=>readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`);
for(const replacement of ['AB','BA'])test(`an addressed missing Type1 glyph falls back for ${replacement} without reusing unproven bytes`,async()=>{
  const f=await type1Fixture({programOptions:{glyphs:{A:widthChar(),C:widthChar()}}});
  const result=await replaceRunPageWithFallback(f.page,{...f.plan(replacement),allowOverflow:true},{stage5Type1:{sourceReuse:true},loadFont});
  expect(result).toMatchObject({ok:true,usedFallback:true});
  const saved=await PDFDocument.load(await f.doc.save({useObjectStreams:false})),page=saved.getPage(0);
  const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
  const fonts=resolveRunFonts(page,{sourceReuse:true}),byName=new Map(fonts.map(font=>[font.resourceName,font]));
  const walk=walkTextPlacements(tokenizeContentStream(content.bytes),{resolveFont:name=>{
    const font=byName.get(name);return font?{...font,ok:true,appliesWordSpacing:font.bytesPerCode===1}:null;
  }});
  if(!walk.ok)throw Error(walk.reason);
  const glyphs=walk.glyphs.map(g=>({font:byName.get(g.fontName)!,code:g.code}));
  const unicode=(g:typeof glyphs[number])=>g.font.unicodeByCode.get(g.code);
  expect(glyphs.map(unicode).join('')).toBe(replacement);
  expect(glyphs.find(g=>unicode(g)==='B')?.font.resourceName).toStartWith('ShioriFb');
  expect(glyphs.find(g=>unicode(g)==='A')?.font.objectId).toBe(f.ref.toString());
});
const terminalCases:readonly [string,NonNullable<Parameters<typeof type1Fixture>[0]>][]=[
  ['glyph-identity-conflict',{differences:[66,'C']}],
  ['font-metrics-conflict',{widths:[600,602,600]}],
  ['type1-other-subr-unsupported',{programOptions:{glyphs:{B:Uint8Array.from([...nums(0,600),13,...nums(0,4),12,16,14])}}}],
];
for(const [reason,options] of terminalCases)test(`a later addressed ${reason} stays terminal after a missing glyph`,async()=>{
  const f=await type1Fixture({...options,programOptions:{glyphs:{B:widthChar(),C:widthChar()},...options.programOptions}});
  const resources=f.page.node.Resources(),contents=f.page.node.get(PDFName.of('Contents')),count=f.doc.context.enumerateIndirectObjects().length;
  let loads=0;
  const result=await replaceRunPageWithFallback(f.page,{...f.plan('BA'),allowOverflow:true},{stage5Type1:{sourceReuse:true},loadFont:async name=>{loads++;return loadFont(name);}});
  expect(result).toMatchObject({ok:false,terminal:true,reason:expect.stringContaining(reason)});
  expect(loads).toBe(0);
  expect(f.page.node.Resources()).toBe(resources);expect(f.page.node.get(PDFName.of('Contents'))).toBe(contents);
  expect(f.doc.context.enumerateIndirectObjects().length).toBe(count);
});
const replacementTerminalCases:typeof terminalCases=[
  ['glyph-identity-conflict',{differences:[67,'B']}],
  ['font-metrics-conflict',{widths:[600,600,602]}],
  ['type1-other-subr-unsupported',{programOptions:{glyphs:{B:widthChar(),C:Uint8Array.from([...nums(0,600),13,...nums(0,4),12,16,14])}}}],
];
for(const [reason,options] of replacementTerminalCases)test(`fallback preparation preserves terminal replacement ${reason}`,async()=>{
  const f=await type1Fixture({...options,programOptions:{glyphs:{B:widthChar(),C:widthChar()},...options.programOptions}});
  let loads=0;
  const result=await replaceRunPageWithFallback(f.page,{...f.plan('C'),allowOverflow:true},{stage5Type1:{sourceReuse:true},loadFont:async name=>{loads++;return loadFont(name);}});
  expect(result).toMatchObject({ok:false,terminal:true,diagnostic:{code:reason},reason:expect.stringContaining(reason)});
  expect(loads).toBe(0);
});
