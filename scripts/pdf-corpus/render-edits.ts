// Native PNG evidence from saved corpus pairs; never runs the corpus or fetches.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {openPdfium} from '../pdf-inplace/nativePdfium';
import {cropPage, encodePng, pairImages} from './render-images';
import {newMode, readSamples, selectSamples, editRects, type EditMetadata, type RenderSample} from './render-samples';
import type {Rotation} from '../../src/pdf/model/types';

const {values} = parseArgs({options: {
  samples: {type: 'string', default: 'test-artifacts/pdf-corpus/samples'},
  out: {type: 'string', default: 'test-artifacts/pdf-corpus/renders'},
  before: {type: 'string'}, after: {type: 'string'}, edit: {type: 'string'},
  page: {type: 'string', default: '0'}, margin: {type: 'string', default: '8'}, help: {type: 'boolean'},
}});
if (values.help) {
  console.log('bun scripts/pdf-corpus/render-edits.ts [--samples DIR] [--out DIR]\n' +
    '  [--before FILE --after FILE --edit JSON] [--page 0] [--margin 8]\n' +
    'Page is the zero-based saved-PDF page; margin is in PDF points. Pair: before left, after right.');
  process.exit(0);
}
const out = resolve(values.out), pageIndex = Number(values.page), margin = Number(values.margin);
assert(Number.isInteger(pageIndex) && pageIndex >= 0, '--page must be a nonnegative integer');
assert(Number.isFinite(margin) && margin >= 0, '--margin must be a nonnegative number');
const explicit = Boolean(values.before || values.after || values.edit);
assert(!explicit || (values.before && values.after && values.edit), 'provide --before, --after and --edit together');
await mkdir(out, {recursive: true});
const notes: string[] = [];
const note = (message: string) => { notes.push(message); console.log(message); };

async function smokeSample(): Promise<RenderSample> {
  assert.equal(pageIndex, 0, 'the built-in smoke PDF has only page 0');
  const name = 'smoke-fixture', before = join(out, `${name}.before.pdf`), after = join(out, `${name}.after.pdf`);
  for (const [path, text] of [[before, 'Matching fonts keep text readable.'], [after, 'Matching fonts make edits readable.']]) {
    const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 160]);
    page.drawText('Synthetic renderer smoke fixture', {x: 24, y: 130, size: 10, font});
    page.drawText(text!, {x: 24, y: 90, size: 13, font});
    await writeFile(path!, await doc.save());
  }
  const metadata: EditMetadata = {rect: {x: 20, y: 82, w: 250, h: 25},
    row: {category: 'synthetic', outcome: {mode: 'in-place'}}};
  const edit = join(out, `${name}.edit.json`);
  await writeFile(edit, JSON.stringify(metadata, null, 2));
  return {name, before, after, edit, metadata, smoke: true};
}

let samples: RenderSample[];
if (explicit) {
  const edit = resolve(values.edit!);
  samples = [{name: basename(edit).replace(/(?:\.edit)?\.json$/, ''), before: resolve(values.before!), after: resolve(values.after!),
    edit, metadata: JSON.parse(await readFile(edit, 'utf8'))}];
} else {
  samples = selectSamples(await readSamples(resolve(values.samples)));
  if (!samples.length) note('no samples yet: no accepted corpus pairs found; rendering a synthetic smoke pair.');
  const chinese = samples.find(s => s.metadata.row?.category === 'chinese');
  const latex = samples.find(s => s.metadata.row?.category === 'latex');
  const word = samples.find(s => ['word', 'tagged'].includes(s.metadata.row?.category ?? ''));
  if (!chinese || !newMode(chinese)) note('No Chinese substituted/reflowed sample yet; available older accepted evidence is labeled with its actual mode.');
  if (!latex) note('No accepted LaTeX sample yet.');
  if (!word) note('No accepted Word or GSA tagged sample yet.');
  if (!chinese || !newMode(chinese) || !latex || !word) samples.push(await smokeSample());
}

const native = openPdfium(resolve(process.env.SHIORI_PDFIUM_DIR ?? 'vendor/pdfium/linux-x64/lib', 'libpdfium.so'));
const renders = [];
try {
  for (const sample of samples) {
    const beforeBytes = await readFile(sample.before), afterBytes = await readFile(sample.after);
    const beforeDoc = await PDFDocument.load(beforeBytes), afterDoc = await PDFDocument.load(afterBytes);
    const beforePage = beforeDoc.getPage(pageIndex), afterPage = afterDoc.getPage(pageIndex);
    assert.deepEqual(beforePage.getCropBox(), afterPage.getCropBox(), 'before/after page boxes differ');
    const rotation = ((beforePage.getRotation().angle % 360 + 360) % 360) as Rotation;
    assert.equal(rotation, (afterPage.getRotation().angle % 360 + 360) % 360, 'before/after rotations differ');
    const beforeNative=native.inspectPage(beforeBytes,pageIndex,true),afterNative=native.inspectPage(afterBytes,pageIndex,true);
    const rects = editRects(sample.metadata,{before:beforeNative.glyphs,after:afterNative.glyphs});
    const before = cropPage(beforeNative, rects, rotation, margin);
    const after = cropPage(afterNative, rects, rotation, margin);
    assert.deepEqual(before.bounds, after.bounds, 'before/after raster crops differ');
    const mode = sample.metadata.row?.outcome?.mode ?? 'explicit';
    const name = `${sample.name}-${mode}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const files = {before: join(out, `${name}.before.png`), after: join(out, `${name}.after.png`), pair: join(out, `${name}.pair.png`)};
    await writeFile(files.before, encodePng(before));
    await writeFile(files.after, encodePng(after));
    await writeFile(files.pair, encodePng(pairImages(before, after)));
    renders.push({name, category: sample.metadata.row?.category ?? 'explicit', mode, smoke: sample.smoke ?? false,
      before: sample.before, after: sample.after, edit: sample.edit, pageIndex, rotation, rects, crop: before.bounds,
      sha256: {before: createHash('sha256').update(beforeBytes).digest('hex'), after: createHash('sha256').update(afterBytes).digest('hex')}, files});
    console.log(`Rendered ${name}: ${files.pair}`);
  }
} finally { native.close(); }
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const command = ['bun', ...process.argv.slice(1)].map(quote).join(' ');
await writeFile(join(out, 'manifest.json'), JSON.stringify({dpi: 144, marginPt: margin, pairOrder: ['before', 'after'], command, notes, renders}, null, 2));
await writeFile(join(out, 'README.md'), `# Saved-PDF render evidence\n\nRun from the repository root:\n\n\`\`\`sh\n${command}\n\`\`\`\n\nPairs show before on the left and after on the right at 144 dpi.\nCrops include covers, paragraph bounds, the recorded reflow region and new/moved retypeset native ink, with ${margin} pt margin.\nSee manifest.json for source hashes, page, crop, filenames and missing-sample notices.\nSynthetic smoke pairs verify rendering only; they are not corpus acceptance evidence.\n\n${notes.join('\n\n')}\n`);
console.log(`Render manifest: ${join(out, 'manifest.json')}`);
