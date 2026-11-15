import {expect, test} from 'bun:test';
import {markdownReport, summarize, type CorpusRow} from './report';

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
