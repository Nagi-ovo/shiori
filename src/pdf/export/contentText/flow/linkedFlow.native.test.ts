import {describe,expect,test} from 'bun:test';
import {existsSync,readFileSync} from 'node:fs';
import {PDFArray,PDFDict,PDFDocument,PDFName,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {openPdfium} from '../../../../../scripts/pdf-inplace/nativePdfium';
import {exportPdf} from '../../exportPdf';
import {planLinkedFlow} from './flowPlan';
import {buildFlow as build,linkedFlowStory as base,type FlowFixture} from './linkedFlow.test-support';

const buildFlow = (f: FlowFixture) => build(f, path => readFileSync(path));

const library = 'vendor/pdfium/linux-x64/lib/libpdfium.so';
const nativeTest = test.skipIf(!existsSync(library));
const strip = (s: string) => s.replace(/\s/g, '');
async function content(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes), page = doc.getPage(0), c = page.node.Contents();
  const parts = c instanceof PDFArray ? c.asArray().map(r => doc.context.lookup(r)) : [c];
  return parts.map(s => s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : '').join('\n')
    + String(page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict).keys().map(String).sort());
}
function glyphs(bytes: Uint8Array) {
  const pdfium = openPdfium(library);
  try { return pdfium.inspectPage(bytes, 0, true) as { text: string; glyphs: { text: string; origin: number[]; inkBox: number[] }[] }; }
  finally { pdfium.close(); }
}
const inRect = (p: number[], r: { x: number; y: number; w: number; h: number }) => p[0]! >= r.x && p[0]! <= r.x + r.w && p[1]! >= r.y && p[1]! <= r.y + r.h;

