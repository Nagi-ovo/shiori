import {expect, test} from 'bun:test';
import {selectOracleSamples, type OracleSampleCandidate} from './selectOracleSamples';

const sample = (file: string, category: string, mode: string, kind = 'same-length'): OracleSampleCandidate => ({
  file: `${file}.edit.json`, metadata: {row: {category, kind, outcome: {mode}}},
});
const categories = ['chinese', 'desktop-publishing', 'japanese', 'latex', 'tagged', 'word'];
const modes = ['reflowed', 'substituted', 'fallback-font', 'in-place'];
const missingHan = Array.from({length: 24}, (_, i) => sample(`han-${i}`, 'chinese', 'fallback-font', 'missing-han'));
const diverse = categories.flatMap(category => modes.map(mode => sample(`${category}-${mode}`, category, mode)));

test('16 audits cover categories, both new modes per category, older modes and Chinese missing-han', () => {
  const candidates = [...missingHan, ...diverse];
  const selected = selectOracleSamples(candidates);
  expect(selected).toHaveLength(16);
  expect([...new Set(selected.map(s => s.metadata.row.category))].sort()).toEqual(categories);
  for (const category of categories) {
    for (const mode of ['reflowed', 'substituted']) {
      expect(selected.map(s => s.file)).toContain(`${category}-${mode}.edit.json`);
    }
  }
  expect(new Set(selected.map(s => s.metadata.row.outcome.mode))).toEqual(new Set(modes));
  expect(selected.some(s => s.metadata.row.category === 'chinese' && s.metadata.row.kind === 'missing-han')).toBe(true);
  expect(new Set(selected.map(s => s.file)).size).toBe(16);
  for (const candidate of selected) expect(candidates.includes(candidate)).toBe(true);
});

test('category coverage precedes repeated samples even when only older modes exist elsewhere', () => {
  const candidates = [...missingHan, sample('latex', 'latex', 'in-place'), sample('word', 'word', 'fallback-font')];
  expect(new Set(selectOracleSamples(candidates, 3).map(s => s.metadata.row.category)))
    .toEqual(new Set(['chinese', 'latex', 'word']));
});

test('Chinese missing-han is retained beside Chinese reflow and substitution', () => {
  const candidates = [...missingHan, sample('zh-reflow', 'chinese', 'reflowed'), sample('zh-substitute', 'chinese', 'substituted')];
  const selected = selectOracleSamples(candidates, 3);
  expect(selected.map(s => s.metadata.row.outcome.mode)).toContain('reflowed');
  expect(selected.map(s => s.metadata.row.outcome.mode)).toContain('substituted');
  expect(selected.some(s => s.metadata.row.kind === 'missing-han')).toBe(true);
});

test('sparse pools return every unique accepted saved file and reject refused or unknown modes', () => {
  const accepted = [sample('latex', 'latex', 'reflowed'), sample('word', 'word', 'substituted'),
    sample('han', 'chinese', 'fallback-font', 'missing-han'), sample('jp', 'japanese', 'in-place')];
  const candidates = [...accepted, accepted[0]!, sample('refused', 'tagged', 'overlay'), sample('unknown', 'other', 'unknown')];
  const selected = selectOracleSamples(candidates);
  expect(selected.map(s => s.file).sort()).toEqual(accepted.map(s => s.file).sort());
  for (const candidate of selected) expect(accepted.includes(candidate)).toBe(true);
  expect(selectOracleSamples([])).toEqual([]);
  expect(selectOracleSamples([sample('refused', 'word', 'overlay')])).toEqual([]);
});

test('selection is deterministic without reordering or modifying candidate metadata', () => {
  const candidates = [...missingHan, ...diverse];
  const snapshot = structuredClone(candidates);
  const selected = selectOracleSamples(candidates);
  expect(selectOracleSamples([...candidates].reverse())).toEqual(selected);
  expect(selectOracleSamples([...candidates.slice(7), ...candidates.slice(0, 7)])).toEqual(selected);
  expect(candidates).toEqual(snapshot);
});

test('audit budgets remain bounded and remaining capacity can audit more files in a single category', () => {
  for (const limit of [0, 1, 5, 16, 100]) {
    const selected = selectOracleSamples(missingHan, limit);
    expect(selected).toHaveLength(Math.min(limit, missingHan.length));
    expect(new Set(selected.map(s => s.file)).size).toBe(selected.length);
  }
});

test('invalid audit budgets fail clearly', () => {
  for (const limit of [-1, 1.5, NaN, Infinity]) {
    expect(() => selectOracleSamples(diverse, limit)).toThrow(RangeError);
  }
});

test('saved retypeset successes are eligible, bounded and deterministic; unsupported is never audited',()=>{
 const candidates=[...diverse,...categories.map(c=>sample(`${c}-retypeset`,c,'retypeset')),sample('no-text','word','unsupported')];
 const selected=selectOracleSamples(candidates);
 expect(selected).toHaveLength(16);
 expect(selected.some(s=>s.metadata.row.outcome.mode==='retypeset')).toBe(true);
 expect(selected.some(s=>s.metadata.row.outcome.mode==='unsupported')).toBe(false);
 expect(selectOracleSamples([...candidates].reverse())).toEqual(selected);
 expect(selectOracleSamples([sample('approx','word','retypeset')],1).map(s=>s.file)).toEqual(['approx.edit.json']);
 expect(selectOracleSamples([sample('no-text','word','unsupported')])).toEqual([]);
});
