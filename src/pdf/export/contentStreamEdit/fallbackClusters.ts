/** Only replacement/fallback text is canonicalized; source codes and their
 * ToUnicode labels remain untouched. Keep preparation and compilation aligned. */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const fallbackClusters = (text: string): string[] =>
  Array.from(segmenter.segment(text.normalize('NFC')), s => s.segment);