describe('linked text frames on export', () => {
  nativeTest('a linked chain with no edit exports the source bytes unchanged', async () => {
    const f = await buildFlow(base);
    const saved = await exportPdf(f.bytes, { ...f.model, overlays: [] }, { mode: 'annotations' });
    expect(Buffer.compare(Buffer.from(saved.bytes), Buffer.from(f.bytes))).toBe(0);
  });

  nativeTest('an accepted flow reports its change window and agrees with the dry run', async () => {
    const f = await buildFlow(base);
    const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    const outcome = saved.contentTextOutcomes?.find(o => o.overlayId === 'flow-edit');
    expect(plan.ok).toBe(true);
    expect(outcome?.mode).not.toBe('unsupported');
    expect(saved.unexcisedEdits).toBe(0);
    if (!plan.ok) return;
    expect(outcome?.flow).toEqual({ chainId: 'chain-1', framesChanged: ['frame-0', 'frame-1'], pagesChanged: ['p1'],
      movedGlyphCount: plan.moves.reduce((n, m) => n + m.glyphCount, 0) });
    expect(plan.moves.map(m => [m.frameId, m.kind])).toEqual([['frame-0', 'rewrite'], ['frame-1', 'spill'], ['frame-1', 'push']]);
  });

  nativeTest('a span that carries only an MCID still flows and extracts the story', async () => {
    const f = await buildFlow({ ...base, spans: 'mcid' });
    const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    expect({ plan: plan.ok ? 'ok' : plan.reason, export: saved.contentTextOutcomes?.[0]?.mode }).toEqual({ plan: 'ok', export: 'retypeset' });
    expect(strip(glyphs(saved.bytes).text)).toContain(strip(base.edit + f.secondLines.join('')));
  });

  nativeTest('a page backdrop painted before all text is no obstacle', async () => {
    const f = await buildFlow({ ...base, pageFill: 'before' });
    const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    expect({ plan: plan.ok ? 'ok' : plan.reason, export: saved.contentTextOutcomes?.[0]?.mode }).toEqual({ plan: 'ok', export: 'retypeset' });
  });

  test.each([
    ['the source paints the lower frame first', { ...base, secondFirst: true }],
    ['other text is painted between the two frames', { ...base, between: 'Notice between the frames' }],
  ] as const)('the story reads as one run when %s', async (_label, fixture) => {
    if (!existsSync(library)) return;
    const f = await buildFlow(fixture);
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    expect(saved.contentTextOutcomes?.[0]?.mode).toBe('retypeset');
    const story = strip(fixture.edit + f.secondLines.join(''));
    expect(strip(glyphs(saved.bytes).text)).toContain(story);
    const raw = Bun.spawnSync(['pdftotext', '-raw', '-', '-'], { stdin: saved.bytes });
    if (raw.exitCode === 0) expect(strip(raw.stdout.toString())).toContain(story);
  });

  nativeTest('an edit that fits the first frame leaves the second frame and its manifest entry alone', async () => {
    const f = await buildFlow({ ...base, edit: 'Night porters walk the east corridor every hour and check the fire doors.' });
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    expect(saved.contentTextOutcomes?.[0]?.flow?.framesChanged).toEqual(['frame-0']);
    const before = glyphs(f.bytes).glyphs.filter(g => inRect(g.origin, f.frames[1])).map(g => `${g.text}@${g.origin}`);
    const after = glyphs(saved.bytes).glyphs.filter(g => inRect(g.origin, f.frames[1])).map(g => `${g.text}@${g.origin}`);
    expect(after).toEqual(before);
  });

  // A false miss can come from the font box, a glyph transform, or a clip
  // that was restored before the fill. Unreadable procedures give no bound.
  nativeTest.each([
    ['Type3 ink outside its origin', { kind: 'type3', x: 40, y: 390 }, 'flow-destination-obstacle'],
    ['an ExtGState font and size', { kind: 'extgstate', x: 40, y: 390 }, 'flow-destination-obstacle'],
    ['a Type3 d1 envelope without a FontBBox', { kind: 'type3', x: 40, y: 390, bbox: null, proc: '1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f' }, 'flow-destination-obstacle'],
    ['Type3 ink after a TJ adjustment', { kind: 'type3', x: 0, y: 390, show: '[1000 (A) -1000 (A)] TJ' }, 'flow-destination-obstacle'],
    ['Type3 ink through FontMatrix and CTM', { kind: 'type3', x: 20, y: 195, matrix: [.0005, 0, 0, .0005, 0, 0], transform: '2 0 0 2 0 0 cm' }, 'flow-destination-obstacle'],
    ['Type3 ink sheared into the destination band', { kind: 'type3', x: 40, y: 330, matrix: [.001, .0005, 0, .001, 0, 0], show: '(AA) Tj' }, 'flow-destination-obstacle'],
    ['Type3 ink between slots over the first frame', { kind: 'type3', x: 40, y: 450, at: 'between' }, 'flow-destination-obstacle'],
    ['a metricless Type3 fill outside FontBBox', { kind: 'type3', x: 35, y: 330, proc: '500 1100 800 1000 re f' }, 'flow-destination-obstacle'],
    ['a d0 fill outside FontBBox between slots', { kind: 'type3', x: 30, y: 450, at: 'between', proc: '1000 0 d0 700 0 400 200 re f' }, 'flow-destination-obstacle'],
    ['a Type3 fill after its clip is restored', { kind: 'type3', x: 35, y: 330, proc: '1000 0 d0 q 0 0 100 100 re W n Q 500 1100 800 1000 re f' }, 'flow-destination-obstacle'],
    ['a Type3 fill through CharProc transforms', { kind: 'type3', x: 35, y: 330, proc: '1000 0 d0 q 2 0 0 2 0 0 cm 1 0 0 1 250 550 cm 0 0 400 500 re f Q' }, 'flow-destination-obstacle'],
    ['a Type3 fill through the CharProc stream matrix', { kind: 'type3', x: 35, y: 330, proc: '1000 0 d0 0 0 800 1000 re f', procMatrix: [1, 0, 0, 1, 500, 1100] }, 'flow-destination-obstacle'],
    ['a Type3 gs font with scaled and raised TJ placement', { kind: 'type3', x: 13, y: 340, gsFont: true, textState: '80 Tz 30 Ts', show: '[(A) -750 (A)] TJ', proc: '1000 0 d0 0 480 400 650 re f' }, 'flow-destination-obstacle'],
    ['an unresolved Type3 XObject with a plausible FontBBox', { kind: 'type3', x: 370, y: 490, proc: '1000 0 d0 /Missing Do' }, 'flow-unsupported-text'],
    ['an unsupported Type3 stroke with a plausible d1 box', { kind: 'type3', x: 370, y: 490, proc: '1000 0 0 0 100 100 d1 0 0 m 100 100 l S' }, 'flow-unsupported-text'],
    ['a missing Type3 CharProc with a plausible FontBBox', { kind: 'type3', x: 370, y: 490, proc: null }, 'flow-unsupported-text'],
    ['an undecodable Type3 CharProc with a plausible FontBBox', { kind: 'type3', x: 370, y: 490, procFilter: 'UnsupportedFilter' }, 'flow-unsupported-text'],
    ['a malformed Type3 CharProc with a plausible FontBBox', { kind: 'type3', x: 370, y: 490, proc: '1000 0 0 100 d1 0 0 100 100 re f' }, 'flow-unsupported-text'],
    ['a Type3 fill outside the renderer’s coordinate range', { kind: 'type3', x: 370, y: 490, proc: `1000 0 d0 ${'9'.repeat(40)} 0 100 100 re f` }, 'flow-unsupported-text'],
    ['an unknown font away from the frames', { kind: 'unknown', x: 370, y: 490 }, 'flow-unsupported-text'],
  ] satisfies [string, NonNullable<FlowFixture['unplacedShow']>, string][])('unplaced %s refuses without changing content or fonts', async (_label, unplacedShow, reason) => {
    const f = await buildFlow({ ...base, unplacedShow });
    const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    expect({ plan: plan.ok ? 'ok' : plan.reason, mode: saved.contentTextOutcomes?.[0]?.mode, reason: saved.contentTextOutcomes?.[0]?.reason })
      .toEqual({ plan: reason, mode: 'unsupported', reason });
    expect(saved.unexcisedEdits).toBe(1);
    expect(saved.acceptance.status).not.toBe('accepted');
    expect(await content(saved.bytes)).toBe(await content(f.bytes));
  });

  nativeTest('native d1 paint can escape its declared box into the destination frame', async () => {
    const proc = '1000 0 0 0 100 100 d1';
    const show = { kind: 'type3' as const, x: 35, y: 330 };
    const f = await buildFlow({ ...base, unplacedShow: { ...show, proc: `${proc} 500 1100 800 1000 re f` } });
    const control = await buildFlow({ ...base, unplacedShow: { ...show, proc } });
    const pdfium = openPdfium(library);
    try {
      const { pixels: painted, width, height } = pdfium.inspectPage(f.bytes, 0, true);
      const { pixels: empty } = pdfium.inspectPage(control.bytes, 0, true);
      expect(painted).toBeDefined();
      expect(painted!.length).toBe(empty!.length);
      const frame = f.frames[1];
      let newInk = 0;
      for (let y = Math.ceil(frame.y * 2); y < (frame.y + frame.h) * 2; y++) {
        for (let x = Math.ceil(frame.x * 2); x < (frame.x + frame.w) * 2; x++) {
          const at = ((height * 2 - 1 - y) * width * 2 + x) * 4;
          if (empty![at]! >= 250 && painted![at]! < 250) newInk++;
        }
      }
      expect(newInk).toBeGreaterThan(0);
    } finally { pdfium.close(); }
    expect(await planLinkedFlow(f.bytes, f.model, 'chain-1')).toMatchObject({ ok: false, reason: 'flow-destination-obstacle' });
    const saved = await exportPdf(f.bytes, f.model);
    expect(saved.contentTextOutcomes).toMatchObject([{ mode: 'unsupported', reason: 'flow-destination-obstacle' }]);
    expect(await content(saved.bytes)).toBe(await content(f.bytes));
  });

  nativeTest.each([
    ['Type3 d0 without FontBBox', { kind: 'type3', x: 370, y: 490, bbox: null, proc: '1000 0 d0 0 0 100 100 re f' }],
    ['metricless Type3 without FontBBox', { kind: 'type3', x: 370, y: 490, bbox: null, proc: '0 0 100 100 re f' }],
    ['Type3 whose FontBBox intersects a frame', { kind: 'type3', x: 40, y: 390, proc: '1000 0 d0 8000 0 100 100 re f' }],
    ['Type3 with a d1 and a clip', { kind: 'type3', x: 35, y: 330, proc: '1000 0 0 0 100 100 d1 q 0 0 100 100 re W* n 0 0 100 100 re f 500 1100 800 1000 re f Q' }],
    ['ExtGState text', { kind: 'extgstate', x: 370, y: 490 }],
  ] satisfies [string, NonNullable<FlowFixture['unplacedShow']>][])('bounded unplaced %s ink away from both frames still flows', async (_label, unplacedShow) => {
    const f = await buildFlow({ ...base, unplacedShow });
    const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    expect({ plan: plan.ok ? 'ok' : plan.reason, mode: saved.contentTextOutcomes?.[0]?.mode }).toEqual({ plan: 'ok', mode: 'retypeset' });
    expect(strip(glyphs(saved.bytes).text)).toContain(strip(base.edit + f.secondLines.join('')));
    const outside = (g: { origin: number[] }) => !f.frames.some(r => inRect(g.origin, r));
    const furniture = (bytes: Uint8Array) => glyphs(bytes).glyphs.filter(outside).map(({ text, origin, inkBox }) => ({ text, origin, inkBox }));
    expect(furniture(saved.bytes)).toEqual(furniture(f.bytes));
  });

  test.each([
    ['a story longer than both frames', { ...base, edit: `${base.edit} ${base.edit} ${base.edit}` }, 'flow-chain-exhausted'],
    ['a rule across the free part of the second frame', { ...base, rule: { x: 80, y: 400, w: 200, h: 0 } }, 'flow-destination-obstacle'],
    ['a first frame that no longer holds the edited text', { ...base, first: ['Somebody already rewrote this paragraph.'] }, 'stale-source'],
    ['a first frame that mixes two type sizes', { ...base, firstLineSizes: [10, 12, 10] }, 'flow-unsupported-text'],
    ['a full-page fill painted over the text', { ...base, pageFill: 'after' }, 'flow-destination-obstacle'],
    ['frames in separate marked-content spans', { ...base, spans: true }, 'semantic-dependency'],
    ['a fitting edit inside an ActualText span', { ...base, spans: true, edit: 'Night porters walk the east corridor every hour and check the fire doors.' }, 'semantic-dependency'],
    ['a spill inside one ActualText span around both frames', { ...base, spans: 'both' }, 'semantic-dependency'],
    ['stroked text painted between the frames over the first frame', { ...base, secondFirst: true, extraShow: { text: 'H', x: 40, y: 450, size: 48, mode: 2, at: 'between' } }, 'flow-destination-obstacle'],
    ['stroked text through the second frame’s destination band', { ...base, extraShow: { text: 'H', x: 40, y: 380, size: 48, mode: 1, at: 'end' } }, 'flow-destination-obstacle'],
    ['a foreign glyph painted between the frames over the first frame', { ...base, secondFirst: true, between: 'H', betweenAt: { x: 40, y: 450, size: 48 } }, 'flow-destination-obstacle'],
    ['an empty second frame beside an unrelated form XObject', { ...base, second: [], logoForm: { x: 370, y: 500, w: 30, h: 30 } }, 'flow-ambiguous-frame'],
  ] as const)('refusing %s leaves page content and fonts identical and draws nothing', async (_label, fixture, reason) => {
    if (!existsSync(library)) return;
    const f = await buildFlow(fixture);
    if (reason === 'stale-source') (f.model.overlays[0] as { originalText: string }).originalText = base.first.join('\n');
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    expect(saved.contentTextOutcomes).toEqual([expect.objectContaining({ overlayId: 'flow-edit', mode: 'unsupported', reason })]);
    // The original text stays in the file, so the export must say so.
    expect(saved.unexcisedEdits).toBe(1);
    expect(await content(saved.bytes)).toBe(await content(f.bytes));
    const plan = await planLinkedFlow(f.bytes, f.model, 'chain-1');
    expect(plan).toEqual(expect.objectContaining({ ok: false, reason }));
    if (reason === 'semantic-dependency') {
      expect(saved.acceptance.status).toBe('needs-review');
      expect(saved.semanticChanges?.length).toBeGreaterThan(0);
      expect(plan).toMatchObject({ semanticChanges: saved.semanticChanges });
    }
  });
});

