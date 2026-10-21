import { describe, expect, test } from "bun:test";
import type { CoreGlyph } from "../src/coreEngine";
import { QuoteWorkLimitError, pageQuoter, quoteFromGlyphs } from "../src/extract";

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

describe("pageQuoter work", () => {
  test("a highlight on one line of a long page reads about that line, not the page", () => {
    // 400 lines of 50 glyphs: 20,000 glyphs, one 12 pt line apart.
    const glyphs = Array.from({ length: 400 }, (_, i) =>
      line("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwx", 100 + i * 12),
    ).flat();
    const budget = { visits: 500 };
    const quote = pageQuoter(glyphs, page, budget);
    // Line 200 sits at y = 2500; "fghij" is x 97 to 122.
    expect(quote([{ x: 97, y: 2498, w: 25, h: 10 }])).toBe("fghij");
    expect(quote([{ x: 97, y: 2498, w: 25, h: 10 }])).toBe("fghij");
  });

  test("a page that piles every glyph under each highlight stops at the budget", () => {
    // A hostile file: one line of 20,000 glyphs and highlight after highlight
    // over all of it. Without a cap this is annotations x glyphs x rects.
    const glyphs = line("x".repeat(20_000));
    const quote = pageQuoter(glyphs, page, { visits: 100_000 });
    const rect = { x: 0, y: 690, w: 200_000, h: 20 };
    expect(() => {
      for (let i = 0; i < 10; i += 1) quote([rect]);
    }).toThrow(QuoteWorkLimitError);
  });
});
