// Reproduce: bun scripts/pdf-inplace/type1-wiring.ts
// Bounded synthetic export probe; never downloads or runs the corpus.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {type1Fixture} from '../../src/pdf/export/contentText/type1Wiring.test-support';
import {model,overlay} from '../../src/pdf/export/contentText/fixtures.test-support';
import {exportPdf} from '../../src/pdf/export/exportPdf';
import {inspectRunPage} from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../../src/pdf/export/contentStreamEdit/tokenizer';
import {stage5Type1} from '../../src/pdf/export/fontCoverage/type1Support';
import {auditCorpusSample} from '../pdf-corpus/oracle';
import {openPdfium} from './nativePdfium';

const directory='test-artifacts/type1-wiring';await mkdir(directory,{recursive:true});
const native=openPdfium(resolve(process.env.SHIORI_PDFIUM_DIR??'vendor/pdfium/linux-x64/lib','libpdfium.so'));
const coverageOptions={sourceReuse:true};
try {
  const cases=[];
  for(const [name,text,mode] of [['shorter','AA','in-place'],['permutation','BABA','in-place'],['missing','AZAA','fallback-font']] as const) {
    const f=await type1Fixture({stream:'BT /F1 10 Tf 50 100 Td (ABBA) Tj ET'});
    const edit=overlay({originalText:'ABBA',text,rect:{x:49,y:98,w:26,h:10},coverRects:[{x:49,y:98,w:26,h:10}]});
    const before=await f.doc.save(),loads:string[]=[];
    const result=await exportPdf(before,model([edit]),{mode:'flatten',stage5Type1:coverageOptions,
      inPlaceFallback:{loadFont:async font=>{loads.push(font);return new Uint8Array(await readFile(`node_modules/@docx-editor.dev/fonts/assets/${font}`));}}});
    assert.equal(result.contentTextOutcomes?.[0]?.mode,mode,JSON.stringify(result.contentTextOutcomes));
    if(mode==='in-place')assert.equal(loads.length,0);
    await writeFile(`${directory}/${name}.before.pdf`,before);await writeFile(`${directory}/${name}.after.pdf`,result.bytes);
    await writeFile(`${directory}/${name}.edit.json`,JSON.stringify({edit,stage5Type1:coverageOptions},null,2));
    const audited=await auditCorpusSample(native,name,directory,edit,coverageOptions);
    if(name==='missing') {
      const output=await PDFDocument.load(result.bytes),source=inspectRunPage(output.getPage(0));assert(source.ok);
      let resource='',fallbackScalars=0;
      for(const op of tokenizeContentStream(source.bytes)) {
        if(op.operator==='Tf'&&op.operands[0]?.kind==='name')resource=op.operands[0].value;
        if(op.operator==='TJ'&&op.operands[0]?.kind==='array')for(const item of op.operands[0].items) {
          if(item.kind==='string'&&resource.startsWith('ShioriFb'))fallbackScalars+=item.bytes.length/2;
        }
      }
      assert.equal(fallbackScalars,1,'only Z may use the fallback font');
    }
    cases.push({name,outcome:result.contentTextOutcomes?.[0],loads,audited});
  }
  const conflict=await type1Fixture({differences:[65,'B','B']}),loads:string[]=[];
  const refused=await exportPdf(await conflict.doc.save(),model([overlay({originalText:'AB',text:'BA'})]),{
    mode:'flatten',stage5Type1:coverageOptions,inPlaceFallback:{loadFont:async name=>{loads.push(name);throw Error('terminal conflict reached fallback');}},
  });
  assert.equal(loads.length,0);assert.equal(refused.contentTextOutcomes?.[0]?.mode,'overlay');
  assert(refused.contentTextOutcomes?.[0]?.detail?.includes('glyph-identity-conflict'));
  assert.deepEqual(stage5Type1,{sourceReuse:false,standard14Afm:false});
  const report={command:'bun scripts/pdf-inplace/type1-wiring.ts',stage5Type1:coverageOptions,productionDefaults:stage5Type1,cases,refusal:refused.contentTextOutcomes?.[0]};
  await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({cases:cases.length,refusal:report.refusal,report:`${directory}/report.json`}));
} finally {native.close();}
