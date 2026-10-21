import { describe, expect, test } from "bun:test";
import { mapTextContentGlyphs } from "../../editor/textSelection/glyphGeometry";
import { semanticTextContentToString } from "../../editor/textSelection/semanticText";
import { pageTextFromPdfiumGlyphs, type PdfiumGlyph } from "./pdfiumText";
import type { PdfTextItem } from "./text";

// Glyphs the way shiori-core reports them: 12 pt, each letter 6 pt wide,
// Helvetica's descriptor (ascent 9, descent -3 at 12 pt) unless overridden.
type Font = Pick<PdfiumGlyph, "fontName" | "fontFlags" | "ascent" | "descent" | "fontSize">;
const helvetica: Font = { fontName: "Helvetica", fontFlags: 32, ascent: 9, descent: -3, fontSize: 12 };
const courier: Font = { fontName: "Courier", fontFlags: 33, ascent: 9, descent: -3, fontSize: 12 };

function word(text: string, x: number, y: number, font = helvetica, angle = 0): PdfiumGlyph[] {
  const dx = Math.cos(angle) * 6;
  const dy = Math.sin(angle) * 6;
  return [...text].map((ch, i) => ({
    ...font,
    text: ch,
    origin: [x + dx * i, y + dy * i],
    end: [x + dx * (i + 1), y + dy * (i + 1)],
    angle,
    generated: false,
  }));
}

// Right-to-left: PDFium reports glyphs in reading order, each one drawn to
// the left of the one before, the first ending at `right`.
function rtlWord(text: string, right: number, y: number, font = helvetica): PdfiumGlyph[] {
  return [...text].map((ch, i) => ({
    ...font,
    text: ch,
    origin: [right - 6 * (i + 1), y],
    end: [right - 6 * i, y],
    angle: 0,
    generated: false,
  }));
}

function generated(text: string, x: number, y: number): PdfiumGlyph {
  return {
    text,
    origin: [x, y],
    end: [x, y],
    fontSize: 0,
    angle: 0,
    generated: true,
    fontName: "",
    fontFlags: 0,
    ascent: 0,
    descent: 0,
  };
}

const textItems = (glyphs: PdfiumGlyph[]) =>
  pageTextFromPdfiumGlyphs(glyphs, null).content.items as PdfTextItem[];

