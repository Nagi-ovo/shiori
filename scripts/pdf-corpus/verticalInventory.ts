// Read-only dictionary/operator inventory. No export or corpus report writes.
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFStream} from 'pdf-lib';
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {verticalWritingReason} from '../../src/pdf/export/contentStreamEdit/verticalWriting';
import {fontInputFromDict,streamBytes} from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import {type1Container} from '../../src/pdf/export/fontCoverage/type1Container';
import {Type1Lexer} from '../../src/pdf/export/fontCoverage/type1Lexer';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
const args=process.argv.slice(2),value=(key:string,fallback:string)=>args.includes(key)?args[args.indexOf(key)+1]!:fallback;
const cache=value('--cache','test-artifacts/pdf-corpus/cache'),out=resolve(value('--out','test-artifacts/r24-vert/inventory.json'));
if(out.includes('/pdf-corpus/')||out.includes('/survey/'))throw Error('Choose a separate inventory output directory');
const files=(await readdir(cache)).filter(n=>/^digital-jp-.*\.pdf$/u.test(n)).map(n=>join(cache,n));
for(let i=0;i<args.length;i++)if(args[i]==='--add-dir'){
 const dir=join(args[++i]!,'pdf-corpus-r23-final','samples');
 for(const name of await readdir(dir))if(/^digital-jp-.*\.before\.pdf$/u.test(name))files.push(join(dir,name));
}
const rows=[];
for(const path of files){
 const doc=await PDFDocument.load(await readFile(path),{ignoreEncryption:true}),vertical:unknown[]=[],rotated:unknown[]=[],uprightColumns:unknown[]=[];
 const seen=new Set<PDFDict>(),sampledPages=Array.from({length:doc.getPageCount()},(_,i)=>i);
 for(const [pageIndex,page]of doc.getPages().entries()){
  const streams:{scope:string;ops:ReturnType<typeof tokenizeContentStream>}[]=[];
  const inspect=(resources:PDFDict|undefined,scope:string,ancestors=new Set<PDFStream>())=>{
   const fonts=resources?.lookupMaybe(PDFName.of('Font'),PDFDict);
   for(const [name,ref]of fonts?.entries()??[]){const raw=fonts!.context.lookup(ref);if(!(raw instanceof PDFDict)||seen.has(raw))continue;seen.add(raw);
    let reason=verticalWritingReason(raw);
    if(!reason&&raw.get(PDFName.of('Subtype'))===PDFName.of('Type1'))try{
     const input=fontInputFromDict(raw);if(input.program){const lexer=new Type1Lexer(type1Container(input).clear);
      for(let token=lexer.next();token;token=lexer.next())if(token.kind==='name'&&token.value==='WMode'){const v=lexer.next(),def=lexer.next();if(v?.value==='1'&&def?.value==='def')reason='font program writing mode 1';}
     }
    }catch{ /* This inventory does not grant program reuse. */ }
    const child=raw.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray)?.lookup(0,PDFDict);
    if(reason)vertical.push({page:pageIndex,scope,name:name.decodeText(),subtype:raw.get(PDFName.of('Subtype'))?.toString(),encoding:raw.get(PDFName.of('Encoding'))?.toString(),reason,DW2:child?.get(PDFName.of('DW2'))?.toString(),W2:child?.get(PDFName.of('W2'))?.toString()});
   }
   for(const [name,ref]of resources?.lookupMaybe(PDFName.of('XObject'),PDFDict)?.entries()??[]){const raw=resources!.context.lookup(ref);if(!(raw instanceof PDFStream)||ancestors.has(raw)||raw.dict.lookup(PDFName.of('Subtype'))!==PDFName.of('Form'))continue;
    inspect(raw.dict.lookupMaybe(PDFName.of('Resources'),PDFDict)??resources,scope+'/'+name.decodeText(),new Set([...ancestors,raw]));
    if(sampledPages.includes(pageIndex))streams.push({scope:scope+'/'+name.decodeText(),ops:tokenizeContentStream(streamBytes(raw))});
   }
  };
  inspect(page.node.Resources(),'page');
  const content=sampledPages.includes(pageIndex)?inspectRunPage(page):undefined;if(content?.ok)streams.push({scope:'page',ops:tokenizeContentStream(content.bytes)});
  for(const {scope,ops}of streams){
   const matrices=ops.filter(o=>o.operator==='Tm').map(o=>o.operands.map(v=>v.kind==='number'?v.value:NaN));
   const sideways=matrices.filter(m=>m.length===6&&Math.abs(m[0]!)<1e-6&&Math.abs(m[3]!)<1e-6&&Math.abs(m[1]!)>1e-6&&Math.abs(m[2]!)>1e-6);
   if(sideways.length)rotated.push({page:pageIndex,scope,count:sideways.length,examples:sideways.slice(0,3)});
   const upright=matrices.filter(m=>m[0]!>0&&m[3]!>0&&Math.abs(m[1]!)<1e-6&&Math.abs(m[2]!)<1e-6);
   const columns=upright.filter((m,i)=>i>0&&Math.abs(m[4]!-upright[i-1]![4]!)<.01&&m[5]!<upright[i-1]![5]!);
   if(columns.length)uprightColumns.push({page:pageIndex,scope,count:columns.length,classification:'candidate only: repeated Tm may also be horizontal lines',examples:columns.slice(0,2)});
  }
 }
 rows.push({path,pages:doc.getPageCount(),operatorSamplePages:[...new Set(sampledPages)],vertical,rotated,uprightColumns});
 console.log(path.split('/').at(-1),vertical.length,rotated.length);
}
await mkdir(out.slice(0,out.lastIndexOf('/')),{recursive:true});await writeFile(out,JSON.stringify({command:process.argv.join(' '),files:rows.length,rows},null,2));
console.log(JSON.stringify({files:rows.length,verticalFiles:rows.filter(r=>r.vertical.length).map(r=>({path:r.path,vertical:r.vertical})),rotatedFiles:rows.filter(r=>r.rotated.length).map(r=>({path:r.path,rotated:r.rotated})),output:out},null,2));
