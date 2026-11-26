// Glyph geometry of an edit as the written page paints it (the text layer's
// engine glyphs), for the caret of a click that re-opens an edited block.
//
// Failure list: glyphs are matched to the edit's text by position instead of
// content (a writer that keeps "E" in place after "BCD" → "x" leaves a gap
// the edit's text does not have); whitespace the writer draws as a gap (or
// not at all) breaks the match; a glyph standing for several characters
// (ligature, combining sequence) is split or dropped; another text's glyphs
// inside the region are taken for the edit's; a mismatch is trusted instead
// of refused; rows a writer wrapped are read as the edit's text lines; a
// stale layer's glyphs are served for newer text; a neighbour's glyph next
// to a partial edit is pulled in; cells go wrong after zoom.
import { describe, expect, test } from 'bun:test';
import type { PdfTextGlyph } from '../../pdf/engine/text';
import type { ContentTextOverlay, PageModel } from '../../pdf/model/types';
import { alignGlyphs, writtenCaretLines } from './contentTextFrameCells';
import { caretInLines } from './contentTextCaret';

const glyph = (text: string, x: number, baseline = 100, w = 6): PdfTextGlyph => ({
  text, fontName: 'F1', origin: { x, y: baseline }, end: { x: x + w, y: baseline },
  quad: [{ x, y: baseline - 2 }, { x: x + w, y: baseline - 2 }, { x: x + w, y: baseline + 8 }, { x, y: baseline + 8 }],
});
const page: PageModel = { id: 'p', sourceIndex: 0, widthPt: 300, heightPt: 200, rotation: 0 };
const edit = (text: string, patch: Partial<ContentTextOverlay> = {}): ContentTextOverlay => ({
  id: 'e', type: 'contentText', pageId: 'p', rect: { x: 49, y: 86, w: 32, h: 25 }, coverRects: [{ x: 49, y: 98, w: 32, h: 13 }],
  originalText: 'ABCDE', text, fontSize: 10, color: '#000000', bold: false, align: 'left', fontFamily: 'mono', backgroundColor: '#ffffff', ...patch,
});

describe('alignGlyphs', () => {
  test('matches by content, skipping whitespace the writer does not draw', () => {
    expect(alignGlyphs('Ax E', [glyph('A', 50), glyph('x', 56), glyph('E', 74)]))
      .toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 3, end: 4 }]);
  });
  test('a glyph may stand for several characters', () => {
    expect(alignGlyphs('fine é', [glyph('fi', 50), glyph('n', 56), glyph('e', 62), glyph('e', 74), glyph('́', 74)]))
      .toEqual([{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }, { start: 5, end: 6 }, { start: 6, end: 7 }]);
  });
  test('refuses a mismatch or leftover text instead of guessing', () => {
    expect(alignGlyphs('ABC', [glyph('A', 50), glyph('X', 56), glyph('C', 62)])).toBeNull();
    expect(alignGlyphs('ABC', [glyph('A', 50), glyph('B', 56)])).toBeNull();
  });
});

describe('writtenCaretLines', () => {
  test('a re-open click on a gap-kept glyph lands on its own side of it', () => {
    // "BCD" → "x": the writer keeps E where it was (x 74–80).
    const o = edit('AxE');
    const lines = writtenCaretLines(o, page, 1, [glyph('A', 50), glyph('x', 56), glyph('E', 74), glyph('Z', 200)])!;
    // display y of baseline 100 on a 200 pt page is 100; glyph box 92..102
    expect(caretInLines(lines, { x: 75, y: 97 }, o.text)).toBe(2); // left half of E: before it
    expect(caretInLines(lines, { x: 79, y: 97 }, o.text)).toBe(3);
  });

  test('rows a writer wrapped stay separate rows', () => {
    const o = edit('AB-long', { rect: { x: 49, y: 80, w: 32, h: 31 } });
    const lines = writtenCaretLines(o, page, 1, [...[...'AB-lo'].map((c, i) => glyph(c, 50 + 6 * i)), glyph('n', 50, 88), glyph('g', 56, 88)])!;
    expect(lines).toHaveLength(2);
    expect(caretInLines(lines, { x: 55, y: 109 }, o.text)).toBe(6); // right half of "n" on row 2
  });

  test('text the glyphs do not spell gets nothing; zoom converts at the call', () => {
    const o = edit('AxE'), glyphs = [glyph('A', 50), glyph('x', 56), glyph('E', 74)];
    expect(writtenCaretLines({ ...o, text: 'AxEE' }, page, 1, glyphs)).toBeNull();
    expect(writtenCaretLines(o, page, 1, [glyph('A', 50), glyph('Q', 56), glyph('E', 74)])).toBeNull();
    const zoomed = writtenCaretLines(o, page, 2, glyphs)!;
    expect(caretInLines(zoomed, { x: 75 * 2, y: 97 * 2 }, o.text)).toBe(2);
  });

  test('an unedited neighbour beside a partial edit stays out', () => {
    // edit covers "BC" (x 56–68) of "ABCDE"; A and D sit right next to it
    const o = edit('bc', { rect: { x: 56, y: 98, w: 12, h: 12 }, coverRects: [{ x: 56, y: 98, w: 12, h: 12 }] });
    const lines = writtenCaretLines(o, page, 1, [glyph('A', 50), glyph('b', 56), glyph('c', 62), glyph('D', 68)]);
    expect(lines?.[0]?.cells.map(c => c.start)).toEqual([0, 1]);
  });
});
