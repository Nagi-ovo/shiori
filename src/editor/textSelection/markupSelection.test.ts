import "../../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import type { PdfPageTextContent, PdfTextGlyph, PdfTextItem } from "../../pdf/engine/text";
import type { PageModel } from "../../pdf/model/types";
import { mapTextContentGlyphs, type MappedTextGlyph } from "./glyphGeometry";
import { glyphCaretAtPoint, markupRectsForRange, rangeInTextDiv } from "./markupSelection";
import { displayRectsToPdfRects } from "./highlightRects";

Object.defineProperties(globalThis, {
  Range: { configurable: true, value: window.Range },
  Node: { configurable: true, value: window.Node },
});
afterEach(() => document.body.replaceChildren());

const page: PageModel = { id: "p", sourceIndex: 0, rotation: 0, widthPt: 400, heightPt: 600 };
const font = { ascent: 0.8, descent: -0.2 };
function content(str: string, width: number, transform = [10, 0, 0, 10, 100, 500], dir = "ltr"): PdfPageTextContent {
  const item: PdfTextItem = { str, width, height: 10, transform, dir, fontName: "font", hasEOL: false };
  return { items: [item], styles: { font: { ...font, fontFamily: "sans-serif", vertical: false } }, lang: null };
}
/**
 * `text` set left to right on the baseline y = 500 from x = 100 at `size`
 * points, each character one glyph `width` thousandths of an em wide, its
 * advance cell running from 0.2 em below the baseline to 0.8 em above.
 */
function placedGlyphs(text: string, width = 500, size = 10): PdfTextGlyph[] {
  const advance = (width * size) / 1000;
  const [top, bottom] = [500 + size * font.ascent, 500 + size * font.descent];
  let x = 0;
  return [...text].map(unicode => {
    const [left, right] = [100 + x, 100 + x + advance];
    x += advance;
    return {
      text: unicode, fontName: "font", origin: { x: left, y: 500 }, end: { x: right, y: 500 },
      quad: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }],
    };
  });
}
function divWithText(text: string): HTMLElement {
  const div = document.createElement("span");
  div.textContent = text;
  document.body.append(div);
  return div;
}
function select(div: HTMLElement, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(div.firstChild!, start); range.setEnd(div.firstChild!, end);
  return range;
}

describe("matching a text run to its glyphs", () => {
  test("matches PDF-inserted whitespace without inventing extra glyphs", () => {
    const result = mapTextContentGlyphs(content("A B", 10), placedGlyphs("AB"))[0]!;
    expect(result.map(g => [g.start, g.endOffset, g.origin.x])).toEqual([[0, 1, 100], [2, 3, 105]]);
  });

  test("preserves fullwidth punctuation and expands normalized ligatures atomically", () => {
    const fullwidth = mapTextContentGlyphs(content("（批）", 15), placedGlyphs("（批）"))[0]!;
    expect(fullwidth.map(g => g.text)).toEqual(["（", "批", "）"]);
    const ligature = mapTextContentGlyphs(content("ffi", 5), placedGlyphs("ﬃ"))[0]!;
    expect(ligature.map(g => [g.start, g.endOffset])).toEqual([[0, 3]]);
  });

  test("matches RTL reading order against glyphs positioned in the opposite order", () => {
    const rtl = mapTextContentGlyphs(content("בא", 10, undefined, "rtl"), placedGlyphs("אב"))[0]!;
    expect(rtl.map(g => [g.text, g.origin.x, g.start])).toEqual([["ב", 105, 0], ["א", 100, 1]]);
  });

  test("rejects geometry whose text does not match instead of guessing offsets", () => {
    expect(mapTextContentGlyphs(content("other", 20), placedGlyphs("text"))).toEqual([null]);
  });

  test("matches runs coalesced across equivalent font resources, as in inline links", () => {
    const glyphs = placedGlyphs("ABCD");
    glyphs[1]!.fontName = glyphs[2]!.fontName = "link-font";
    const mapped = mapTextContentGlyphs(content("ABCD", 20), glyphs)[0]!;
    expect(mapped.map(g => [g.text, g.origin.x])).toEqual([["A", 100], ["B", 105], ["C", 110], ["D", 115]]);
  });

  test("does not include a preceding glyph whose advance overlaps the run's start", () => {
    const glyphs = placedGlyphs("AB");
    const previous = { ...glyphs[0]!, text: "X", origin: { x: 98, y: 500 }, end: { x: 102, y: 500 } };
    const mapped = mapTextContentGlyphs(content("AB", 10), [previous, ...glyphs])[0]!;
    expect(mapped.map(g => g.text)).toEqual(["A", "B"]);
  });
});

