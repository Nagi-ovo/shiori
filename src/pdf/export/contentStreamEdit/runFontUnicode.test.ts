import {expect, test} from 'bun:test';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {PDFDict, PDFDocument, PDFName} from 'pdf-lib';
import {format4Table, format12Table, tinyTtf} from '../fontCoverage/fixtures/programs';
import {namedTtf, ttfTables} from '../fontCoverage/symbolicCmap.test-support';
import {inspectRunPage, replaceRunPage, resolveRunFonts} from './replaceRunPage';
import {streamReflowEvidence} from '../contentText/reflowEvidence';
import {planStreamReflow} from '../contentText/reflowAuto';
import {overlay} from '../contentText/fixtures.test-support';
import {type1Fixture} from '../contentText/type1Wiring.test-support';
import {fontInputFromDict} from '../fontCoverage/pdfLibAdapter';
import {recoverRunUnicode} from './runFontUnicode';

async function fixture(toUnicode?: string, differences?: Record<number, string>) {
  const doc = await PDFDocument.create(), ctx = doc.context, page = doc.addPage([300, 200]);
  const font = ctx.obj({Type:'Font', Subtype:'TrueType', BaseFont:'Tiny', FirstChar:0, LastChar:255,
    Widths:Array(256).fill(500), Encoding:differences ? {BaseEncoding:'WinAnsiEncoding',
      Differences:Object.entries(differences).flatMap(([code, name]) => [+code, PDFName.of(name)])} : 'WinAnsiEncoding',
    FontDescriptor:ctx.register(ctx.obj({Flags:32, Ascent:800, Descent:-200, FontBBox:[0, 0, 500, 800],
      FontFile2:ctx.register(ctx.flateStream(tinyTtf({maps:[{platform:3, encoding:1,
        entries:[[65, 7], [101, 2], [32, 4]]}]})))})),
    ...(toUnicode === undefined ? {} : {ToUnicode:ctx.register(ctx.flateStream(toUnicode))})});
  const ref = ctx.register(font);
  page.node.set(PDFName.of('Resources'), ctx.obj({Font:{F1:ref}}));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(
    '/P <</MCID 0>> BDC BT /F1 10 Tf 14 TL 50 150 Td (Ae Ae) Tj ET EMC')));
  const source = inspectRunPage(page); if (!source.ok) throw Error(source.reason);
  return {doc, page, font, ref, source};
}

