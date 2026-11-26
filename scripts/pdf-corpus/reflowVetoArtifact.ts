import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {AppliedReflowManifest} from '../../src/pdf/export/contentText/reflowManifest';
import type {PdfRect} from '../../src/pdf/model/types';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {compareReflowNativePages} from './reflowOracle';
import {backdropReferencePdf} from './reflowBackdropRaster';

type Edit={originalText:string;text:string;coverRects:readonly PdfRect[]};
/** Harness-only failure evidence. Store the immutable mask/old ink and both
 * PDFs so a missed-paint veto can be regenerated without the corpus. */
export async function saveReflowVetoArtifact(input:{name:string;before:Uint8Array;after:Uint8Array;
 edit:Edit;manifest:AppliedReflowManifest;error:unknown}){
 const directory=`test-artifacts/pdf-stage5/reflow/${input.name.replace(/[^\w.-]/g,'_')}`,file=`${directory}/case.json`;
 await mkdir(directory,{recursive:true});
 await writeFile(`${directory}/before.pdf`,input.before);await writeFile(`${directory}/after.pdf`,input.after);
 const command=`bun scripts/pdf-corpus/reflowVetoArtifact.ts ${file}`;
 await writeFile(file,JSON.stringify({command,page:0,dpi:144,error:String(input.error),edit:input.edit,manifest:input.manifest},null,2));
 await writeFile(`${directory}/README.md`,`Regenerate the expected veto: ${command}\nUses native PDFium at 144 dpi and the saved fixed mask. A veto never grants space or widens that mask.\n`);
 return file;
}
if(import.meta.main){
 const file=process.argv[2];assert(file,'usage: bun scripts/pdf-corpus/reflowVetoArtifact.ts <case.json>');
 const record=JSON.parse(await readFile(file,'utf8')) as {edit:Edit;manifest:AppliedReflowManifest};
 const native=openPdfium(process.env.PDFIUM_LIBRARY??'vendor/pdfium/linux-x64/lib/libpdfium.so');
 try{
  let veto:string|undefined;
  const reference=await backdropReferencePdf(new Uint8Array(await readFile(join(dirname(file),'before.pdf'))),record.manifest);
  try{compareReflowNativePages(native.inspectPage(join(dirname(file),'before.pdf'),0,true),
   native.inspectPage(join(dirname(file),'after.pdf'),0,true),record.edit,record.manifest,reference?native.inspectPage(reference,0,true):undefined);}
  catch(error){if(error instanceof Error&&error.message.includes('raster veto'))veto=error.message;else throw error;}
  assert(veto,'saved fixture no longer triggers its expected raster veto');
  console.log(JSON.stringify({passed:true,vetoed:true,error:veto}));
 }finally{native.close();}
}