describe("native selection to precise markup", () => {
  test("does not pad a partial selection of narrow i characters into the next glyph", () => {
    const div = divWithText("iiiiiiii");
    const mapped = mapTextContentGlyphs(content("iiiiiiii", 21.312, [12, 0, 0, 12, 100, 500]), placedGlyphs("iiiiiiii", 222, 12));
    const geometry = { textDivs: [div], textRuns: [null], glyphs: mapped };
    const rects = markupRectsForRange(select(div, 0, 3), geometry, page, 1, { left: 200, top: 100 });
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x).toBe(100);
    expect(rects[0]!.w).toBeCloseTo(7.992, 8);
    expect(rects[0]!.x + rects[0]!.w).toBeCloseTo(mapped[0]![3]!.origin.x, 8);
  });

  test("keeps a sub-two-pixel character at low zoom", () => {
    const div = divWithText("ii");
    const mapped = mapTextContentGlyphs(content("ii", 1.776, [4, 0, 0, 4, 100, 500]), placedGlyphs("ii", 222, 4));
    const rects = markupRectsForRange(select(div, 0, 1), { textDivs: [div], textRuns: [null], glyphs: mapped }, page, 0.5, { left: 0, top: 0 });
    expect(rects).toHaveLength(1);
    expect(rects[0]!.w).toBeCloseTo(0.444, 8);
  });

  test("excludes the next text span when a range ends at offset zero", () => {
    const one = divWithText("AB"), two = divWithText("CD");
    const range = select(one, 0, 2); range.setEnd(two.firstChild!, 0);
    expect(rangeInTextDiv(range, one)?.toString()).toBe("AB");
    expect(rangeInTextDiv(range, two)).toBeNull();
    expect(rangeInTextDiv(select(two, 0, 1), one)).toBeNull();
  });

  test.each([0, 90, 180, 270] as const)("preserves CropBox and PDF coordinates at rotation %i", rotation => {
    const div = divWithText("A");
    const mapped = mapTextContentGlyphs(content("A", 5), placedGlyphs("A"));
    const croppedPage = { ...page, rotation, originXPt: 50, originYPt: 60 };
    for (const scale of [0.5, 1, 1.75, 3]) {
      const rects = markupRectsForRange(select(div, 0, 1), { textDivs: [div], textRuns: [null], glyphs: mapped }, croppedPage, scale, { left: 47, top: 92 });
      const pdf = displayRectsToPdfRects(rects, croppedPage, scale)[0]!;
      expect(pdf.x).toBeCloseTo(50, 8);
      expect(pdf.y).toBeCloseTo(438, 8);
      expect(pdf.w).toBeCloseTo(5, 8);
      expect(pdf.h).toBeCloseTo(10, 8);
    }
  });

  test("selects an entire ligature cell even when its Unicode string has several letters", () => {
    const div = divWithText("ffi");
    const mapped = mapTextContentGlyphs(content("ffi", 5), placedGlyphs("ﬃ"));
    const rects = markupRectsForRange(select(div, 1, 2), { textDivs: [div], textRuns: [null], glyphs: mapped }, page, 1, { left: 0, top: 0 });
    expect(rects).toEqual([{ x: 100, y: 92, w: 5, h: 10 }]);
  });

  test("hit tests the painted glyph cell instead of the DOM's fallback font", () => {
    const div = divWithText("ABC");
    const mapped = mapTextContentGlyphs(content("ABC", 15), placedGlyphs("ABC"));
    const geometry = { textDivs: [div], textRuns: [null], glyphs: mapped };
    expect(glyphCaretAtPoint(geometry, page, 1, { x: 107, y: 96 })?.offset).toBe(1);
    expect(glyphCaretAtPoint(geometry, page, 1, { x: 108, y: 96 })?.offset).toBe(2);
    expect(glyphCaretAtPoint(geometry, page, 1, { x: 250, y: 96 })).toBeNull();
    expect(glyphCaretAtPoint(geometry, page, 1, { x: 105, y: 200 })).toBeNull();
  });

  test("does not turn mixed font sizes into one tall band", () => {
    const div = divWithText("AB");
    const mapped = mapTextContentGlyphs(content("AB", 10), placedGlyphs("AB"))[0]!;
    const raised: MappedTextGlyph = { ...mapped[1]!, quad: [{ x: 105, y: 512 }, { x: 108, y: 512 }, { x: 108, y: 506 }, { x: 105, y: 506 }] };
    const rects = markupRectsForRange(select(div, 0, 2), { textDivs: [div], textRuns: [null], glyphs: [[mapped[0]!, raised]] }, page, 1, { left: 0, top: 0 });
    expect(rects).toHaveLength(2);
    expect(rects.map(r => r.h).sort((a,b)=>a-b)).toEqual([6, 10]);
  });
});