for (const toUnicode of [undefined, '', '1 beginbfchar <41> <0041> endbfchar',
  '3 beginbfchar <41> <FFFD> <65> <FFFD> <20> <FFFD> endbfchar']) {
  test(`recovers same-BT tagged line labels with ToUnicode ${JSON.stringify(toUnicode)}`, async () => {
    const f = await fixture(toUnicode), before = f.font.toString();
    const fonts = resolveRunFonts(f.page), font = fonts[0]!;
    expect([65, 101, 32].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ']);
    const evidence = streamReflowEvidence(f.page, f.source.bytes, fonts, 5);
    if(!evidence.ok)throw Error(evidence.detail);
    expect(evidence.lines.map(line => line.shows.map(show => show.unicode).join(''))).toEqual(['Ae Ae']);
    expect(evidence.source.map(glyph => [...glyph.code])).toEqual([[65], [101], [32], [65], [101]]);
    expect(f.font.toString()).toBe(before);
    expect(inspectRunPage(f.page)).toEqual(f.source);
  });
}

test('uses Encoding Differences and AGL without assuming source code is Unicode', async () => {
  const f = await fixture('1 beginbfchar <01> <FFFD> endbfchar', {1:'A.alt', 2:'uni0065', 3:'space', 4:'unknownGlyph'});
  const font = resolveRunFonts(f.page)[0]!;
  expect([1, 2, 3, 4].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ', undefined]);
});

test('uses actual symbolic cmap/post names instead of PDF Encoding guesses', async () => {
  const f = await fixture();
  const descriptor = f.font.lookup(PDFName.of('FontDescriptor'), PDFDict);
  descriptor.set(PDFName.of('Flags'), f.doc.context.obj(4));
  descriptor.set(PDFName.of('FontFile2'), f.doc.context.register(f.doc.context.flateStream(
    namedTtf({maps:[{platform:3, encoding:0, entries:[[0xf041, 7]]}]}))));
  const font = resolveRunFonts(f.page)[0]!;
  expect(font.unicodeByCode.get(65)).toBe('A');
  expect(font.unicodeByCode.get(101)).toBeUndefined();
});

test('unproved replacement characters stay unknown', async () => {
  const f = await fixture('2 beginbfchar <42> <FFFD> <04> <FFFD> endbfchar', {4:'unknownGlyph'});
  const font = resolveRunFonts(f.page)[0]!;
  expect(font.unicodeByCode.has(66)).toBe(false); // B selects .notdef in this subset.
  expect(font.unicodeByCode.has(4)).toBe(false);
});

for (const toUnicode of ['2 beginbfchar <41> <0041> endbfchar',
  '2 beginbfchar <41> <0041> <41> <0041> endbfchar']) test('refused ToUnicode recovers labels without edit authority: ' + toUnicode, async () => {
  const f = await fixture(toUnicode), font = resolveRunFonts(f.page)[0]!;
  expect([65, 101, 32].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ']);
  expect(font.canEncode!('A').ok).toBe(false);
  expect(() => font.assertSource!([Uint8Array.of(65)])).toThrow('requires a ToUnicode');
});

test.each(['<0000> <FFFF>', '<000000> <FFFFFF>', '<00000000> <FFFFFFFF>'])('Office ToUnicode %s encodes explicit labels while inferred labels lack authority', async range => {
  const f = await fixture(`1 begincodespacerange ${range} endcodespacerange ` +
    '1 beginbfchar <41> <0041> endbfchar');
  const explicit = resolveRunFonts(f.page)[0]!;
  expect([65, 101, 32].map(code => explicit.unicodeByCode.get(code))).toEqual(['A', 'e', ' ']);
  expect(explicit.canEncode!('A')).toMatchObject({ok:true, bytes:Uint8Array.of(65)});
  expect(() => explicit.assertSource!([Uint8Array.of(65)])).not.toThrow();
  const inferred = recoverRunUnicode(fontInputFromDict(f.font), 1, null, {}, {});
  expect([65, 101, 32].map(code => inferred.unicodeByCode.get(code))).toEqual(['A', 'e', ' ']);
  expect(() => inferred.assertSource!([Uint8Array.of(65)])).toThrow('requires a ToUnicode');
});

test.each([
  ['<0000> <FFFF>', '0041'], ['<0000> <00FF>', '41'], ['<000041> <000042>', '41'],
  ['<00> <FFFF>', '41'], ['<0000> <FF>', '41'],
])('one-byte font cannot encode from codespace %s and source %s', async (range,key) => {
  const f = await fixture(`1 begincodespacerange ${range} endcodespacerange 1 beginbfchar <${key}> <0041> endbfchar`);
  const font = resolveRunFonts(f.page)[0]!;
  expect(font.unicodeByCode.get(65)).toBe('A');
  expect(font.canEncode!('A').ok).toBe(false);
  expect(() => font.assertSource!([Uint8Array.of(65)])).toThrow('requires a ToUnicode');
});

test('Type0 labels follow CIDToGIDMap and the program cmap, never CID values', async () => {
  const f = await fixture(), ctx = f.doc.context;
  const map = new Uint8Array(86);
  map[3] = 7; map[5] = 2; map[85] = 4; // CID1=A, CID2=e, CID42=space.
  const child = ctx.register(ctx.obj({Type:'Font', Subtype:'CIDFontType2', DW:500,
    FontDescriptor:f.font.get(PDFName.of('FontDescriptor')), CIDToGIDMap:ctx.register(ctx.flateStream(map))}));
  f.font.set(PDFName.of('Subtype'), PDFName.of('Type0'));
  f.font.set(PDFName.of('Encoding'), PDFName.of('Identity-H'));
  f.font.set(PDFName.of('DescendantFonts'), ctx.obj([child]));
  const font = resolveRunFonts(f.page)[0]!;
  expect([1, 2, 42, 65].map(code => font.unicodeByCode.get(code))).toEqual(['A', 'e', ' ', undefined]);
});

for (const replacement of ['', 'eA']) test(`simple-font identity conflicts refuse ${JSON.stringify(replacement)}`, async () => {
  const f = await fixture('2 beginbfchar <41> <0065> <65> <0041> endbfchar');
  expect(replaceRunPage(f.page, {sourceHash:f.source.sourceHash, allowExistingCodePermutation:true, edits:[{
    fontResource:'F1', fontObject:f.ref.toString(), opIndex:5, itemIndex:-1,
    byteStart:0, byteEnd:2, expected:Uint8Array.of(65, 101), replacement,
  }]})).toMatchObject({ok:false, terminal:true, reason:expect.stringContaining('glyph-identity-conflict')});
});

test('a conflicting replacement code cannot be introduced from a good source code', async () => {
  const f = await fixture('3 beginbfchar <41> <0065> <65> <0065> <20> <0020> endbfchar');
  expect(replaceRunPage(f.page, {sourceHash:f.source.sourceHash, edits:[{
    fontResource:'F1', fontObject:f.ref.toString(), opIndex:5, itemIndex:-1,
    byteStart:2, byteEnd:3, expected:Uint8Array.of(32), replacement:'e',
  }]})).toMatchObject({ok:false, terminal:true, reason:expect.stringContaining('glyph-identity-conflict')});
});

test('recovered labels do not authorize new replacement text or code permutations without ToUnicode', async () => {
  const f = await fixture();
  for (const replacement of ['eA', 'e']) {
    expect(replaceRunPage(f.page, {sourceHash:f.source.sourceHash, allowExistingCodePermutation:true, edits:[{
      fontResource:'F1', fontObject:f.ref.toString(), opIndex:5, itemIndex:-1,
      byteStart:0, byteEnd:2, expected:Uint8Array.of(65, 101), replacement,
    }]}).ok).toBe(false);
  }
});

for (const replacement of ['', 'BA']) test(`present Type1 identity conflicts still refuse ${JSON.stringify(replacement)}`, async () => {
  const f = await type1Fixture({differences:[65, 'B', 'A']});
  expect(replaceRunPage(f.page, f.plan(replacement))).toMatchObject({ok:false, terminal:true,
    reason:expect.stringContaining('glyph-identity-conflict')});
  expect(inspectRunPage(f.page)).toEqual(f.source);
});

test('a recovered code cannot hide a later Type1 metrics conflict', async () => {
  const f = await type1Fixture({widths:[600, 602, 600]}), ctx = f.doc.context;
  f.font.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(
    '3 beginbfchar <41> <FFFD> <42> <0042> <43> <0043> endbfchar')));
  expect(replaceRunPage(f.page, f.plan(''))).toMatchObject({ok:false, terminal:true,
    reason:expect.stringContaining('font-metrics-conflict')});
});

test('overflow planning sees recovered source labels with a searchable substitute', async () => {
  const f = await fixture(), ctx = f.doc.context;
  const replacement = f.font.clone(ctx);
  replacement.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(
    '3 beginbfchar <41> <0041> <65> <0065> <20> <0020> endbfchar')));
  f.page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).set(PDFName.of('F2'), ctx.register(replacement));
  const fonts = resolveRunFonts(f.page);
  const plan = planStreamReflow(f.page, f.source.bytes, fonts,
    overlay({originalText:'A', text:'Ae Ae', coverRects:[{x:49.9, y:148, w:5.2, h:12}]}), {}, {}, fonts[1]!);
  expect(plan?.reflow?.layout.strategy).toBe('wrap');
  expect(plan?.reflow?.clusters.map(glyph => glyph.unicode).join('')).toBe('Ae Aee Ae');
  expect(plan?.reflow?.clusters.filter(glyph => glyph.source).map(glyph => [...glyph.code]))
    .toEqual([[101], [32], [65], [101]]);
});

