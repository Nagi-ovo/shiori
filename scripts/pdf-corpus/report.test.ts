import {expect, test} from 'bun:test';
import {isHeadlineKind, markdownReport, summarize, summarizeReport, type CorpusRow} from './report';

const row = (mode: CorpusRow['outcome']['mode'], category = 'chinese'): CorpusRow => ({
  id: `${category}-sample`, category, page: 0, kind: 'longer', original: 'old', text: 'new', ms: 10,
  outcome: {overlayId: 'edit', mode, ...(mode === 'overlay' ? {reason: 'overflow' as const} : {})},
});

test('summary partitions all five outcomes and accepts all four content-edit modes', () => {
  const rows = [row('in-place'), row('fallback-font'), row('substituted'), row('reflowed'), row('overlay'), row('overlay')];
  expect(summarize(rows)).toEqual({
    edits: 6, 'in-place': 1, 'fallback-font': 1, substituted: 1, reflowed: 1, overlay: 2,
    acceptedRate: 4 / 6, refusalRate: 2 / 6, ms: 60, reasons: {overflow: 2},
  });
});

test('legacy and empty inputs retain finite, explicit new-mode zero counts', () => {
  expect(summarize([])).toEqual({
    edits: 0, 'in-place': 0, 'fallback-font': 0, substituted: 0, reflowed: 0, overlay: 0,
    acceptedRate: 0, refusalRate: 0, ms: 0, reasons: {},
  });
  expect(summarize([row('fallback-font')])).toMatchObject({acceptedRate: 1, substituted: 0, reflowed: 0});
});

test('markdown exposes the four accepted modes overall, by category and by Chinese file', () => {
  const rows = [row('substituted'), row('reflowed'), row('overlay'), row('fallback-font', 'latex')];
  const md = markdownReport({rows, files: 2, elapsedMs: 100, skips: [], oracle: [], categories: ['chinese', 'latex', 'word']});
  expect(md).toContain('| Category | Edits | In place | Fallback font | Substituted | Reflowed | Refused | Accepted |');
  expect(md).toContain('| chinese | 3 | 0 | 0 | 1 | 1 | 1 | 66.7% |');
  expect(md).toContain('| latex | 1 | 0 | 1 | 0 | 0 | 0 | 100.0% |');
  expect(md).toContain('| word | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |');
  expect(md).toContain('| overall | 4 | 0 | 1 | 1 | 1 | 1 | 75.0% |');
  expect(md).toContain('| chinese-sample | 3 | 0 | 0 | 1 | 1 | 1 |');
  expect(md).toContain('- overflow: 1');
});

test('headline excludes only unbreakable overflow while stress and old-definition remain explicit', () => {
  const rows = [
    row('in-place'),
    {...row('reflowed'), kind: 'overflow'},
    {...row('substituted'), kind: 'overflow-2'},
    {...row('overlay'), kind: 'overflow-unbreakable', ms: 1000},
    {...row('overlay', 'word'), kind: 'overflow-unbreakable'},
  ];
  for (const kind of ['overflow', 'overflow-2', 'missing-han', 'multi-line', 'future-kind']) {
    expect(isHeadlineKind(kind)).toBe(true);
  }
  expect(isHeadlineKind('overflow-unbreakable')).toBe(false);

  // These are the objects persisted by run.ts, including the legacy all-row summary.
  const summaries = JSON.parse(JSON.stringify(summarizeReport(rows)));
  expect(summaries.summary).toEqual(summarize(rows));
  expect(summaries.summary.edits).toBe(rows.length);
  expect(summaries.headline).toMatchObject({edits: 3, acceptedRate: 1, overlay: 0, ms: 30, reasons: {}});
  expect(summaries.unbreakableOverflow).toMatchObject({edits: 2, acceptedRate: 0, overlay: 2, ms: 1010});
  expect(summaries.oldDefinition).toMatchObject({edits: 3, 'in-place': 1, substituted: 0, reflowed: 0, overlay: 2, acceptedRate: 1 / 3});

  const md = markdownReport({rows, files: 2, elapsedMs: 100, skips: [], oracle: [], categories: ['chinese', 'word']});
  const [main, stressAndOld] = md.split('\n## Unbreakable overflow stress case');
  expect(main).toContain('Edits: 3.');
  expect(main).toContain('| overall | 3 | 1 | 0 | 1 | 1 | 0 | 100.0% |');
  expect(main).toContain('| chinese | 3 | 1 | 0 | 1 | 1 | 0 | 100.0% |');
  expect(main).toContain('| word | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% |');
  expect(main).toContain('| chinese-sample | 3 | 1 | 0 | 1 | 1 | 0 |');
  expect(main).toContain('Mean export time: 10.0 ms per edit.');
  expect(main).not.toContain('- overflow:');
  const [stress, oldDefinition] = stressAndOld!.split('\n## Old-definition comparison');
  expect(stress).toContain('| overflow-unbreakable | 2 | 0 | 0 | 0 | 0 | 2 | 0.0% |');
  expect(oldDefinition).toContain('| old-definition | 3 | 1 | 0 | 0 | 0 | 2 | 33.3% |');
});

test('empty report groups retain finite rates', () => {
  for (const summary of Object.values(summarizeReport([]))) expect(summary).toEqual(summarize([]));
});
