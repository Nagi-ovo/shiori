// Re-audit the official samples of a sealed corpus run without re-running
// the corpus. The samples named in report.json `.oracle` are copied from
// <samplesDir> into <outDir> first, so the sealed directory is never written.
//   bun scripts/pdf-corpus/reauditSamples.ts <report.json> <samplesDir> <outDir>
// Writes <outDir>/reaudit.json: per sample the sealed verdict and the new
// legacy (gate) and corrected verdicts. Exit code follows the legacy verdict.
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {auditCorpusSample} from './oracle';
import {oracleVerdicts} from './oracleVerdict';
const [reportPath,samples,out]=process.argv.slice(2);
if(!reportPath||!samples||!out)throw Error('usage: bun scripts/pdf-corpus/reauditSamples.ts <report.json> <samplesDir> <outDir>');
const sealed=(JSON.parse(await readFile(reportPath,'utf8')).oracle as {name:string;passed:boolean;error?:string}[]);
await mkdir(out,{recursive:true});
const native=openPdfium(resolve(process.env.SHIORI_PDFIUM_DIR??'vendor/pdfium/linux-x64/lib','libpdfium.so'));
const results=[];
try{
 for(const {name,passed:sealedPassed,error:sealedError} of sealed){
  for(const suffix of ['before.pdf','after.pdf','edit.json'])await copyFile(join(samples,`${name}.${suffix}`),join(out,`${name}.${suffix}`));
  const metadata=JSON.parse(await readFile(join(out,`${name}.edit.json`),'utf8'));
  let verdict;
  try{const checked=await auditCorpusSample(native,name,out,metadata.overlay,metadata.stage5Type1,metadata.stage5Reflow,metadata.row.outcome.reflow,metadata.row.outcome);
   verdict={passed:checked.passed,legacyPassed:checked.legacyPassed,correctedPassed:checked.correctedPassed};}
  catch(error){verdict={passed:false,...oracleVerdicts(error),error:String(error).slice(0,400)};process.exitCode=1;}
  results.push({name,mode:metadata.row.outcome.mode,manifest:Boolean(metadata.row.outcome.reflow),sealedPassed,...(sealedError?{sealedError:sealedError.slice(0,120)}:{}),...verdict});
  console.log(name,JSON.stringify(verdict).slice(0,200));
 }
}finally{native.close();}
await writeFile(join(out,'reaudit.json'),JSON.stringify(results,null,2));
const count=(key:'passed'|'legacyPassed'|'correctedPassed')=>results.filter(r=>r[key]===true).length;
console.log(`sealed ${results.filter(r=>r.sealedPassed).length}/${results.length}; legacy ${count('legacyPassed')}/${results.length}; corrected ${count('correctedPassed')}/${results.length}`);