// Copy tables without spreading large byte arrays onto the JS call stack.
function assemble(tables:Record<string, Uint8Array>):Uint8Array {
  const entries = Object.entries(tables), header = 12 + entries.length * 16;
  const bytes = new Uint8Array(header + entries.reduce((n, [, b]) => n + Math.ceil(b.length / 4) * 4, 0));
  const v = new DataView(bytes.buffer); v.setUint32(0, 0x10000); v.setUint16(4, entries.length);
  let offset = header;
  entries.forEach(([tag, data], i) => {
    const p = 12 + i * 16;
    bytes.set(Array.from(tag, c => c.charCodeAt(0)), p);
    v.setUint32(p + 8, offset); v.setUint32(p + 12, data.length);
    bytes.set(data, offset); offset += Math.ceil(data.length / 4) * 4;
  });
  return bytes;
}
const words = (...values:number[]) => Uint8Array.from(values.flatMap(n => [n >>> 8 & 255, n & 255]));
const longs = (...values:number[]) => Uint8Array.from(values.flatMap(n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]));
function groups(format:12|13, ranges:number[][]):Uint8Array {
  return Uint8Array.from([...words(format, 0), ...longs(16 + ranges.length * 12, 0, ranges.length), ...longs(...ranges.flat())]);
}
function cmapTable(subtable:Uint8Array, encoding = 1):Uint8Array {
  return Uint8Array.from([...words(0, 1, 3, encoding), ...longs(12), ...subtable]);
}
async function cidFixture(program:Uint8Array, toUnicode?:string, map?:Uint8Array) {
  const f = await fixture(toUnicode), ctx = f.doc.context;
  f.font.lookup(PDFName.of('FontDescriptor'), PDFDict).set(PDFName.of('FontFile2'), ctx.register(ctx.stream(program)));
  f.font.set(PDFName.of('Subtype'), PDFName.of('Type0'));
  f.font.set(PDFName.of('Encoding'), PDFName.of('Identity-H'));
  f.font.set(PDFName.of('DescendantFonts'), ctx.obj([ctx.register(ctx.obj({Type:'Font', Subtype:'CIDFontType2', DW:500,
    FontDescriptor:f.font.get(PDFName.of('FontDescriptor')), CIDToGIDMap:map ? ctx.register(ctx.stream(map)) : 'Identity'}))]));
  return {...f, resolved:() => resolveRunFonts(f.page)[0]!};
}
function cidProgram(subtable:Uint8Array, encoding = 1) {
  return assemble({...ttfTables(tinyTtf()), cmap:cmapTable(subtable, encoding)});
}

