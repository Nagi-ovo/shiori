// Where a plain click inside an editable block puts the caret.
//
// Failure list written before the code:
// 1. a click is mapped to the block's first character (offset 0) whatever
//    the hit point — the bug: 20% and 80% of "ABCDE" both opened at 0;
// 2. the nearest boundary is chosen, not the glyph the point falls in
//    (a click on the right half of "B" belongs after "B");
// 3. a click on line 2 ignores the preceding line and its newline;
// 4. the same click at another zoom lands elsewhere (display px vs points);
// 5. word spaces inserted between runs shift every later offset;
// 6. proportional glyphs are treated as equal-width cells;
// 7. a click past either end of a line escapes the line;
// 8. a click in the leading between two lines picks neither;
// 9. orientation: a rotated run is mapped as if it were horizontal. The
//    click tool admits only horizontal runs (|angle| <= 5°) of unrotated,
//    horizontal-writing pages; that boundary is pinned below;
// 10. the engine's glyph positions are ignored in favour of an estimate;
// 11. a boundary lands inside a grapheme cluster (combining mark, emoji
//     ZWJ sequence, flag);
// 12. right-to-left glyphs take the left-to-right side of the hit, or one
//     RTL run disables the caret for the whole block;
// 13. the measured fallback measures every prefix (quadratic in run length).
import { describe, expect, test } from 'bun:test';
import type { TextRunDisplayBounds } from './highlightRects';
import type { DetectedLine } from './paragraphDetect';
import { contentTextCaretOffset, paragraphBlockText, type CaretCell } from './contentTextCaret';
import { detectParagraphs } from './paragraphDetect';
import { textContentToDisplayTextRuns } from './highlightRects';

// Courier-like 6 pt cells at 10 pt, laid out at `scale` display px per pt.
function run(text: string, xPt: number, baselinePt: number, scale: number, extra: Partial<TextRunDisplayBounds> = {}): TextRunDisplayBounds {
  return { text, x: xPt * scale, y: (baselinePt - 8) * scale, w: text.length * 6 * scale, h: 10 * scale,
    baselineY: baselinePt * scale, fontSizePt: 10, ...extra };
}
function line(runs: TextRunDisplayBounds[]): DetectedLine {
  const x = Math.min(...runs.map(r => r.x)), right = Math.max(...runs.map(r => r.x + r.w));
  const top = Math.min(...runs.map(r => r.y)), bottom = Math.max(...runs.map(r => r.y + r.h));
  return { runs, x, right, width: right - x, top, bottom, baselineY: runs[0]!.baselineY!, fontSizePt: 10 };
}
const block = (scale: number) => [
  line([run('ABCDE', 50, 20, scale)]),
  line([run('FGHIJ', 50, 32, scale)]),
];
const at = (xPt: number, yPt: number, scale: number) => ({ x: xPt * scale, y: yPt * scale });

