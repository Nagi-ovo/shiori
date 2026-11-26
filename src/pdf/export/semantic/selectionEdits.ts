import { lineChanges } from '../contentText/diff';
import { compactMap } from '../contentText/retypesetCompact';
import type { SemanticGlyph } from './types';

export type GlyphEdit = { glyphs: SemanticGlyph[]; replacement: string };

type Match = { previous?: Match; glyph: SemanticGlyph; chars: string[] };

function omittedRaisedGlyph(glyph: SemanticGlyph, selected: SemanticGlyph[]): boolean {
  const [p, q] = glyph.placement.coreQuad;
  const em = glyph.fontSizePt;
  if (!em) return false;
  return selected.some(near => {
    if (near === glyph || !near.fontSizePt || em >= near.fontSizePt * .85) return false;
    const [a, b] = near.placement.coreQuad;
    const w = Math.hypot(b.x - a.x, b.y - a.y);
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    if (!w || !length || ((b.x - a.x) * (q.x - p.x) + (b.y - a.y) * (q.y - p.y)) / (w * length) < .99) return false;
    const x = p.x - a.x, y = p.y - a.y;
    const across = Math.abs((b.x - a.x) * y - (b.y - a.y) * x) / w;
    const along = Math.abs((b.x - a.x) * x + (b.y - a.y) * y) / w;
    return along < near.fontSizePt * 2 && across > near.fontSizePt * .1 && across < near.fontSizePt;
  });
}

/** Align the cover to the editor's string before assigning changes to PDF
 * scopes. An omitted raised/lowered glyph is an unchanged source occupant. */
export function projectSelection(
  selected: SemanticGlyph[], original: string, replacement: string, label: (glyph: SemanticGlyph) => string | undefined,
): { edits: GlyphEdit[] } | undefined {
  for (const dehyphenate of [false, true]) {
    const input = compactMap(original, dehyphenate);
    const all = selected.map(glyph => {
      const text = label(glyph);
      return { glyph, chars: text === undefined ? ['\ufffd'] :
        compactMap(text, dehyphenate).flatMap(({ char }) => Array.from(char.normalize('NFKC'))) };
    });
    const wanted = input.flatMap(c => Array.from(c.char.normalize('NFKC'), char => ({ ...c, char })));
    const mayHaveOmissions = all.reduce((sum, g) => sum + g.chars.length, 0) > wanted.length;
    let paths = new Map<number, Match | null | undefined>([[0, undefined]]);
    for (const { glyph, chars } of all) {
      if (!chars.length) continue;
      const mayOmit = mayHaveOmissions && omittedRaisedGlyph(glyph, selected);
      const next = new Map<number, Match | null | undefined>();
      const add = (at: number, path: Match | null | undefined) => next.set(at, next.has(at) ? null : path);
      for (const [at, path] of paths) {
        if (mayOmit) add(at, path);
        if (chars.every((char, i) => wanted[at + i]?.char === char)) {
          add(at + chars.length, path === null ? null : { previous: path, glyph, chars });
        }
      }
      paths = next;
      if (!paths.size || paths.size > 256) break;
    }
    let match = paths.get(wanted.length);
    if (!match || paths.size > 256) continue;
    const positions: Match[] = [];
    for (; match; match = match.previous) positions.push(match);
    const matched = positions.reverse().flatMap(({ glyph, chars }) => chars.map(char => ({ glyph, char })));
    const edits: GlyphEdit[] = [];
    for (const change of lineChanges(original, replacement)) {
      const from = wanted.findIndex(c => c.end > change.start);
      const after = wanted.findIndex(c => c.start >= change.end);
      const a = from < 0 ? wanted.length : from, b = after < 0 ? wanted.length : after;
      const first = matched[Math.min(a, matched.length - 1)]!;
      const last = matched[b - 1];
      if (a < b && last) {
        const glyphs = [...new Set(matched.slice(a, b).map(c => c.glyph))];
        const prefix = matched.slice(0, a).filter(c => c.glyph === first.glyph).map(c => c.char).join('');
        const suffix = matched.slice(b).filter(c => c.glyph === last.glyph).map(c => c.char).join('');
        edits.push({ glyphs, replacement: prefix + change.replacement + suffix });
      } else {
        const previous = matched[a - 1];
        const start = previous ? selected.indexOf(previous.glyph) + 1 : 0;
        const end = a >= matched.length ? selected.length : selected.indexOf(first.glyph);
        const gap = selected.slice(start, end);
        const separator = original.slice(previous ? wanted[a - 1]!.end : 0, change.start);
        const explicitGap = separator && !/[\r\n]/u.test(separator) &&
          gap.every(glyph => /^\s+$/u.test(label(glyph) ?? '')) && gap.map(label).join('') === separator;
        const home = (explicitGap ? gap.at(-1) : undefined) ?? previous?.glyph ?? first.glyph;
        // Represent a pure insertion by extending its preceding glyph.
        // At the start of the selection it belongs to the first glyph.
        const text = label(home)!;
        if (!text || (previous && first.glyph === home && a < matched.length)) return;
        edits.push({ glyphs: [home], replacement: previous ? text + change.replacement : change.replacement + text });
      }
    }
    return { edits };
  }
}