for (const [format, subtable, expected] of [
  [0, Uint8Array.from([...words(0, 262, 0), ...Array.from({length:256}, (_, cp) => cp === 65 ? 7 : 0)]), [[7, 'A']]],
  [4, format4Table(), [[1, 'A'], [2, 'B'], [7, 'S'], [3, 'U']]],
  [6, Uint8Array.from([...words(6, 12, 0, 65, 1, 7)]), [[7, 'A']]],
  [10, Uint8Array.from([...words(10, 0), ...longs(22, 0, 0x1f600, 1), ...words(7)]), [[7, '😀']]],
  [12, format12Table(), [[1, 'A'], [2, 'B'], [3, 'C'], [5, '𐀀'], [6, '𐀁']]],
  [13, groups(13, [[65, 65, 7], [101, 102, 2]]), [[7, 'A'], [2, undefined]]],
] as const) test(`Identity-H walks cmap format ${format} without inventing labels`, async () => {
  const f = await cidFixture(cidProgram(subtable));
  const font = f.resolved();
  for (const [gid, label] of expected) expect(font.unicodeByCode.get(gid)).toBe(label);
});

test('Identity-H supports the full Unicode (3,10) selection', async () => {
  const f = await cidFixture(cidProgram(groups(12, [[0x1f600, 0x1f600, 7]]), 10));
  expect(f.resolved().unicodeByCode.get(7)).toBe('😀');
});

