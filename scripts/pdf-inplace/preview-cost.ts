// REPORT ONLY: unencrypted classic-xref prototype, deliberately not exported
// to application code. Append the changed page and its new content stream.
import { PDFDocument, PDFName, PDFRef, type PDFObject } from 'pdf-lib';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, hostname, platform, release } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectRunPage, replaceRunPage, resolveRunFonts } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import { tokenizeContentStream } from '../../src/pdf/export/contentStreamEdit/tokenizer';

const ascii = new TextEncoder();
function serialize(value: PDFObject): Uint8Array {
  const result = new Uint8Array(value.sizeInBytes());
  value.copyBytesInto(result, 0);
  return result;
}
function tail(base: Uint8Array, objects: { ref: PDFRef; value: PDFObject }[], root: PDFRef, size: number) {
  const oldXref = Number(new TextDecoder('latin1').decode(base.slice(-100)).match(/startxref\s+(\d+)/)?.[1]);
  if (!oldXref) throw Error('prototype requires classic baseline xref');
  const parts = [base, ascii.encode('\n')];
  let offset = base.length + 1;
  const entries: { ref: PDFRef; offset: number }[] = [];
  for (const { ref, value } of objects.sort((a, b) => a.ref.objectNumber - b.ref.objectNumber)) {
    entries.push({ ref, offset });
    const header = ascii.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    const body = serialize(value), end = ascii.encode('\nendobj\n');
    parts.push(header, body, end);
    offset += header.length + body.length + end.length;
  }
  const xref = offset;
  const table = 'xref\n' + entries.map(({ ref, offset }) => `${ref.objectNumber} 1\n${String(offset).padStart(10, '0')} ${String(ref.generationNumber).padStart(5, '0')} n \n`).join('') +
    `trailer\n<< /Size ${size} /Root ${root} /Prev ${oldXref} >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(ascii.encode(table));
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { result.set(p, at); at += p.length; }
  return result;
}
export async function previewCost(out: string) {
  const source = await PDFDocument.load(await readFile(join(out, 'shorter.before.pdf')), { updateMetadata: false });
  const fixture = await PDFDocument.create();
  const pages = await fixture.copyPages(source, Array(300).fill(0));
  pages.forEach(p => fixture.addPage(p));
  const baseline = await fixture.save({ useObjectStreams: false });
  await writeFile(join(out, 'preview-300.before.pdf'), baseline);
  const doc = await PDFDocument.load(baseline, { updateMetadata: false });
  const page = doc.getPage(0), info = inspectRunPage(page);
  if (!info.ok) throw Error(info.reason);
  const fonts = resolveRunFonts(page), font = fonts[0]!;
  const opIndex = tokenizeContentStream(info.bytes).findIndex(op => op.operator === 'Tj');
  const result = replaceRunPage(page, { sourceHash: info.sourceHash, edits: [{
    opIndex, itemIndex: -1, fontResource: font.resourceName, fontObject: font.objectId,
    byteStart: 0, byteEnd: 11, expected: ascii.encode('Hello World'), replacement: 'Hello',
  }] });
  if (!result.ok) throw Error(result.reason);
  const contentRef = page.node.get(PDFName.of('Contents')) as PDFRef;
  const objects = [{ ref: page.ref, value: page.node }, { ref: contentRef, value: doc.context.lookup(contentRef)! }];
  const full: number[] = [], incremental: number[] = [];
  let fullBytes = new Uint8Array(), tailBytes = new Uint8Array();
  // One warmup, then seven interleaved measurements. Both include allocating
  // the complete byte output; disk IO and parsing are excluded from both.
  for (let i = 0; i < 8; i++) {
    let start = performance.now();
    fullBytes = await doc.save();
    if (i) full.push(performance.now() - start);
    start = performance.now();
    tailBytes = tail(baseline, objects, doc.context.trailerInfo.Root!, doc.context.largestObjectNumber + 1);
    if (i) incremental.push(performance.now() - start);
  }
  const fullPath = join(out, 'preview-300.full.pdf'), tailPath = join(out, 'preview-300.incremental.pdf');
  await writeFile(fullPath, fullBytes);
  await writeFile(tailPath, tailBytes);
  for (const path of [fullPath, tailPath]) {
    const check = spawnSync('qpdf', ['--check', path], { encoding: 'utf8' });
    if (check.status !== 0) throw Error(check.stdout + check.stderr);
    const verify = await PDFDocument.load(await readFile(path));
    if (verify.getPageCount() !== 300) throw Error('preview page count');
    for (const index of [0, 299]) {
      const content = inspectRunPage(verify.getPage(index));
      if (!content.ok) throw Error(content.reason);
      const expected = index === 0 ? '48656c6c6f' : '(Hello World)';
      if (!new TextDecoder().decode(content.bytes).includes(expected)) throw Error('preview changed wrong page');
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = { reportOnly: true, scope: 'unencrypted classic xref; serialization only; not app code',
    machine: { hostname: hostname(), platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, bun: Bun.version },
    pages: 300, fullSaveOptions: { useObjectStreams: true }, incrementalBaseline: 'classic xref', warmups: 1, runs: 7, fullSaveMs: full, incrementalTailMs: incremental,
    medianFullSaveMs: median(full), medianIncrementalTailMs: median(incremental),
    baselineBytes: baseline.length, fullBytes: fullBytes.length, incrementalBytes: tailBytes.length,
    appendedBytes: tailBytes.length - baseline.length, qpdf: 'both clean', pageIsolation: 'first changed, last unchanged' };
  await writeFile(join(out, 'preview-cost.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