describe("pageTextFromPdfiumGlyphs", () => {
  test("a line of words is one item, and every glyph maps onto it", () => {
    // "Hello" at 72, PDFium's space, "world" 3 pt after the o.
    const glyphs = [...word("Hello", 72, 700), generated(" ", 102, 700), ...word("world", 105, 700)];
    const text = pageTextFromPdfiumGlyphs(glyphs, "en");
    const items = text.content.items as PdfTextItem[];
    expect(items.map((item) => item.str)).toEqual(["Hello world"]);
    // From the H's origin to the d's advance end.
    expect(items[0]!.width).toBe(63);
    expect(semanticTextContentToString(text.content)).toBe("Hello world");
    const mapped = mapTextContentGlyphs(text.content, text.glyphs!);
    expect(mapped[0]?.map((glyph) => glyph.text).join("")).toBe("Helloworld");
  });

  test("a line break PDFium inferred ends the line", () => {
    const items = textItems([...word("One", 72, 700), generated("\r\n", 90, 700), ...word("Two", 72, 686)]);
    expect(items.map((item) => [item.str, item.hasEOL])).toEqual([
      ["One", true],
      ["Two", false],
    ]);
  });

  test("a gap wider than a space splits the line, and a space item spans it", () => {
    // "Name" ends at 96; "Value" starts at 200, far past a space.
    const items = textItems([...word("Name", 72, 700), generated(" ", 96, 700), ...word("Value", 200, 700)]);
    expect(items.map((item) => item.str)).toEqual(["Name", " ", "Value"]);
    const space = items[1]!;
    expect([space.transform[4], space.transform[5], space.width]).toEqual([96, 700, 104]);
  });

  test("a raised glyph starts its own item", () => {
    // A superscript 2 lifted 4 pt off the baseline right after "x".
    const items = textItems([...word("x", 72, 700), ...word("2", 78, 704)]);
    expect(items.map((item) => item.str)).toEqual(["x", "2"]);
  });

  test("a change of font starts an item in that font's family", () => {
    const text = pageTextFromPdfiumGlyphs([...word("Say", 72, 700), ...word("ls", 90, 700, courier)], null);
    const items = text.content.items as PdfTextItem[];
    expect(items.map((item) => item.str)).toEqual(["Say", "ls"]);
    const families = items.map((item) => text.content.styles[item.fontName]!.fontFamily);
    expect(families).toEqual(["sans-serif", "monospace"]);
    expect(items.map((item) => text.fontNames.get(item.fontName))).toEqual(["Helvetica", "Courier"]);
  });

  test("text on a turned baseline keeps its direction", () => {
    // "Up" running up the page from (300, 400).
    const text = pageTextFromPdfiumGlyphs(word("Up", 300, 400, helvetica, Math.PI / 2), null);
    const [item] = text.content.items as PdfTextItem[];
    expect(item!.transform.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 12, -12, 0, 300, 400]);
    expect(item!.width).toBeCloseTo(12, 6);
    expect(mapTextContentGlyphs(text.content, text.glyphs!)[0]).toHaveLength(2);
    // The cell's ascent lies to the left of an upward baseline.
    const [top, , , bottom] = text.glyphs![0]!.quad;
    expect([top!.x, bottom!.x].map((v) => Math.round(v * 1000) / 1000)).toEqual([291, 303]);
  });

  test("a glyph's cell spans the font's ascent and descent", () => {
    const { glyphs } = pageTextFromPdfiumGlyphs(word("H", 72, 700), null);
    expect(glyphs![0]!.quad).toEqual([
      { x: 72, y: 709 },
      { x: 78, y: 709 },
      { x: 78, y: 697 },
      { x: 72, y: 697 },
    ]);
  });

  test("a diagonal watermark PDFium put inside a word leaves the word whole", () => {
    // PDFium's order: "rein", a line break, the watermark across the line,
    // another line break, then "forces" right where "rein" stopped.
    const glyphs = [
      ...word("rein", 72, 700),
      generated("\r\n", 96, 700),
      ...word("wm", 60, 650, courier, Math.PI / 4),
      generated("\r\n", 80, 670),
      ...word("forces", 96, 700),
      generated("\r\n", 132, 700),
      ...word("Next", 72, 686),
    ];
    const items = textItems(glyphs);
    expect(items.map((item) => [item.str, item.hasEOL])).toEqual([
      ["reinforces", true],
      ["wm", true],
      ["Next", false],
    ]);
    expect(items[0]!.width).toBe(60);
  });

  test("right-to-left words stay one item and read in order", () => {
    // "שלום", PDFium's space, then "עולם" 3 pt further left.
    const glyphs = [...rtlWord("שלום", 124, 700), generated(" ", 100, 700), ...rtlWord("עולם", 97, 700)];
    const text = pageTextFromPdfiumGlyphs(glyphs, "he");
    const items = text.content.items as PdfTextItem[];
    expect(items.map((item) => [item.str, item.dir])).toEqual([["שלום עולם", "rtl"]]);
    // From the leftmost glyph's origin to the first glyph's advance end.
    expect([items[0]!.transform[4], items[0]!.width]).toEqual([73, 51]);
    expect(semanticTextContentToString(text.content)).toBe("שלום עולם");
    const mapped = mapTextContentGlyphs(text.content, text.glyphs!);
    expect(mapped[0]?.map((glyph) => glyph.text).join("")).toBe("שלוםעולם");
  });

  test("a wide right-to-left gap gets a space item spanning it", () => {
    // "שלום" starts at 100; "עולם" ends at 60, far past a space.
    const glyphs = [...rtlWord("שלום", 124, 700), generated(" ", 100, 700), ...rtlWord("עולם", 60, 700)];
    const items = textItems(glyphs);
    expect(items.map((item) => item.str)).toEqual(["שלום", " ", "עולם"]);
    const space = items[1]!;
    expect([space.transform[4], space.width]).toEqual([60, 40]);
  });

  test("a right-to-left word split by a font change reads whole", () => {
    const glyphs = [...rtlWord("של", 124, 700), ...rtlWord("ום", 112, 700, courier)];
    const text = pageTextFromPdfiumGlyphs(glyphs, "he");
    const items = text.content.items as PdfTextItem[];
    expect(items.map((item) => [item.str, item.dir])).toEqual([
      ["של", "rtl"],
      ["ום", "rtl"],
    ]);
    expect(semanticTextContentToString(text.content)).toBe("שלום");
  });

  test("a right-to-left word with one letter in another font reads whole", () => {
    // A lone letter is a run of one glyph: nothing shows its direction but
    // its script.
    const first = [...rtlWord("ש", 124, 700, courier), ...rtlWord("לום", 118, 700)];
    const last = [...rtlWord("שלו", 124, 700), ...rtlWord("ם", 106, 700, courier)];
    for (const glyphs of [first, last]) {
      const text = pageTextFromPdfiumGlyphs(glyphs, "he");
      const items = text.content.items as PdfTextItem[];
      expect(items.map((item) => item.dir)).toEqual(["rtl", "rtl"]);
      expect(semanticTextContentToString(text.content)).toBe("שלום");
    }
  });

  test("a space after a one-letter right-to-left run spans the gap on its left", () => {
    // "ו" (and), PDFium's space, then "שלום" ending 40 pt further left.
    const glyphs = [...rtlWord("ו", 124, 700), generated(" ", 118, 700), ...rtlWord("שלום", 78, 700)];
    const items = textItems(glyphs);
    expect(items.map((item) => item.str)).toEqual(["ו", " ", "שלום"]);
    expect([items[1]!.transform[4], items[1]!.width]).toEqual([78, 40]);
  });

  test("text in another font on the same baseline keeps its place", () => {
    // "site", a ";" in another font, then "go" right after the semicolon.
    const glyphs = [...word("site", 72, 700), ...word(";", 96, 700, courier), ...word("go", 102, 700)];
    const text = pageTextFromPdfiumGlyphs(glyphs, null);
    expect((text.content.items as PdfTextItem[]).map((item) => item.str)).toEqual(["site", ";", "go"]);
    expect(semanticTextContentToString(text.content)).toBe("site;go");
  });
});

