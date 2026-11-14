import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFStream } from 'pdf-lib';
import { collectFontCoverage, lookup, streamBytes } from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import { codeHex, hexBytes } from '../../src/pdf/export/fontCoverage/types';
import { tokenizeContentStream, coalesceContentStreams } from '../../src/pdf/export/contentStreamEdit/tokenizer';
import { walkTextPlacements } from '../../src/pdf/export/contentStreamEdit/textState';
import { coverageFixtures } from './fixtures';

const destination=resolve('test-artifacts/font-coverage');
await mkdir(destination,{recursive:true});
const paths=process.argv.slice(2);
const fixtures=paths.length?new Map(await Promise.all(paths.map(async p=>[basename(p,'.pdf'),new Uint8Array(await Bun.file(p).arrayBuffer())] as const))):await coverageFixtures();
let failures=0,totalShown=0,totalVerified=0,totalRejected=0;
for(const [name,bytes] of fixtures) {
  const fixture=`${paths.length?'input':'generated'}-${name}`;
  const document=await PDFDocument.load(bytes),fonts=collectFontCoverage(document);
  const checks:unknown[]=[],unwalked:unknown[]=[];
  let shown=0,verified=0,rejected=0;
  const scope=(resources:PDFDict | undefined,parts:Uint8Array[],pageNumber:number,path:string[],ancestors:Set<PDFStream>)=>{
    const matching=(f:typeof fonts[number],name:string)=>f.resources.some(r=>r.page===pageNumber && r.name===name && r.path.length===path.length && r.path.every((p,i)=>p===path[i]));
    // Only the walker's code collection is used here. Zero widths deliberately
    // avoid pretending this script verifies font metrics or page geometry.
    const walk=walkTextPlacements(tokenizeContentStream(coalesceContentStreams(parts)),{resolveFont:name=>{
      const font=fonts.find(f=>matching(f,name));
      if(!font)return null;
      const lengths=new Set([...font.codeToUnicode.keys()].map(h=>h.length/2));
      if(!lengths.size)lengths.add(font.subtype==='Type0'?2:1);
      if(lengths.size!==1 || ![1,2].includes([...lengths][0]!))return {ok:false,reason:'walker cannot collect variable-width or >2-byte codes'};
      return {ok:true,bytesPerCode:[...lengths][0] as 1|2,widthOf:()=>0,ascentEm:1,descentEm:0,appliesWordSpacing:false};
    }});
    if(!walk.ok){unwalked.push({page:pageNumber,path,reason:walk.reason});return;}
    if(walk.unplacedText)unwalked.push({page:pageNumber,path,reason:'text-state walker left text unplaced'});
    for(const use of walk.xobjects) {
      const objects=resources?lookup(resources,'XObject'):undefined;
      const form=objects instanceof PDFDict?lookup(objects,use.name):undefined;
      if(!(form instanceof PDFStream)) {unwalked.push({page:pageNumber,path,reason:`unresolvable XObject ${use.name}`});continue;}
      if(String(lookup(form.dict,'Subtype'))!=='/Form' || ancestors.has(form))continue;
      const nested=lookup(form.dict,'Resources');
      scope(nested instanceof PDFDict?nested:resources,[streamBytes(form)],pageNumber,[...path,use.name],new Set([...ancestors,form]));
    }
    for(const glyph of walk.glyphs) {
      shown++;
      const font=fonts.find(f=>matching(f,glyph.fontName))!;
      const hex=glyph.code.toString(16).padStart(glyph.byteLength*2,'0'),cluster=font.codeToUnicode.get(hex);
      const candidates=cluster?font.encodable.get(cluster):undefined;
      const mapped=candidates?.some(c=>codeHex(c)===hex) ?? false;
      if(!mapped) {
        rejected++;checks.push({page:pageNumber,path,font:glyph.fontName,code:hex,cluster,status:'rejected',reason:font.missing.find(m=>m.code===hex)?.reason ?? font.missing.find(m=>!m.code)?.reason ?? 'no Unicode mapping'});continue;
      }
      const result=font.canEncode(cluster!,{preferredCodes:[hexBytes(hex)]});
      const ok=result.ok && result.codes.length===1 && codeHex(result.bytes)===hex;
      if(ok)verified++;else failures++;
      checks.push({page:pageNumber,path,font:glyph.fontName,code:hex,cluster,status:ok?'round-trip':'FAILED'});
    }
  };
  for(const [i,page] of document.getPages().entries()) {
    const content=lookup(page.node,'Contents');
    const parts=content instanceof PDFArray?Array.from({length:content.size()},(_,j)=>streamBytes(content.lookup(j))):content?[streamBytes(content)]:[];
    scope(page.node.Resources(),parts,i+1,[],new Set());
  }
  totalShown+=shown;totalVerified+=verified;totalRejected+=rejected;
  const report={fixture,command:paths.length?`bun scripts/font-coverage/report.ts ${paths.join(' ')}`:'bun scripts/font-coverage/report.ts',
    shown,verified,rejected,unwalked,checks,fonts:fonts.map(f=>({objectRef:f.objectRef,resources:f.resources,subtype:f.subtype,baseFont:f.baseFont,subsetTag:f.subsetTag,
      encodingKind:f.encodingKind,vertical:f.vertical,verification:f.verification,warnings:f.warnings,missing:f.missing,
      encodable:Object.fromEntries([...f.encodable].map(([text,codes])=>[text,codes.map(codeHex)]))}))};
  await writeFile(resolve(destination,`${fixture}.json`),JSON.stringify(report,null,2)+'\n');
  if(!paths.length)await writeFile(resolve(destination,`${fixture}.pdf`),bytes);
  console.log(`${fixture}: ${shown} shown, ${verified} round trips, ${rejected} refused, ${unwalked.length} unwalked scopes`);
}
await writeFile(resolve(destination,paths.length?'summary-input.json':'summary-generated.json'),JSON.stringify({fixtures:fixtures.size,shown:totalShown,verified:totalVerified,rejected:totalRejected,failures},null,2)+'\n');
console.log(`Artifacts: ${destination}; ${failures} failed round trips`);
if(failures)process.exitCode=1;
