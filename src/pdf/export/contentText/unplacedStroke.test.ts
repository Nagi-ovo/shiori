import { expect, test } from 'bun:test';
import { fixture, overlay } from './fixtures.test-support';
import { planContentText } from './planner';
import { compilerReason, contentTextReasons } from './outcomes';
import { replaceRuns } from '../contentStreamEdit/replaceRun';
import { resolveRunFonts } from '../contentStreamEdit/replaceRunPage';

// Failure inventory: stroke before/after fill, relative advance in one BT,
// Tj/TJ spacing, same Y but disjoint X, selected stroke, missing stroke widths,
// source decoding failure hiding clip/semantic state, and genuine overflow.
for (const tr of [1, 2]) for (const show of ['(ZZ) Tj', '[(Z) -100 (Z)] TJ']) {
  for (const order of ['before', 'after', 'relative']) test(`Tr ${tr} ${show}, ${order}: unrelated stroke does not poison fill edits`, async () => {
    const stroke = `${tr} Tr 1 0 0 1 10 100 Tm ${show}`;
    const fill = '0 Tr 1 0 0 1 50 100 Tm (ABCDE) Tj';
    const relative = `${tr} Tr 1 0 0 1 ${show.includes('TJ') ? 37 : 38} 100 Tm ${show} 0 Tr (ABCDE) Tj`;
    const f = await fixture(`BT /F1 10 Tf ${order === 'relative' ? relative : order === 'before' ? `${stroke} ${fill}` : `${fill} ${stroke}`} ET`);
    const fonts = resolveRunFonts(f.page);
    for (const text of ['AXCDE', 'BCDEA', 'ABDE']) {
      const planned = planContentText(f.source, fonts, overlay({ text }));
      expect(planned.ok).toBe(true);
      if (!planned.ok) continue;
      const out = replaceRuns(f.source, fonts, planned.plan);
      expect(out.ok).toBe(true);
      expect(new TextDecoder().decode(out.bytes)).toContain(show);
    }
    const longer = planContentText(f.source, fonts, overlay({ text: 'ABXCDE' }));
    expect(longer.ok).toBe(true);
    if (longer.ok) expect(replaceRuns(f.source, fonts, longer.plan)).toMatchObject({ ok: false, code: 'overflow' });
  });
  test(`an addressed Tr ${tr} ${show} has the precise public code`, async () => {
    const f = await fixture(`BT /F1 10 Tf ${tr} Tr 50 100 Td ${show} ET`);
    expect(planContentText(f.source, resolveRunFonts(f.page), overlay({ originalText: 'ZZ', text: 'ZX' })))
      .toMatchObject({ ok: false, code: 'graphics-effect-unsupported' });
    expect(contentTextReasons).toContain('graphics-effect-unsupported');
    expect(compilerReason('graphics-effect-unsupported: stroked text (Tr 1/2)')).toBe('graphics-effect-unsupported');
  });
}
test('unknown stroke widths still block a relative fill target', async () => {
  const f = await fixture('BT /F2 10 Tf 1 Tr 10 100 Td (ZZ) Tj /F1 10 Tf 0 Tr (ABCDE) Tj ET');
  expect(planContentText(f.source, resolveRunFonts(f.page), overlay())).toMatchObject({ ok: false, code: 'font-unavailable' });
});
test('a measured mixed-size stroked selection preserves the style-change reason', async () => {
  const f = await fixture('BT /F1 12 Tf 2 Tr 50 100 Td (ABCDE) Tj ET');
  expect(planContentText(f.source, resolveRunFonts(f.page), overlay({ coverRects: [{ x: 49, y: 98, w: 40, h: 15 }] })))
    .toMatchObject({ ok: false, code: 'style-change' });
});
for (const semantic of [false, true]) test(`missing decoding preserves ${semantic ? 'semantic' : 'clip'} refusal`, async () => {
  const f = await fixture(`${semantic ? '/Span << /ActualText (ABCDE) >> BDC' : '0 0 300 200 re W n'} BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET ${semantic ? 'EMC' : ''}`);
  const fonts = resolveRunFonts(f.page);
  fonts[0]!.unicodeByCode = new Map();
  expect(planContentText(f.source, fonts, overlay())).toMatchObject({ ok: false, code: 'unsupported-state', reason: 'clip/graphics/semantic dependent target' });
});
