// Bounded replay of the crashed export, never the full corpus.
// Regenerate: bun scripts/pdf-corpus/fixTd1Native.ts
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {buildCorpusOverlays} from './overlays';
import {editMatrix} from './editMatrix';
import {auditCorpusSample} from './oracle';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import type {PageModel} from '../../src/pdf/model/types';

const directory='test-artifacts/fix-td1-native',command='bun scripts/pdf-corpus/fixTd1Native.ts';
await mkdir(directory,{recursive:true});await writeFile(`${directory}/README.md`,`Regenerate: ${command}\n`);
const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so');
try{
 const source=await PDFDocument.load(await readFile('test-artifacts/pdf-corpus/cache/zh-d2l-pytorch.pdf'));
 const doc=await PDFDocument.create(),[copied]=await doc.copyPages(source,[597]),target=doc.addPage(copied!);
 const before=await doc.save(),geometry=native.inspectPage(before),crop=target.getCropBox();
 const page:PageModel={id:'corpus-page',sourceIndex:0,widthPt:crop.width,heightPt:crop.height,originXPt:crop.x,originYPt:crop.y,rotation:target.getRotation().angle as PageModel['rotation']};
 const original=buildCorpusOverlays(geometry,page).find(o=>!o.originalText.includes('\n')&&/\p{Script=Han}/u.test(o.originalText));assert(original);
 const overflow=editMatrix(original.originalText).find(e=>e.kind==='overflow');assert(overflow);
 const edit={...original,text:overflow.text},name='zh-d2l-pytorch-597-overflow';
 await writeFile(`${directory}/${name}.before.pdf`,before);
 await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({page,edit},null,2));
 const result=await exportPdf(before,{pages:[page],overlays:[edit]},{mode:'flatten',stage5Type1:{sourceReuse:true},stage5Reflow:true,stage5Substitute:true,
  unicodeFontBytes:new Uint8Array(await readFile('src/assets/fonts/NotoSansSC-Regular.otf')),
  unicodeJpFontBytes:new Uint8Array(await readFile('src/assets/fonts/NotoSansJP-Regular.otf')),
  inPlaceFallback:{loadFont:name=>readFile(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`)}});
 const outcome=result.contentTextOutcomes?.[0];assert(outcome);
 await writeFile(`${directory}/${name}.after.pdf`,result.bytes);
 const saved=native.inspectPage(result.bytes);assert(saved.glyphs.length>0);
 const oracle=outcome.mode==='unsupported'||outcome.mode==='retypeset'?undefined:await auditCorpusSample(native,name,directory,edit,{sourceReuse:true},true,outcome.reflow,outcome.mode);
 const report={command,case:'zh-d2l-pytorch/597/overflow',passed:true,outcome,oracle,savedGlyphs:saved.glyphs.length};
 await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){
 await writeFile(`${directory}/report.json`,JSON.stringify({command,passed:false,error:String(error)},null,2));throw error;
}finally{native.close();}
