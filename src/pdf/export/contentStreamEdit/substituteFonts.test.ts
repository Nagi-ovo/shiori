import {expect,test} from 'bun:test';
import {substituteFontName} from './substituteFonts';
import {prepareFallback} from './fallbackFont';
import {PDFDocument} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
for(const [label,source,flags,text,name]of [
 ['subset serif','ABCDEF+TimesNewRomanPSMT',0,'Hello','LiberationSerif-Regular.ttf'],
 ['typesetting serif','CMR10',0,'Hello','LiberationSerif-Regular.ttf'],['symbol face','CMSY10',0,'x','LiberationSerif-Regular.ttf'],
 ['typesetting sans','CMSS10',0,'Hello','LiberationSans-Regular.ttf'],['typesetting mono','CMTT10',0,'Hello','LiberationMono-Regular.ttf'],
 ['bold italic sans','Arial-BoldItalicMT',0,'Hello','LiberationSans-BoldItalic.ttf'],
 ['metric sans','Calibri-Bold',0,'Hello','Carlito-Bold.ttf'],['metric serif','Cambria-Italic',0,'Hello','Caladea-Italic.ttf'],
 ['geometric sans','AvantGarde-Book',0,'Hello','TeXGyreAdventor-Regular.otf'],
 ['fixed-pitch flags','Unknown',1|64|(1<<18),'Hello','LiberationMono-BoldItalic.ttf'],
 ['Han','Times',0,'漢字','NotoSansSC-Regular.otf'],['mixed Han and kana','Times',0,'漢字かな','NotoSansJP-Regular.otf'],
 ['bold Hangul','Arial-BoldItalic',64,'한국어','NotoSansKR-Bold.otf'],['mixed Hangul and Latin','Times',0,'ㄱéㄴ','NotoSansKR-Regular.otf'],
]as const)test(`substitute ${label} with ${name}`,()=>expect(substituteFontName(source,flags,text)).toBe(name));
for(const family of ['Carlito','Caladea','TeXGyreAdventor'])for(const style of ['Regular','Bold','Italic','BoldItalic'])test(`${family} ${style} creates a verified searchable Type0 subset`,async()=>{
 const name=`${family}-${style}.${family==='TeXGyreAdventor'?'otf':'ttf'}`,data=await readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`),copy=Buffer.from(data);
 const result=await prepareFallback(await PDFDocument.create(),'Sub',name,['A','X','é'],{loadFont:async()=>data});
 expect(result.resolved.canEncode!('AXé').ok).toBe(true);expect(data).toEqual(copy);
});
