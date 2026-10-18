import { describe, expect, test } from "bun:test";
import type { CoreGlyph } from "../src/coreEngine";
import { quoteFromGlyphs } from "../src/extract";

/** Glyphs of one 10 pt line at y = 700, each 5 pt wide, from x = 72. */
function line(text: string, y = 700, x0 = 72): CoreGlyph[] {
  return [...text].map((ch, i) => {
    const x = x0 + i * 5;
    return {
      text: ch,
      origin: [x, y],
      end: [x + 5, y],
      loose: [x, y - 2, x + 5, y + 8],
      fontSize: 10,
      angle: 0,
      generated: false,
      hyphen: false,
    };
  });
}

function generated(text: string, at: [number, number]): CoreGlyph {
  return {
    text,
    origin: at,
    end: at,
    loose: [at[0], at[1], at[0], at[1]],
    fontSize: 10,
    angle: 0,
    generated: true,
    hyphen: false,
  };
}

const page = { originXPt: 0, originYPt: 0 };

describe("quoteFromGlyphs", () => {
  test("quotes the words under the highlight, not the whole line", () => {
    const glyphs = line("one two words here");
    // "two words" spans characters 4–12: x 92 to 137.
    const rect = { x: 92, y: 698, w: 45, h: 10 };
    expect(quoteFromGlyphs(glyphs, [rect], page)).toBe("two words");
  });

  test("a break PDFium inserted between runs becomes one space", () => {
    const glyphs = [
      ...line("left"),
      generated(" ", [300, 700]),
      ...line("right", 700, 100),
    ];
    const rect = { x: 70, y: 698, w: 60, h: 10 };
    expect(quoteFromGlyphs(glyphs, [rect], page)).toBe("left right");
  });

  test("a word hyphenated across a line break comes back whole", () => {
    const hyphen: CoreGlyph = { ...line("-", 700, 92)[0]!, hyphen: true };
    const glyphs = [
      ...line("exam"),
      hyphen,
      generated("\r", [0, 0]),
      generated("\n", [0, 0]),
      ...line("ple", 685),
    ];
    const rects = [
      { x: 72, y: 698, w: 25, h: 10 },
      { x: 72, y: 683, w: 15, h: 10 },
    ];
    expect(quoteFromGlyphs(glyphs, rects, page)).toBe("example");
  });

  test("rects are measured from the page box's corner", () => {
    const glyphs = line("cropped", 700, 108);
    // A crop box at (36, 48): the same glyphs sit 36 pt left, 48 pt down.
    const rect = { x: 72, y: 650, w: 35, h: 10 };
    expect(
      quoteFromGlyphs(glyphs, [rect], { originXPt: 36, originYPt: 48 }),
    ).toBe("cropped");
  });

  test("a highlight drawn to the ink, inside the advance, still takes its end glyphs", () => {
    const glyphs = line("one two three");
    // Other readers draw quads to the ink, which starts after a glyph's origin
    // and stops before its advance ends: "two" is x 92–107, drawn 93.5–105.5.
    const rect = { x: 93.5, y: 698, w: 12, h: 10 };
    expect(quoteFromGlyphs(glyphs, [rect], page)).toBe("two");
  });
});
