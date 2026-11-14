import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { codeHex } from '../../src/pdf/export/fontCoverage/types';
import { coverageFixtures } from './fixtures';
import { expectedRows } from './expectations';
import { inspectCoverage } from './inspect';

const destination=resolve('test-artifacts/font-coverage');
await mkdir(destination,{recursive:true});
const paths=process.argv.slice(2);
const fixtures=paths.length?new Map(await Promise.all(paths.map(async p=>[basename(p,'.pdf'),new Uint8Array(await Bun.file(p).arrayBuffer())] as const))):await coverageFixtures();
const summary={fixtures:fixtures.size,shown:0,verified:0,rejected:0,failedRoundTrips:0,unwalked:0,expectationMismatches:0,failures:0};
for(const [name,bytes] of fixtures) {
  const fixture=`${paths.length?'input':'generated'}-${name}`;
  const document=await PDFDocument.load(bytes);
  const inspected=inspectCoverage(document,paths.length?undefined:expectedRows(name));
  const {fonts,shown,verified,rejected,unwalked,expectationMismatches,failedRoundTrips,failures}=inspected;
  summary.shown+=shown;summary.verified+=verified;summary.rejected+=rejected;
  summary.failedRoundTrips+=failedRoundTrips;summary.failures+=failures;
  summary.unwalked+=unwalked.length;summary.expectationMismatches+=expectationMismatches.length;
  const report={...inspected,fixture,command:paths.length?`bun scripts/font-coverage/report.ts ${paths.join(' ')}`:'bun scripts/font-coverage/report.ts',
    fonts:fonts.map(f=>({objectRef:f.objectRef,resources:f.resources,subtype:f.subtype,baseFont:f.baseFont,subsetTag:f.subsetTag,
      encodingKind:f.encodingKind,vertical:f.vertical,verification:f.verification,warnings:f.warnings,missing:f.missing,
      glyphIds:Object.fromEntries(f.glyphIds),encodable:Object.fromEntries([...f.encodable].map(([text,codes])=>[text,codes.map(codeHex)]))}))};
  await writeFile(resolve(destination,`${fixture}.json`),JSON.stringify(report,null,2)+'\n');
  if(!paths.length)await writeFile(resolve(destination,`${fixture}.pdf`),bytes);
  console.log(`${fixture}: ${shown} shown, ${verified} round trips, ${rejected} refused, ${unwalked.length} unwalked scopes, ${expectationMismatches.length} expectation mismatches`);
  for(const mismatch of expectationMismatches)console.error(mismatch);
}
await writeFile(resolve(destination,paths.length?'summary-input.json':'summary-generated.json'),JSON.stringify(summary,null,2)+'\n');
console.log(`Artifacts: ${destination}; ${summary.failedRoundTrips} failed round trips; ${summary.failures} total failures`);
if(summary.failures)process.exitCode=1;