test('Identity-H ambiguity stays unknown even with an AGL post name', async () => {
  const program = namedTtf({maps:[{platform:3, encoding:1, entries:[[65, 7], [66, 7]]}]});
  expect((await cidFixture(program)).resolved().unicodeByCode.has(7)).toBe(false);
});

test('Identity-H recovers post names only where a usable cmap inverse is absent', async () => {
  const program = namedTtf({maps:[{platform:3, encoding:1, entries:[[101, 7]]}]});
  const font = (await cidFixture(program)).resolved();
  expect(font.unicodeByCode.get(7)).toBe('e'); // Unique cmap beats the unrelated post name A.
  expect(font.unicodeByCode.get(1)).toBe('S');
  expect(font.unicodeByCode.get(4)).toBe(' ');
});

test('Identity-H rejects invalid scalars, .notdef, out-of-range and absent glyphs', async () => {
  const program = cidProgram(groups(12, [[0, 0, 1], [65, 65, 0], [66, 66, 10], [67, 67, 4],
    [0xd800, 0xd800, 2], [0xfffd, 0xfffd, 3]]));
  expect((await cidFixture(program)).resolved().unicodeByCode.size).toBe(0);
});

for (const broken of ['truncated cmap', 'unsupported cmap', 'duplicate cmap', 'truncated CID map',
  'truncated glyf', 'composite cycle'] as const) test(`Identity-H leaves ${broken} unknown`, async () => {
  const tables = ttfTables(tinyTtf({maps:[{platform:3, encoding:1, entries:[[65, 7]]}]}));
  let map:Uint8Array|undefined;
  if (broken === 'truncated cmap') tables.cmap = tables.cmap!.slice(0, -1);
  if (broken === 'unsupported cmap') new DataView(tables.cmap!.buffer).setUint16(12, 2);
  if (broken === 'duplicate cmap') tables.cmap = Uint8Array.from([...words(0, 2, 3, 1), ...longs(20),
    ...words(3, 1), ...longs(32), ...words(6, 12, 0, 65, 1, 7), ...words(6, 12, 0, 66, 1, 7)]);
  if (broken === 'truncated CID map') map = Uint8Array.of(0, 0, 0);
  if (broken === 'truncated glyf' || broken === 'composite cycle') {
    const start = new DataView(tables.loca!.buffer).getUint32(7 * 4), v = new DataView(tables.glyf!.buffer);
    if (broken === 'truncated glyf') v.setUint16(start + 10, 0xffff);
    else { v.setInt16(start, -1); v.setUint16(start + 10, 3); v.setUint16(start + 12, 7); }
  }
  expect((await cidFixture(assemble(tables), undefined, map)).resolved().unicodeByCode.size).toBe(0);
});

test('Identity-H keeps source and replacement ToUnicode authority separate', async () => {
  const f = await cidFixture(tinyTtf());
  const font = f.resolved();
  expect(font.unicodeByCode.get(7)).toBe('A');
  expect(() => font.assertSource!([Uint8Array.of(0, 7)])).toThrow('requires a ToUnicode');
  expect(font.canEncode!('A').ok).toBe(false);
  const conflict = (await cidFixture(tinyTtf(), '1 beginbfchar <0007> <0065> endbfchar')).resolved();
  expect(() => conflict.assertSource!([Uint8Array.of(0, 7)])).toThrow('glyph-identity-conflict');
});