describe('linked text frames across source shapes', () => {
  const second = ['Keys for the plant room hang in the porters lodge', 'and are signed out against a name each night.'];
  test.each([
    ['one Tj per line', { ...base }],
    ['kerned TJ arrays', { ...base, style: 'TJ' }],
    ["T* and ' line operators", { ...base, style: 'quote' }],
    ['the " operator with character spacing', { ...base, style: 'dquote', tc: .2 }],
    ['several shows on each line', { ...base, style: 'words' }],
    ['character spacing and horizontal scaling', { ...base, tc: .3, tz: 92 }],
    ['a bold source face', { ...base, face: 'Sans-Bold', first: ['Night porters walk the east corridor every', 'hour, checking that fire doors are shut and', 'that exit signs are lit along the hall.'], edit: 'Night porters walk the east corridor every hour, checking that fire doors are shut and that exit signs are lit along the hall. Any fault is written in the night log at once.' }],
    ['a monospace source face', { ...base, face: 'Mono', first: ['Night porters walk the east corridor', 'every hour, checking that fire doors', 'are shut and exit signs are lit.'], edit: 'Night porters walk the east corridor every hour, checking that fire doors are shut and exit signs are lit. Any fault is written in the night log.' }],
    ['a multi-line second frame', { ...base, second }],
    ['a rewrite in the middle of the first frame', { ...base, second, edit: 'Night porters walk the east corridor and the west stair every hour, checking that the fire doors and the roof hatch are shut and that exit signs are lit along the full length of the hall.' }],
  ] as const)('flows %s into the second frame in reading order, inside both frames', async (_label, fixture) => {
    if (!existsSync(library)) return;
    const f = await buildFlow(fixture as FlowFixture);
    const saved = await exportPdf(f.bytes, f.model, { mode: 'annotations' });
    const outcome = saved.contentTextOutcomes?.[0];
    expect({ mode: outcome?.mode, reason: outcome?.reason, detail: outcome?.detail }).toEqual({ mode: 'retypeset', reason: undefined, detail: undefined });
    const after = glyphs(saved.bytes), before = glyphs(f.bytes);
    const story = strip(fixture.edit + f.secondLines.join(''));
    expect(strip(after.text)).toContain(story);
    const outside = (g: { origin: number[] }) => !f.frames.some(r => inRect(g.origin, r));
    expect(after.glyphs.filter(outside).map(g => `${g.text}@${g.origin}`)).toEqual(before.glyphs.filter(outside).map(g => `${g.text}@${g.origin}`));
    for (const g of after.glyphs.filter(g => !outside(g))) {
      const r = f.frames.find(r => inRect(g.origin, r))!;
      expect(g.inkBox[0]! >= r.x - .5 && g.inkBox[2]! <= r.x + r.w + .5 && g.inkBox[1]! >= r.y - .5 && g.inkBox[3]! <= r.y + r.h + .5).toBe(true);
    }
  });
});
