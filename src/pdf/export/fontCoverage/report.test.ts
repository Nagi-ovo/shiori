import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { inspectCoverage } from '../../../../scripts/font-coverage/inspect';
import { expectedRows } from '../../../../scripts/font-coverage/expectations';
import { coverageFixtures } from '../../../../scripts/font-coverage/fixtures';
import { lookup } from './pdfLibAdapter';
import { tinyTtf, format4Table } from './fixtures/programs';

async function fixture(name:string) {
  const bytes=(await coverageFixtures()).get(name);
  if(!bytes)throw new Error(`missing fixture ${name}`);
  return PDFDocument.load(bytes);
}
function font(document:PDFDocument):PDFDict {
  const fonts=lookup(document.getPage(0).node.Resources()!,'Font') as PDFDict;
  return lookup(fonts,'F1') as PDFDict;
}

test('generated expectation locks catch a dropped CIDToGIDMap',async()=>{
  const document=await fixture('cid-map');
  const children=lookup(font(document),'DescendantFonts') as PDFArray;
  (children.lookup(0) as PDFDict).delete(PDFName.of('CIDToGIDMap'));
  const report=inspectCoverage(document,expectedRows('cid-map'));
  expect(report.failures).toBeGreaterThan(0);
  expect(report.expectationMismatches.length).toBeGreaterThan(0);
});
test('wrong nonzero GID fails a locked row even when Unicode still round-trips',async()=>{
  const document=await fixture('format4');
  const descriptor=lookup(font(document),'FontDescriptor') as PDFDict;
  descriptor.set(PDFName.of('FontFile2'),document.context.register(document.context.flateStream(
    tinyTtf({maps:[{platform:3,encoding:1,entries:[],subtable:format4Table(3)}]}))));
  const report=inspectCoverage(document,expectedRows('format4'));
  expect(report.checks.find(row=>row.code==='53')).toMatchObject({status:'round-trip',gid:5});
  expect(report.failedRoundTrips).toBe(0);
  expect(report.failures).toBeGreaterThan(0);
  expect(report.expectationMismatches.length).toBeGreaterThan(0);
});
test('locked rows catch missing shows rather than accepting a smaller sample',async()=>{
  const document=await fixture('subset');
  document.getPage(0).node.set(PDFName.of('Contents'),document.context.register(document.context.flateStream('')));
  expect(inspectCoverage(document,expectedRows('subset')).failures).toBeGreaterThan(0);
});
test('a rejected odd-width ToUnicode entry does not make a simple font variable-width',async()=>{
  const document=await fixture('subset');
  font(document).set(PDFName.of('ToUnicode'),document.context.register(document.context.flateStream('2 beginbfchar <53> <0053> <0041> <0042> endbfchar')));
  document.getPage(0).node.set(PDFName.of('Contents'),document.context.register(document.context.flateStream('BT /F1 12 Tf <53> Tj ET')));
  const report=inspectCoverage(document);
  expect(report).toMatchObject({shown:1,verified:1,failures:0,unwalked:[]});
});
test('a failed parent walk still visits parsed Form invocations',async()=>{
  const document=await PDFDocument.create(),ctx=document.context,page=document.addPage();
  const f=ctx.register(ctx.obj({Type:'Font',Subtype:'Type1',BaseFont:'Helvetica',Encoding:'WinAnsiEncoding'}));
  const form=ctx.register(ctx.flateStream('BT /Inner 12 Tf <41> Tj ET',{Type:'XObject',Subtype:'Form',BBox:[0,0,20,20],Resources:{Font:{Inner:f}}}));
  page.node.set(PDFName.of('Resources'),ctx.obj({XObject:{Form:form}}));
  page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream('BT /Missing 12 Tf <41> Tj ET /Form Do')));
  const report=inspectCoverage(document);
  expect(report.failures).toBeGreaterThan(0);
  expect(report.unwalked.length).toBeGreaterThan(0);
  expect(report.checks).toContainEqual({page:1,path:['Form'],font:'Inner',code:'41',cluster:'A',status:'round-trip',gid:undefined});
});
test('report CLI exits nonzero for an unwalked scope',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'shiori-coverage-unwalked-'));
  try {
    const document=await PDFDocument.create(),ctx=document.context,page=document.addPage();
    page.node.set(PDFName.of('Contents'),ctx.register(ctx.flateStream('BT /Missing 12 Tf <41> Tj ET')));
    const input=join(directory,'unwalked.pdf');await writeFile(input,await document.save());
    const result=Bun.spawnSync(['bun',resolve('scripts/font-coverage/report.ts'),input],{cwd:directory,stdout:'pipe',stderr:'pipe'});
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain('unwalked');
  } finally {await rm(directory,{recursive:true,force:true});}
});