test("persists and exports exactly the selected narrow glyph advances", async () => {
  const { PDFDocument, StandardFonts, PDFArray, PDFName, PDFNumber, PDFDict } = await import("pdf-lib");
  const { exportPdf } = await import("../../pdf/export/exportPdf");
  const { applyHighlightGesture } = await import("../highlights/merge");
  const source = await PDFDocument.create();
  const sourcePage = source.addPage([400, 600]);
  const helvetica = await source.embedFont(StandardFonts.Helvetica);
  sourcePage.drawText("iiiiiiii", { x: 100, y: 500, size: 12, font: helvetica });
  const div = divWithText("iiiiiiii");
  const mapped = mapTextContentGlyphs(content("iiiiiiii", 21.312, [12, 0, 0, 12, 100, 500]), placedGlyphs("iiiiiiii", 222, 12));
  const display = markupRectsForRange(select(div, 0, 3), { textDivs: [div], textRuns: [null], glyphs: mapped }, page, 2, { left: 19, top: 53 });
  const gesture = applyHighlightGesture({
    overlays: [], pageId: page.id, rects: displayRectsToPdfRects(display, page, 2),
    color: "#ffee00", opacity: 0.45, makeId: () => "exact-glyphs",
  });
  const result = await exportPdf(await source.save(), { pages: [page], overlays: gesture.overlays });
  const loaded = await PDFDocument.load(result.bytes);
  const annot = loaded.getPage(0).node.Annots()!.lookup(0, PDFDict);
  const quad = annot.lookup(PDFName.of("QuadPoints"), PDFArray);
  const values = Array.from({ length: quad.size() }, (_, i) => quad.lookup(i, PDFNumber).asNumber());
  const right = 100 + helvetica.widthOfTextAtSize("iii", 12);
  expect(values).toHaveLength(8);
  expect(values[0]).toBe(100);
  expect(values[2]).toBeCloseTo(right, 8);
  expect(values[4]).toBe(100);
  expect(values[6]).toBeCloseTo(right, 8);
});

test("clips selected glyphs to the visible crop instead of painting outside the page", () => {
  const div = divWithText("AB");
  const mapped = mapTextContentGlyphs(content("AB", 10), placedGlyphs("AB"));
  const cropped = { ...page, originXPt: 103, widthPt: 5 };
  const rects = markupRectsForRange(select(div, 0, 2), { textDivs: [div], textRuns: [null], glyphs: mapped }, cropped, 1, { left: 0, top: 0 });
  expect(rects).toEqual([{ x: 0, y: 92, w: 5, h: 10 }]);
});

test("does not bridge an unselected glyph in a visually reordered run", () => {
  const div = divWithText("ABCD");
  const base = mapTextContentGlyphs(content("ABCD", 4), placedGlyphs("ABCD", 100))[0]!;
  const positions = [100, 103, 101, 102];
  const glyphs = base.map((g, i) => {
    const dx = positions[i]! - g.origin.x;
    return { ...g, origin: { ...g.origin, x: g.origin.x + dx }, end: { ...g.end, x: g.end.x + dx },
      quad: g.quad.map(p => ({ ...p, x: p.x + dx })) };
  });
  const rects = markupRectsForRange(select(div, 0, 2), { textDivs: [div], textRuns: [null], glyphs: [glyphs] }, page, 1, { left: 0, top: 0 });
  expect(rects.map(r => [r.x, r.w])).toEqual([[100, 1], [103, 1]]);
});

test("leaves bidirectional caret affinity to native selection", () => {
  const div = divWithText("בא");
  const mapped = mapTextContentGlyphs(content("בא", 10, undefined, "rtl"), placedGlyphs("אב"));
  const neighbour = divWithText("X");
  const neighbourGlyphs = mapTextContentGlyphs(content("X", 5), placedGlyphs("X"));
  const geometry = { textDivs: [div, neighbour], textRuns: [null, null], glyphs: [...mapped, ...neighbourGlyphs] };
  // A physical right edge is not necessarily the logical end of a bidi
  // character; the browser owns affinity and mixed-script word boundaries.
  expect(glyphCaretAtPoint(geometry, page, 1, { x: 107, y: 96 })).toBeNull();
  // Keeping the native caret must not disable the precise markup geometry.
  expect(markupRectsForRange(select(div, 0, 1), geometry, page, 1, { left: 0, top: 0 }))
    .toEqual([{ x: 105, y: 92, w: 5, h: 10 }]);
});
