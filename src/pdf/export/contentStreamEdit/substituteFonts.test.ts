import {expect,test} from 'bun:test';
import {substituteFontName} from './substituteFonts';
import {prepareFallback} from './fallbackFont';
import {PDFDocument} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
for(const [source,flags,text,name]of [
 ['ABCDEF+TimesNewRomanPSMT',0,'Hello','LiberationSerif-Regular.ttf'],
 ['CMR10',0,'Hello','LiberationSerif-Regular.ttf'],['CMSY10',0,'x','LiberationSerif-Regular.ttf'],
 ['CMSS10',0,'Hello','LiberationSans-Regular.ttf'],['CMTT10',0,'Hello','LiberationMono-Regular.ttf'],
 ['Arial-BoldItalicMT',0,'Hello','LiberationSans-BoldItalic.ttf'],
 ['Calibri-Bold',0,'Hello','Carlito-Bold.ttf'],['Cambria-Italic',0,'Hello','Caladea-Italic.ttf'],
 ['AvantGarde-Book',0,'Hello','TeXGyreAdventor-Regular.otf'],
 ['Unknown',1|64|(1<<18),'Hello','LiberationMono-BoldItalic.ttf'],
 ['Times',0,'漢字','NotoSansSC-Regular.otf'],['Times',0,'漢字かな','NotoSansJP-Regular.otf'],
]as const)test(`substitute ${source} / ${text} with ${name}`,()=>expect(substituteFontName(source,flags,text)).toBe(name));
for(const family of ['Carlito','Caladea','TeXGyreAdventor'])for(const style of ['Regular','Bold','Italic','BoldItalic'])test(`${family} ${style} creates a verified searchable Type0 subset`,async()=>{
 const name=`${family}-${style}.${family==='TeXGyreAdventor'?'otf':'ttf'}`,data=await readFile(`node_modules/@docx-editor.dev/fonts/assets/${name}`),copy=Buffer.from(data);
 const result=await prepareFallback(await PDFDocument.create(),'Sub',name,['A','X','é'],{loadFont:async()=>data});
 expect(result.resolved.canEncode!('AXé').ok).toBe(true);expect(data).toEqual(copy);
});
