export type OracleSampleCandidate = {
  file: string;
  metadata: {row: {category: string; kind: string; outcome: {mode: string}}};
};

const modes = ['retypeset', 'reflowed', 'substituted', 'fallback-font', 'in-place'];

/** Select only saved candidates. Cover categories and modes before repeating
 * category/mode pairs, retaining a Chinese missing-Han probe when space allows. */
export function selectOracleSamples<T extends OracleSampleCandidate>(candidates: readonly T[], limit = 16): T[] {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('Oracle sample limit must be a nonnegative integer');
  const sorted = candidates.filter(s => modes.includes(s.metadata.row.outcome.mode)).sort((a, b) =>
    a.metadata.row.category.localeCompare(b.metadata.row.category) ||
    modes.indexOf(a.metadata.row.outcome.mode) - modes.indexOf(b.metadata.row.outcome.mode) ||
    Number(b.metadata.row.kind === 'missing-han') - Number(a.metadata.row.kind === 'missing-han') ||
    a.file.localeCompare(b.file));
  const categories = [...new Set(sorted.map(s => s.metadata.row.category))];
  const selected: T[] = [], files = new Set<string>();
  const pick = (matches: (sample: T) => boolean) => {
    if (selected.length >= limit) return;
    const sample = sorted.find(s => !files.has(s.file) && matches(s));
    if (sample) { selected.push(sample); files.add(sample.file); }
  };

  // A large category cannot consume the budget before the other categories.
  for (const category of categories) pick(s => s.metadata.row.category === category);
  const missingHan = (s: T) => s.metadata.row.category === 'chinese' && s.metadata.row.kind === 'missing-han';
  if (!selected.some(missingHan)) pick(missingHan);

  // Reserve coverage of every accepted mode, then prioritize newer modes
  // in each category before adding older category/mode pairs.
  for (const mode of modes) {
    if (!selected.some(s => s.metadata.row.outcome.mode === mode)) pick(s => s.metadata.row.outcome.mode === mode);
  }
  for (const mode of modes) {
    for (const category of categories) {
      const matches = (s: T) => s.metadata.row.category === category && s.metadata.row.outcome.mode === mode;
      if (!selected.some(matches)) pick(matches);
    }
  }

  // Fill spare slots round-robin rather than stacking more Chinese probes.
  while (selected.length < limit) {
    const previous = selected.length;
    for (const category of categories) pick(s => s.metadata.row.category === category);
    if (selected.length === previous) break;
  }
  return selected;
}
