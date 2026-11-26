import { expect,test } from 'bun:test';
import { fallbackFontName,prepareFallback } from './fallbackFont';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
for(const [label,base,flags,expected]of [
  ['sans', 'Arial',32,'LiberationSans-Regular.ttf'],
  ['bold italic serif', 'TimesNewRomanPS-BoldItalicMT',2,'LiberationSerif-BoldItalic.ttf'],
  ['unknown fixed-pitch face', 'UnknownFace',1|64|(1<<18),'LiberationMono-BoldItalic.ttf'],
  ['italic sans', 'Arial-Italic',32,'LiberationSans-Italic.ttf'],
]as const)test(`reuse the existing DOCX face for ${label}`,()=>expect(fallbackFontName(base,flags,'é')).toBe(expected));
for(const [text,expected]of [
  ['动手学i深度学习','NotoSansSC-Bold.otf'],['漢é字','NotoSansSC-Bold.otf'],
  ['かなiカナ','NotoSansJP-Bold.otf'],['漢한ｶé','NotoSansJP-Bold.otf'],
  ['한국i어','NotoSansKR-Bold.otf'],['ㄱéㄴ','NotoSansKR-Bold.otf'],
]as const)for(const [label,base] of [['sans','Arial'],['serif','Times-BoldItalic'],['mono','Courier']])test(`pick a CJK face for ${label} / ${text}`,()=>{
  expect(fallbackFontName(base,1|64|(1<<18),text)).toBe(expected);
});
for(const family of ['Sans','Serif','Mono'])test(`existing DOCX ${family} program embeds é without changing source bytes`,async()=>{
  const source=await readFile(`node_modules/@docx-editor.dev/fonts/assets/Liberation${family}-Regular.ttf`),copy=Buffer.from(source);
  const doc=await PDFDocument.create();
  const out=await prepareFallback(doc,'Fb',`Liberation${family}-Regular.ttf`,['é'],{loadFont:async()=>source});
  expect(out.resolved.canEncode!('é').ok).toBe(true);expect(source).toEqual(copy);
});
