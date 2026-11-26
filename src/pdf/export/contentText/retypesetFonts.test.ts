import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFString} from 'pdf-lib';
import {exportPdf} from '../exportPdf';
import {prepareFallback} from '../contentStreamEdit/fallbackFont';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource} from './retypesetSource';
import {applyContentTextEdits} from './apply';
import {model,overlay} from './fixtures.test-support';
import {openPdfium} from '../../../../scripts/pdf-inplace/nativePdfium';
import {readSavedGlyphs} from '../../../../scripts/pdf-inplace/oracleGlyphs';
import {assertReplacementGlyphs} from '../../../../scripts/pdf-inplace/glyphEvidence';

// Failure list: Latin-only holes in a CJK subset, CJK on a retained prefix
// line, all-CJK replacement, removed CJK, Latin-only output, and unsupported
// Hangul syllables. Saved bytes must have searchable, non-.notdef outlines.
const loadFont=(name:string)=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`);
const directory='test-artifacts/retypeset-fonts-r21';
const command='bun test src/pdf/export/contentText/retypesetFonts.test.ts';

async function sourcePage(lines:readonly string[],name='NotoSansSC-Regular.otf'){
 const doc=await PDFDocument.create(),page=doc.addPage([300,200]);
 const prepared=await prepareFallback(doc,'F1',name,Array.from(lines.join('')),{loadFont});
 const encode=(text:string)=>{
  const encoded=prepared.resolved.canEncode!(text);if(!encoded.ok)throw Error(encoded.reason);
  return Buffer.from(encoded.bytes).toString('hex');
 };
 // Stroke forces the production approximate writer without changing the
 // exact-tier proof or depending on its overflow/spacing heuristics.
 const stream=`BT /F1 10 Tf 1 Tr 16 TL ${lines.map((line,i)=>`1 0 0 1 50 ${150-i*16} Tm <${encode(line)}> Tj`).join(' ')} ET`;
 page.node.set(PDFName.of('Resources'),doc.context.obj({Font:{F1:prepared.ref}}));
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(stream)));
 return {doc,page,prepared};
}

for(const [label,originalText,text,name,substituteFont=name]of [
 ['han-i','动手学深度学习','动手学i深度学习','NotoSansSC-Regular.otf'],
 ['han-accent','动手学深度学习','动手学é深度学习','NotoSansSC-Regular.otf'],
 ['kana-i','かなカナ','かなiカナ','NotoSansJP-Regular.otf'],
 ['kana-accent','かなカナ','かなéカナ','NotoSansJP-Regular.otf'],
 ['hangul-i','ㄱㄴㄷㄹ','ㄱㄴiㄷㄹ','NotoSansKR-Regular.otf'],
 ['hangul-accent','ㄱㄴㄷㄹ','ㄱㄴéㄷㄹ','NotoSansKR-Regular.otf'],
 ['replace-han','aaaa','新的i文字','NotoSansSC-Regular.otf'],
 ['replace-kana','aaaa','かなiカナ','NotoSansJP-Regular.otf'],
 ['replace-hangul','aaaa','ㄱㄴiㄷㄹ','NotoSansKR-Regular.otf'],
 ['replace-mixed','aaaa','漢かㄱiなㄴカ','NotoSansJP-Regular.otf','NotoSansSC-Regular.otf, NotoSansJP-Regular.otf, NotoSansKR-Regular.otf'],
 ['latin','aaaa','aaaéa','LiberationSans-Regular.ttf'],
 ['remove-han','动手学深度学习','iiéii','LiberationSans-Regular.ttf'],
]as const)test(`saved retypeset selects ${substituteFont} and emits real outlines (${label})`,async()=>{
 const f=await sourcePage([originalText],name.startsWith('Noto')?name:'NotoSansSC-Regular.otf');
 const inserted=Array.from(text).filter(c=>!originalText.includes(c));
 expect(inserted.length).toBeGreaterThan(0);
 for(const c of inserted)expect(f.prepared.resolved.canEncode!(c).ok).toBe(false);
 const before=await f.doc.save({useObjectStreams:false});
 const edit=overlay({originalText,text,coverRects:[{x:49,y:148,w:200,h:15}]});
 const result=await exportPdf(before,model([edit]),{mode:'flatten',stage5Reflow:false,inPlaceFallback:{loadFont}});
 expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:'retypeset',fidelity:'approximate',retypeset:{substituteFont}});
 await mkdir(directory,{recursive:true});
 await writeFile(`${directory}/README.md`,`Regenerate: ${command}\nSynthetic fixtures only; no corpus run.\n`);
 const path=`${directory}/${label}.after.pdf`;
 await writeFile(`${directory}/${label}.before.pdf`,before);await writeFile(path,result.bytes);
 const saved=await readSavedGlyphs(result.bytes);
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe(text);
 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const observed=await native.measure(path,saved.glyphs.map(g=>({...g,replacement:true})),saved.fontHashes);
  expect(observed.text.replace(/\s/gu,'')).toBe(text);
  const checked=assertReplacementGlyphs(observed.glyphs);
  expect(checked).toBe(Array.from(text).length);
  await writeFile(`${directory}/${label}.json`,JSON.stringify({command,outcome:result.contentTextOutcomes![0],nonNotdefGlyphs:checked,glyphs:observed.glyphs},null,2));
 }finally{native.close();}
});

test('CJK on an untouched earlier paragraph line still selects Noto for a Latin-only tail',async()=>{
 const f=await sourcePage(['动手学深度学习','aaaaaa']);
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'aaaaaa',text:'aaaiaaa',coverRects:[{x:49,y:132,w:40,h:15}]})],{loadFont,stage5Reflow:false});
 expect(r.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'NotoSansSC-Regular.otf'}});
 const stream=inspectRunPage(f.page);if(!stream.ok)throw Error(stream.reason);
 const output=readRetypesetSource(f.page,tokenizeContentStream(stream.bytes));
 expect(output.glyphs.filter(g=>g.y===150).map(g=>g.text).join('')).toBe('动手学深度学习');
 expect(output.glyphs.filter(g=>g.text==='i').map(g=>g.glyph.fontName)).toHaveLength(1);
});

test('Hangul syllables select KR and remain searchable after saving',async()=>{
 const f=await sourcePage(['aaaa']);
 const r=await applyContentTextEdits(f.page,[overlay({originalText:'aaaa',text:'한i',coverRects:[{x:49,y:148,w:40,h:15}]})],{loadFont,stage5Reflow:false});
 expect(r.outcomes[0]).toMatchObject({mode:'retypeset',retypeset:{substituteFont:'NotoSansKR-Regular.otf'}});
 const saved=await readSavedGlyphs(await f.doc.save());
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe('한i');
 expect(saved.glyphs.every(g=>g.glyphId!==undefined&&g.glyphId>0)).toBe(true);
});

// Mixed retypeset can preserve the paragraph's usual face for neutral holes
// while installing a different face for Han with CID or language evidence.
test.each([
 ['cjk-gb1-kana','GB1','ja','漢字ですé、','SC','JP'],
 ['cjk-japan1-hangul','Japan1','ko','漢字한글é、','JP','KR'],
 ['cjk-lang-kana','Identity','ko','漢字ですé、','KR','JP'],
]as const)('saved mixed retypeset installs the regional face for each glyph (%s)',async(label,ordering,lang,text,han,context)=>{
 const originalText='a字';
 const f=await sourcePage([originalText]);
 const key=PDFName.of;
 const cid=f.doc.context.lookup(f.prepared.ref,PDFDict).lookup(key('DescendantFonts'),PDFArray).lookup(0,PDFDict);
 cid.lookup(key('CIDSystemInfo'),PDFDict).set(key('Ordering'),PDFString.of(ordering));
 f.doc.catalog.set(key('Lang'),PDFString.of(lang));
 for(const c of text.replace('字',''))expect(f.prepared.resolved.canEncode!(c).ok).toBe(false);
 const before=await f.doc.save({useObjectStreams:false});
 const edit=overlay({originalText,text,coverRects:[{x:49,y:148,w:200,h:15}]});
 const result=await exportPdf(before,model([edit]),{mode:'flatten',stage5Reflow:false,inPlaceFallback:{loadFont}});
 expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:'retypeset',fidelity:'approximate'});
 const saved=await readSavedGlyphs(result.bytes);
 expect(saved.glyphs.map(g=>g.unicode).join('')).toBe(text);
 expect(saved.glyphs.every(g=>(g.glyphId??0)>0)).toBe(true);

 const doc=await PDFDocument.load(result.bytes);
 const fonts=doc.getPage(0).node.Resources()!.lookup(key('Font'),PDFDict);
 const names=new Map(fonts.entries().map(([,ref])=>[ref.toString(),doc.context.lookup(ref,PDFDict).lookup(key('BaseFont'),PDFName).decodeText()]));
 const actual=saved.glyphs.map(g=>names.get(g.fontObject));
 const original=await readSavedGlyphs(before);
 const retained=saved.glyphs.find(g=>g.unicode==='字')!;
 expect(saved.fontHashes[retained.fontObject]).toBe(original.fontHashes[original.glyphs[1]!.fontObject]);
 const subsetName=async(region:string)=>{
  const bytes=await loadFont(`NotoSans${region}-Regular.otf`);
  const prefix=createHash('sha256').update(bytes).digest('hex').slice(0,6)
   .replace(/[0-9a-f]/gu,c=>String.fromCharCode(65+parseInt(c,16)));
  return prefix+'+ShioriFallback';
 };
 const expectedHan=await subsetName(han),expectedContext=await subsetName(context);
 expect(actual).toEqual([expectedHan,await subsetName('SC'),...Array.from(text.slice(2),()=>expectedContext)]);

 const native=openPdfium('vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  const observed=native.inspectPage(result.bytes,0,true);
  expect(observed.text.replace(/\s/gu,'')).toBe(text);
  expect(observed.glyphs.filter(g=>g.text.trim()).every(g=>g.nativePath?.length&&g.inkPixels!>0)).toBe(true);
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/${label}.before.pdf`,before);
  await writeFile(`${directory}/${label}.after.pdf`,result.bytes);
  await writeFile(`${directory}/${label}.json`,JSON.stringify({command,ordering,lang,actual,glyphs:observed.glyphs},null,2));
 }finally{native.close();}
});