function largeCidProgram():Uint8Array {
  const count = 8192, points = 512, tables = ttfTables(tinyTtf());
  new DataView(tables.maxp!.buffer).setUint16(4, count);
  new DataView(tables.hhea!.buffer).setUint16(34, count);
  tables.hmtx = new Uint8Array(count * 4);
  const metrics = new DataView(tables.hmtx.buffer);
  for (let i = 0; i < count; i++) metrics.setUint16(i * 4, 500);
  // Hundreds of real points per glyph make outline materialization expensive.
  const glyph = new Uint8Array(14 + 4 + points * 2), gv = new DataView(glyph.buffer);
  gv.setInt16(0, 1); gv.setInt16(6, points); gv.setInt16(8, points); gv.setUint16(10, points - 1);
  glyph.set([63, 255, 63, 255], 14); glyph.fill(1, 18);
  tables.glyf = new Uint8Array(count * glyph.length); tables.loca = new Uint8Array((count + 1) * 4);
  const loca = new DataView(tables.loca.buffer);
  for (let i = 0; i < count; i++) { tables.glyf.set(glyph, i * glyph.length); loca.setUint32(i * 4, i * glyph.length); }
  loca.setUint32(count * 4, count * glyph.length);
  tables.cmap = cmapTable(groups(12, [[0x4e00, 0x4e00 + count - 2, 1]]));
  return assemble(tables);
}

if (process.env.SHIORI_CID_MEMORY_WORKER === '1') test('Identity-H memory worker', async () => {
  const f = await cidFixture(largeCidProgram());
  const before = process.memoryUsage().rss, font = f.resolved();
  expect(font.unicodeByCode.size).toBe(8191);
  expect(font.unicodeByCode.get(1)).toBe('一');
  expect(font.unicodeByCode.get(8191)).toBe(String.fromCodePoint(0x6dfe));
  // getrusage's high-water mark can include the test runner's pre-exec fork
  // RSS. Linux VmHWM measures this worker since exec, so suite size cannot
  // inflate the result even though the worker itself stayed small.
  const peak = process.platform === 'linux'
    ? Number(/VmHWM:\s+(\d+)/.exec(await readFile('/proc/self/status', 'utf8'))![1]) * 1024
    : process.resourceUsage().maxRSS * 1024;
  console.log('CID_MEMORY ' + JSON.stringify({before, peak}));
});
else test('large Identity-H resolve stays below 256 MiB peak RSS and 128 MiB growth', async () => {
  const result = await new Promise<{code:number|null; output:string; killed:boolean}>((resolve, reject) => {
    const child = spawn(process.execPath, ['test', import.meta.path, '--test-name-pattern', '^Identity-H memory worker$'],
      {env:{...process.env, SHIORI_CID_MEMORY_WORKER:'1'}, stdio:['ignore', 'pipe', 'pipe']});
    let output = '', killed = false;
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { output += String(data); });
    // A parent watchdog can interrupt the old synchronous outline-building path.
    const timer = setInterval(() => {
      if (process.platform === 'linux') void readFile(`/proc/${child.pid}/status`, 'utf8').then(status => {
        const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
        if (kb > 384 * 1024) { killed = true; child.kill('SIGKILL'); }
      }).catch(() => {});
    }, 20);
    const timeout = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 20000);
    child.on('error', reject);
    child.on('close', code => { clearInterval(timer); clearTimeout(timeout); resolve({code, output, killed}); });
  });
  expect(result.killed, result.output).toBe(false);
  expect(result.code, result.output).toBe(0);
  const report = JSON.parse(/CID_MEMORY (\{[^\n]+\})/.exec(result.output)![1]!) as {before:number; peak:number};
  console.log('Identity-H RSS:', report);
  expect(report.peak).toBeLessThan(256 * 1024 ** 2);
  expect(report.peak - report.before).toBeLessThan(128 * 1024 ** 2);
}, 25000);