describe('contentTextCaretOffset', () => {
  test('a click at 20% and 80% of a word lands on those character boundaries', () => {
    const lines = block(1);
    expect(contentTextCaretOffset(lines, at(50 + 0.2 * 30, 17, 1), 1)).toBe(1);
    expect(contentTextCaretOffset(lines, at(50 + 0.8 * 30, 17, 1), 1)).toBe(4);
  });

  test('the nearest boundary wins inside a glyph', () => {
    const lines = block(1);
    expect(contentTextCaretOffset(lines, at(56 + 1.4, 17, 1), 1)).toBe(1); // left part of B
    expect(contentTextCaretOffset(lines, at(56 + 4.6, 17, 1), 1)).toBe(2); // right part of B
  });

  test('a click on the second line counts the first line and its newline', () => {
    const lines = block(1);
    expect(paragraphBlockText(lines, 1)).toBe('ABCDE\nFGHIJ');
    expect(contentTextCaretOffset(lines, at(50 + 0.8 * 30, 29, 1), 1)).toBe(6 + 4);
    expect(contentTextCaretOffset(lines, at(50 + 0.2 * 30, 29, 1), 1)).toBe(6 + 1);
  });

  test('the same page point maps to the same offset at another zoom', () => {
    for (const scale of [0.5, 1, 2.75, 4]) {
      const lines = block(scale);
      expect(contentTextCaretOffset(lines, at(74, 29, scale), scale)).toBe(10);
      expect(contentTextCaretOffset(lines, at(56.2, 17, scale), scale)).toBe(1);
    }
  });

  test('a word space inserted between runs is part of the offset', () => {
    const lines = [line([run('AB', 50, 20, 1), run('CD', 68, 20, 1)])];
    expect(paragraphBlockText(lines, 1)).toBe('AB CD');
    expect(contentTextCaretOffset(lines, at(62.5, 17, 1), 1)).toBe(2); // end of "AB"
    expect(contentTextCaretOffset(lines, at(67.5, 17, 1), 1)).toBe(3); // start of "CD"
    expect(contentTextCaretOffset(lines, at(74.5, 17, 1), 1)).toBe(4); // after "C"
  });

  test('boundaries inside a run follow the measured glyph advances', () => {
    // "WiW": W is five times as wide as i; the run spans 50..72 pt.
    const lines = [line([run('WiW', 50, 20, 1, { w: 22 })])];
    const measure = (text: string) => [...text].reduce((sum, ch) => sum + (ch === 'W' ? 10 : 2), 0);
    expect(contentTextCaretOffset(lines, at(58, 17, 1), 1, measure)).toBe(1); // inside the first W, right side
    expect(contentTextCaretOffset(lines, at(61.5, 17, 1), 1, measure)).toBe(2); // right of i
    expect(contentTextCaretOffset(lines, at(53, 17, 1), 1, measure)).toBe(0);
  });

  test('a click past either end of a line stays on that line', () => {
    const lines = block(1);
    expect(contentTextCaretOffset(lines, at(48.5, 29, 1), 1)).toBe(6);
    expect(contentTextCaretOffset(lines, at(81.5, 17, 1), 1)).toBe(5);
  });

  test('a click in the leading between lines takes the nearer line', () => {
    const lines = [line([run('ABCDE', 50, 20, 1)]), line([run('FGHIJ', 50, 40, 1)])];
    // line 1 occupies 12..22, line 2 occupies 32..42
    expect(contentTextCaretOffset(lines, at(74, 24, 1), 1)).toBe(4);
    expect(contentTextCaretOffset(lines, at(74, 31, 1), 1)).toBe(10);
  });

  test('the click tool admits only horizontal runs of unrotated pages', () => {
    const tilted = [run('ABCDE', 50, 20, 1, { dirAngleDeg: 30 }), run('FGHIJ', 50, 32, 1, { dirAngleDeg: 30 })];
    expect(detectParagraphs(tilted, 1)).toEqual([]);
    const content = { items: [{ str: 'ABCDE', dir: 'ltr', width: 30, height: 10, transform: [10, 0, 0, 10, 50, 100], fontName: 'F1', hasEOL: false }], styles: {} };
    const page = { id: 'p', sourceIndex: 0, widthPt: 300, heightPt: 200 };
    expect(textContentToDisplayTextRuns(content as never, { ...page, rotation: 0 }, 1).filter(Boolean)).toHaveLength(1);
    expect(textContentToDisplayTextRuns(content as never, { ...page, rotation: 90 }, 1).filter(Boolean)).toHaveLength(0);
    // Within the admitted ±5°, a slightly tilted run still maps along its advance.
    const slight = [line([run('ABCDE', 50, 20, 1, { dirAngleDeg: 3 })])];
    expect(contentTextCaretOffset(slight, at(74, 17, 1), 1)).toBe(4);
  });
});

// Engine glyph cells: rect, advance from origin to end, offsets in run.text.
function cells(text: string, xs: number[], baseline: number, rtl = false): CaretCell[] {
  const out: CaretCell[] = [];
  let offset = 0, i = 0;
  for (const ch of text) {
    const x0 = xs[i]!, x1 = xs[i + 1]!;
    out.push({ start: offset, end: offset + ch.length, rect: { x: Math.min(x0, x1), y: baseline - 8, w: Math.abs(x1 - x0), h: 10 },
      from: { x: x0, y: baseline }, to: { x: x1, y: baseline }, rtl });
    offset += ch.length; i += 1;
  }
  return out;
}

