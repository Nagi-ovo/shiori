// Rerun: bun scripts/pdf-inplace/surgical-first.ts
// Native library: SHIORI_PDFIUM_DIR or vendor/pdfium/linux-x64/lib.
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectRunPage, replaceRunPage, resolveRunFonts } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import { sourceFingerprint, type RunEdit } from '../../src/pdf/export/contentStreamEdit/replaceRun';
import { tokenizeContentStream } from '../../src/pdf/export/contentStreamEdit/tokenizer';
import { runToUnicode } from '../../src/pdf/export/contentStreamEdit/runToUnicode';
import { previewCost } from './preview-cost';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const out = join(root, 'test-artifacts/pdf-inplace/surgical-first');
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const bytes = (s: string) => new TextEncoder().encode(s);
const decode = (s: PDFRawStream) => s.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(s).decode() : s.getContents();
type Glyph = { fontObject: string; code: number; unicode: string; opIndex: number; itemIndex: number; edited: boolean };
function sourceGlyphs(doc: PDFDocument, content: Uint8Array, resources: PDFDict, hashes: Record<string, string>): Glyph[] {
  let font = '';
  const stack: string[] = [], result: Glyph[] = [];
  const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
  for (const [opIndex, op] of tokenizeContentStream(content).entries()) {
    if (op.operator === 'q') stack.push(font);
    if (op.operator === 'Q') font = stack.pop()!;
    if (op.operator === 'Tf' && op.operands[0]?.kind === 'name') font = op.operands[0].value;
    if (op.operator === 'Do' && op.operands[0]?.kind === 'name') {
      const object = resources.lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of(op.operands[0].value), PDFRawStream);
      const nested = sourceGlyphs(doc, decode(object), object.dict.lookup(PDFName.of('Resources'), PDFDict), hashes);
      result.push(...nested.map(g => ({ ...g, opIndex: -1 })));
    }
    if (!['Tj', 'TJ'].includes(op.operator)) continue;
    const ref = fonts.get(PDFName.of(font))!;
    const dict = doc.context.lookup(ref, PDFDict);
    const size = dict.lookup(PDFName.of('Subtype'), PDFName).decodeText() === 'Type0' ? 2 : 1;
    const cmap = runToUnicode(new TextDecoder().decode(decode(dict.lookup(PDFName.of('ToUnicode'), PDFRawStream))), size)!;
    if (!cmap) throw Error('fixture missing mapping');
    const descendant = size === 2 ? dict.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict) : dict;
    const descriptor = descendant.lookup(PDFName.of('FontDescriptor'), PDFDict);
    const program = descriptor.lookupMaybe(PDFName.of('FontFile2'), PDFRawStream) ?? descriptor.lookup(PDFName.of('FontFile3'), PDFRawStream);
    hashes[ref.toString()] = sourceFingerprint(decode(program));
    const items = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : op.operands;
    for (const [itemIndex, item] of items.entries()) {
      if (item.kind !== 'string') continue;
      for (let i = 0; i < item.bytes.length; i += size) {
        const code = size === 1 ? item.bytes[i]! : item.bytes[i]! * 256 + item.bytes[i + 1]!;
        const unicode = cmap.get(code);
        if (!unicode || Array.from(unicode).length !== 1) throw Error('fixture code not one scalar');
        result.push({ fontObject: ref.toString(), code, unicode, opIndex, itemIndex: op.operator === 'TJ' ? itemIndex : -1, edited: false });
      }
    }
  }
  return result;
}
await mkdir(out, { recursive: true });
for (const report of ['report.json', 'preview-cost.json', 'preview-native.json']) await rm(join(out, report), { force: true });
await writeFile(join(out, 'rerun.txt'), 'bun scripts/pdf-inplace/surgical-first.ts\n');
const manifest = [];
const cases = [
  { name: 'identity', fixture: 'happy', old: 'Hello World', replacement: 'Hello World', force: false, box: [65, 685, 260, 730] },
  { name: 'forced-roundtrip', fixture: 'kerning', old: 'A', replacement: 'A', force: true, box: [65, 685, 260, 735] },
  { name: 'shorter', fixture: 'happy', old: 'Hello World', replacement: 'Hello', box: [65, 685, 290, 730] },
  { name: 'longer', fixture: 'happy', old: 'Hello World', replacement: 'World Hello Again', box: [65, 685, 330, 730] },
  { name: 'delete', fixture: 'happy', old: 'Hello World', replacement: '', box: [65, 685, 260, 730] },
  { name: 'tracked', fixture: 'kerning', old: 'Tracked words here', replacement: 'Tracked words gone', box: [65, 625, 330, 665] },
  { name: 'background', fixture: 'background', old: 'Blue Band Title', replacement: 'Blue Band Text', box: [65, 685, 300, 735] },
  { name: 'subset', fixture: 'subset', old: 'Liberation', replacement: 'Liberator', box: [15, 140, 170, 175] },
  { name: 'suffix-relative', fixture: 'happy', old: 'Hello', replacement: 'Hi', custom: true, box: [65, 685, 150, 730] },
];
for (const c of cases) {
  const doc = await PDFDocument.load(await readFile(join(fixtures, `${c.fixture}.pdf`)), { updateMetadata: false });
  const page = doc.getPage(0);
  const fonts = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
  for (const [, ref] of fonts.entries()) {
    const font = doc.context.lookup(ref, PDFDict);
    if (!font.has(PDFName.of('ToUnicode'))) font.set(PDFName.of('ToUnicode'), doc.context.register(doc.context.stream(bytes('1 beginbfrange <20> <7e> <0020> endbfrange'))));
  }
  if (c.custom) page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(bytes('BT /F1 24 Tf 2 Tc 4 Tw 80 Tz 72 700 Td [(Hello) 120 ( suffix)] TJ ( tail) Tj 0 -40 Td (next) Tj ET'))));
  const source = inspectRunPage(page);
  if (!source.ok) throw Error(source.reason);
  const resolved = resolveRunFonts(page);
  const hashes: Record<string, string> = {};
  const beforeGlyphs = sourceGlyphs(doc, source.bytes, page.node.Resources()!, hashes);
  let edit: RunEdit | undefined;
  for (const [opIndex, op] of tokenizeContentStream(source.bytes).entries()) {
    const items = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : op.operator === 'Tj' ? op.operands : [];
    for (const [i, item] of items.entries()) {
      if (item.kind !== 'string') continue;
      const group = beforeGlyphs.filter(g => g.opIndex === opIndex && g.itemIndex === (op.operator === 'TJ' ? i : -1));
      if (group.map(g => g.unicode).join('') !== c.old || edit) continue;
      const f = resolved.find(f => f.objectId === group[0]?.fontObject)!;
      edit = { fontResource: f.resourceName, fontObject: f.objectId, opIndex, itemIndex: op.operator === 'TJ' ? i : -1, expected: item.bytes, byteStart: 0, byteEnd: item.bytes.length, replacement: c.replacement };
    }
  }
  if (!edit) throw Error(`target not found: ${c.name}`);
  const beforeName = `${c.name}.before.pdf`, afterName = `${c.name}.after.pdf`;
  const before = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  await writeFile(join(out, beforeName), before);
  const result = replaceRunPage(page, { sourceHash: source.sourceHash, edits: [edit], forceReencode: c.force });
  if (!result.ok) throw Error(`${c.name}: ${result.reason}`);
  const after = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  await writeFile(join(out, afterName), after);
  const f = resolved.find(f => f.objectId === edit!.fontObject)!;
  const targetIndexes = beforeGlyphs.flatMap((g, i) => g.opIndex === edit!.opIndex && g.itemIndex === edit!.itemIndex ? [i] : []);
  const start = targetIndexes[0]!, n = targetIndexes.length;
  const changed = c.old !== c.replacement;
  for (const i of targetIndexes) beforeGlyphs[i]!.edited = changed;
  const inverse = new Map([...f.unicodeByCode].map(([code, unicode]) => [unicode, code]));
  const replacements = Array.from(c.replacement, unicode => ({ ...beforeGlyphs[start]!, code: inverse.get(unicode)!, unicode, edited: changed }));
  const afterGlyphs = [...beforeGlyphs];
  afterGlyphs.splice(start, n, ...replacements);
  manifest.push({ name: c.name, before: beforeName, after: afterName, beforeGlyphs, afterGlyphs,
    fontHashes: hashes, editBox: c.box, required: c.replacement ? [c.replacement] : [], absent: changed ? [c.old] : [] });
}
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const lib = join(process.env.SHIORI_PDFIUM_DIR ?? join(root, 'vendor/pdfium/linux-x64/lib'), 'libpdfium.so');
const oracle = spawnSync('python3', [fileURLToPath(new URL('./native_oracle.py', import.meta.url)), lib, out], { stdio: 'inherit' });
if (oracle.status !== 0) throw Error('native oracle failed');
await previewCost(out);
const preview = spawnSync('python3', [fileURLToPath(new URL('./native_oracle.py', import.meta.url)), lib, out, '--preview'], { stdio: 'inherit' });
if (preview.status !== 0) throw Error('native preview oracle failed');
console.log(`Artifacts: ${out}`);
