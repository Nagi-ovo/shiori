// Rerun: bun scripts/pdf-inplace/surgical-first.ts
// Native library: SHIORI_PDFIUM_DIR or vendor/pdfium/linux-x64/lib.
import { PDFDocument, PDFName } from 'pdf-lib';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRunPage, replaceRunPage, resolveRunFonts } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import { type RunEdit } from '../../src/pdf/export/contentStreamEdit/replaceRun';
import { tokenizeContentStream } from '../../src/pdf/export/contentStreamEdit/tokenizer';
import { addFixtureAsciiMappings, sourceGlyphs, readSavedGlyphs, assertSavedGlyphs } from './oracleGlyphs';
import { checkNativeEvidence } from './checkNativeEvidence';
import { nativeOracle } from './nativeOracle';
import { negativeCases } from './negativeCases';
import { subsetFallbackCase } from './subsetFallbackCase';
import { wordSpacingCases } from './wordSpacingCases';
import { stage3Cases } from './stage3Cases';
import { previewCost } from './preview-cost';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const out = join(root, 'test-artifacts/pdf-inplace/surgical-first');
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const bytes = (s: string) => new TextEncoder().encode(s);
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
  { name: 'word-mcid', fixture: 'happy', old: 'Hello World', replacement: 'World Hello Again', tagged: true, box: [65, 685, 330, 730] },
  { name: 'suffix-relative', fixture: 'happy', old: 'Hello', replacement: 'Hi', custom: true, box: [65, 685, 150, 730] },
];
for (const c of cases) {
  const doc = await PDFDocument.load(await readFile(join(fixtures, `${c.fixture}.pdf`)), { updateMetadata: false });
  const page = doc.getPage(0);
  if (c.custom) page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(bytes('BT /F1 24 Tf 2 Tc 4 Tw 80 Tz 72 700 Td [(Hello) 120 ( suffix)] TJ ( tail) Tj 0 -40 Td (next) Tj ET'))));
  if (c.tagged) {
    const original = inspectRunPage(page);
    if (!original.ok) throw Error(original.reason);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(bytes(`/P <</MCID 0>> BDC
${new TextDecoder().decode(original.bytes)}
EMC`))));
  }
  addFixtureAsciiMappings(page);
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
  const savedBefore = await readSavedGlyphs(before);
  assertSavedGlyphs(beforeGlyphs, savedBefore.glyphs);
  const result = replaceRunPage(page, { sourceHash: source.sourceHash, edits: [edit], forceReencode: c.force, allowOverflow: true });
  if (!result.ok) throw Error(`${c.name}: ${result.reason}`);
  const after = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  await writeFile(join(out, afterName), after);
  const f = resolved.find(f => f.objectId === edit!.fontObject)!;
  const targetIndexes = beforeGlyphs.flatMap((g, i) => g.opIndex === edit!.opIndex && g.itemIndex === edit!.itemIndex ? [i] : []);
  const start = targetIndexes[0]!, n = targetIndexes.length;
  const changed = c.old !== c.replacement;
  for (const i of targetIndexes) beforeGlyphs[i]!.edited = changed;
  const inverse = new Map([...f.unicodeByCode].map(([code, unicode]) => [unicode, code]));
  const replacements = Array.from(c.replacement, unicode => ({ ...beforeGlyphs[start]!, code: inverse.get(unicode)!, unicode, edited: changed, replacement: true }));
  const afterGlyphs = [...beforeGlyphs];
  afterGlyphs.splice(start, n, ...replacements);
  const savedAfter = await readSavedGlyphs(after);
  assertSavedGlyphs(afterGlyphs, savedAfter.glyphs);
  // Keep the EXPECTED sequence separate from independently parsed saved codes.
  const observedBefore = savedBefore.glyphs.map((g, i) => ({ ...g, edited: beforeGlyphs[i]!.edited }));
  const observedAfter = savedAfter.glyphs.map((g, i) => ({ ...g, edited: afterGlyphs[i]!.edited, replacement: afterGlyphs[i]!.replacement }));
  manifest.push({ name: c.name, before: beforeName, after: afterName, beforeGlyphs: observedBefore, afterGlyphs: observedAfter,
    expectedAfterGlyphs: afterGlyphs, savedCodesVerified: true,
    fontHashes: hashes, editBox: c.box, required: c.replacement ? [c.replacement] : [], absent: changed ? [c.old] : [] });
}
manifest.push(...await negativeCases(out));
manifest.push(...await stage3Cases(out));
manifest.push(await subsetFallbackCase(out));
manifest.push(...await wordSpacingCases(out));
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const lib = join(process.env.SHIORI_PDFIUM_DIR ?? join(root, 'vendor/pdfium/linux-x64/lib'), 'libpdfium.so');
await nativeOracle(lib, out);
await checkNativeEvidence(lib, out);
await previewCost(out);
await nativeOracle(lib, out, true);
console.log(`Artifacts: ${out}`);