describe('contentTextCaretOffset with engine glyph geometry', () => {
  test('uses the glyph positions, not an estimate', () => {
    // "WiW": engine says W is 10 pt, i is 2 pt; the run box claims equal cells.
    const r = run('WiW', 50, 20, 1, { w: 22 });
    const lines = [line([r])];
    const glyphs = new Map([[r, cells('WiW', [50, 60, 62, 72], 20)]]);
    const of = (x: number) => contentTextCaretOffset(lines, at(x, 17, 1), 1, undefined, (run) => glyphs.get(run) ?? null);
    expect(of(58)).toBe(1);
    expect(of(61.5)).toBe(2);
    expect(of(63)).toBe(2);
    expect(of(68)).toBe(3); // equal-width cells would say 2 here
  });

  test('never lands inside a grapheme cluster', () => {
    // e + combining acute drawn as two glyphs; woman-technologist ZWJ emoji as one;
    // a regional-indicator flag as two glyphs.
    const text = 'e\u0301x\u{1F469}\u200D\u{1F4BB}y\u{1F1EF}\u{1F1F5}';
    const r = run(text, 50, 20, 1, { w: 60 });
    const glyphCells: CaretCell[] = [
      { start: 0, end: 1, rect: { x: 50, y: 12, w: 6, h: 10 }, from: { x: 50, y: 20 }, to: { x: 56, y: 20 }, rtl: false },
      { start: 1, end: 2, rect: { x: 53, y: 12, w: 3, h: 10 }, from: { x: 53, y: 20 }, to: { x: 56, y: 20 }, rtl: false },
      { start: 2, end: 3, rect: { x: 56, y: 12, w: 6, h: 10 }, from: { x: 56, y: 20 }, to: { x: 62, y: 20 }, rtl: false },
      { start: 3, end: 8, rect: { x: 62, y: 12, w: 12, h: 10 }, from: { x: 62, y: 20 }, to: { x: 74, y: 20 }, rtl: false },
      { start: 8, end: 9, rect: { x: 74, y: 12, w: 6, h: 10 }, from: { x: 74, y: 20 }, to: { x: 80, y: 20 }, rtl: false },
      { start: 9, end: 11, rect: { x: 80, y: 12, w: 6, h: 10 }, from: { x: 80, y: 20 }, to: { x: 86, y: 20 }, rtl: false },
      { start: 11, end: 13, rect: { x: 86, y: 12, w: 6, h: 10 }, from: { x: 86, y: 20 }, to: { x: 92, y: 20 }, rtl: false },
    ];
    const lines = [line([r])];
    const boundaries = new Set([0, 2, 3, 8, 9, 13]);
    for (let x = 49; x <= 93; x += 0.5) {
      const offset = contentTextCaretOffset(lines, at(x, 17, 1), 1, undefined, () => glyphCells)!;
      expect(boundaries.has(offset)).toBe(true);
      const fallback = contentTextCaretOffset(lines, at(x, 17, 1), 1)!;
      expect(boundaries.has(fallback)).toBe(true);
    }
    expect(contentTextCaretOffset(lines, at(55.5, 17, 1), 1, undefined, () => glyphCells)).toBe(2); // right part of é
    expect(contentTextCaretOffset(lines, at(73, 17, 1), 1, undefined, () => glyphCells)).toBe(8); // after the emoji
    expect(contentTextCaretOffset(lines, at(85, 17, 1), 1, undefined, () => glyphCells)).toBe(9); // left half of the two-glyph flag
  });

  test('right-to-left glyphs place the caret on their reading side', () => {
    // "אבג" painted right to left: alef at 62–68, bet 56–62, gimel 50–56.
    const r = run('\u05D0\u05D1\u05D2', 50, 20, 1);
    const glyphCells: CaretCell[] = [
      { start: 0, end: 1, rect: { x: 62, y: 12, w: 6, h: 10 }, from: { x: 62, y: 20 }, to: { x: 68, y: 20 }, rtl: true },
      { start: 1, end: 2, rect: { x: 56, y: 12, w: 6, h: 10 }, from: { x: 56, y: 20 }, to: { x: 62, y: 20 }, rtl: true },
      { start: 2, end: 3, rect: { x: 50, y: 12, w: 6, h: 10 }, from: { x: 50, y: 20 }, to: { x: 56, y: 20 }, rtl: true },
    ];
    const lines = [line([r])];
    const of = (x: number) => contentTextCaretOffset(lines, at(x, 17, 1), 1, undefined, () => glyphCells);
    expect(of(67)).toBe(0); // right half of alef: before it
    expect(of(63)).toBe(1); // left half of alef: after it
    expect(of(51)).toBe(3); // left end: after gimel
  });

  test('one right-to-left line does not disable the caret for the rest of the block', () => {
    const lines = [line([run('\u05D0\u05D1\u05D2', 50, 20, 1)]), line([run('FGHIJ', 50, 32, 1)])];
    expect(contentTextCaretOffset(lines, at(74, 29, 1), 1)).toBe(4 + 4);
    // and the measured fallback lays the RTL line out from the right
    expect(contentTextCaretOffset(lines, at(67, 17, 1), 1)).toBe(0);
    expect(contentTextCaretOffset(lines, at(51, 17, 1), 1)).toBe(3);
  });

  test('the measured fallback is linear in the run length', () => {
    const text = 'ab'.repeat(2000);
    const r = run(text, 0, 20, 1);
    let calls = 0;
    const measure = (t: string) => { calls += 1; return [...t].length; };
    expect(contentTextCaretOffset([line([r])], at(6 * 1001 + 1, 17, 1), 1, measure)).toBe(1001);
    expect(calls).toBeLessThan(50);
  });
});
