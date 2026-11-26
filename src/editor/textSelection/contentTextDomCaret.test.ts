// The caret of a click that re-opens a block already holding an edit.
//
// Failure list: the second click into an edited string of another length
// opens at 0 (or at the source offset of the old text); a hit inside the
// earlier edit is read from the source glyphs underneath, not from the text
// that edit shows; a hit outside it ignores the length change; the edit's
// layout is read from a stale or placeholder render (text mismatch); a
// grapheme cluster in the edited text is split.
import '../../test/setupDom';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { TextRunDisplayBounds } from './highlightRects';
import type { DetectedLine } from './paragraphDetect';
import { absorbEdits } from './absorbText';
import { openedEditCaret } from './contentTextDomCaret';
import type { PageModel } from '../../pdf/model/types';

// Layout stub: each UTF-16 unit of the committed text is a 6 px cell
// starting at x=64 (client), on one 10 px line at y=50..60. The edit's box
// covers the source "ABCDE" (client 64..94); longer text overflows it. The
// text-layer root sits at client (20, 30), so display = client − (20, 30).
const { Range, DOMRect, Element } = window as unknown as typeof globalThis;
let rangeDescriptor: PropertyDescriptor | undefined;
let boxDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  rangeDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  boxDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Range.prototype.getClientRects = function (this: Range) {
    const i = this.startOffset, n = this.endOffset - this.startOffset;
    if (this.startContainer.textContent?.slice(i, i + n) === '\n') return [] as unknown as DOMRectList;
    return [new DOMRect(64 + i * 6, 50, n * 6, 10)] as unknown as DOMRectList;
  };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.getAttribute('data-root') === 'true') return new DOMRect(20, 30, 600, 400);
    if (this.getAttribute('role') === 'group') return new DOMRect(64, 48, 30, 14);
    return new DOMRect(0, 0, 0, 0);
  };
});
afterEach(() => {
  if (rangeDescriptor) Object.defineProperty(Range.prototype, 'getClientRects', rangeDescriptor);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  if (boxDescriptor) Object.defineProperty(Element.prototype, 'getBoundingClientRect', boxDescriptor);
  else Reflect.deleteProperty(Element.prototype, 'getBoundingClientRect');
  document.body.replaceChildren();
});

function mount(id: string, text: string) {
  const root = document.createElement('div'); root.dataset.root = 'true';
  const group = document.createElement('div'); group.setAttribute('role', 'group'); group.dataset.overlayId = id;
  const inner = document.createElement('div'); inner.textContent = text; group.append(inner);
  document.body.append(root, group);
  return root;
}
// A source line "say ABCDE now" in display space (6 px cells from x=20).
const sourceRun: TextRunDisplayBounds = { text: 'say ABCDE now', x: 20, y: 18, w: 78, h: 10, baselineY: 26, fontSizePt: 10 };
const lines: DetectedLine[] = [{ runs: [sourceRun], x: 20, right: 98, width: 78, top: 18, bottom: 28, baselineY: 26, fontSizePt: 10 }];
const displayOf = (clientX: number) => ({ x: clientX - 20, y: 55 - 30 });
const page: PageModel = { id: 'p', sourceIndex: 0, widthPt: 300, heightPt: 200, rotation: 0 };
// The old edit's box over the source "ABCDE": display x 44–74, y 18–32 → PDF.
const oldEdit = (text: string) => ({ id: 'old', originalText: 'ABCDE', text, rect: { x: 44, y: 168, w: 30, h: 14 }, coverRects: [], fontSize: 10 });

test('a second click into a longer edited string lands at the hit in the edited text', () => {
  const old = oldEdit('AB-long-DE');
  const root = mount('old', old.text);
  const absorption = absorbEdits('say ABCDE now', [old]);
  // right half of the 8th unit ("-" after "long"): after it, offset 8 in the edit
  const point = displayOf(64 + 7 * 6 + 4);
  expect(openedEditCaret({ page, lines, point, scale: 1, absorbed: [old], absorption, root })).toBe(4 + 8);
});

test('a second click into a shorter edited string, and outside it, map by the length change', () => {
  const old = oldEdit('X');
  const root = mount('old', old.text);
  const absorption = absorbEdits('say ABCDE now', [old]);
  expect(openedEditCaret({ page, lines, point: displayOf(64 + 4), scale: 1, absorbed: [old], absorption, root })).toBe(4 + 1);
  // outside the edit's box: source geometry, then shifted (source "n" of "now" at 10)
  expect(openedEditCaret({ page, lines, point: { x: 20 + 10 * 6 + 1, y: 22 }, scale: 1, absorbed: [old], absorption, root })).toBe(10 - 4);
});

test('a render whose text does not match the edit is not trusted', () => {
  const old = oldEdit('AB-long-DE');
  const root = mount('old', 'placeholder');
  const absorption = absorbEdits('say ABCDE now', [old]);
  const offset = openedEditCaret({ page, lines, point: displayOf(64 + 7 * 6 + 4), scale: 1, absorbed: [old], absorption, root });
  expect(offset).not.toBe(4 + 8);
});

test('an emoji in the edited text is never split', () => {
  const text = 'A\u{1F469}‍\u{1F4BB}B';
  const old = oldEdit(text);
  const root = mount('old', text);
  const absorption = absorbEdits('say ABCDE now', [old]);
  for (let x = 64; x < 64 + text.length * 6; x += 1) {
    const offset = openedEditCaret({ page, lines, point: displayOf(x), scale: 1, absorbed: [old], absorption, root })! - 4;
    expect([0, 1, 6, 7]).toContain(offset);
  }
});

test('the written frame wins over the CSS layout where they disagree', () => {
  // "BCD" → "x": the writer keeps "E" in place (display x 68–74), while the
  // committed DOM render sets "AxE" contiguously from client 64 (display 44).
  const old = oldEdit('AxE');
  const root = mount('old', old.text);
  const absorption = absorbEdits('say ABCDE now', [old]);
  const glyph = (text: string, x: number) => ({ text, fontName: 'F', origin: { x, y: 172 }, end: { x: x + 6, y: 172 },
    quad: [{ x, y: 170 }, { x: x + 6, y: 170 }, { x: x + 6, y: 180 }, { x, y: 180 }] });
  const frameGlyphs = [glyph('A', 44), glyph('x', 50), glyph('E', 68)];
  // left half of the painted "E" (display y 20..30 for PDF y 170..180)
  expect(openedEditCaret({ page, lines, point: { x: 69, y: 25 }, scale: 1, frame: { glyphs: [frameGlyphs] }, absorbed: [old], absorption, root })).toBe(4 + 2);
  expect(openedEditCaret({ page, lines, point: { x: 73, y: 25 }, scale: 1, frame: { glyphs: [frameGlyphs] }, absorbed: [old], absorption, root })).toBe(4 + 3);
  // without the page's glyphs (a layer mid-rebuild) the committed layout answers
  expect(openedEditCaret({ page, lines, point: { x: 49, y: 25 }, scale: 1, absorbed: [old], absorption, root })).toBe(4 + 1);
});
