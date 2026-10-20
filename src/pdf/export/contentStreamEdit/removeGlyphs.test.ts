import { describe, expect, test } from "bun:test";
import type { PdfRect } from "../../model/types";
import { tokenizeContentStream } from "./tokenizer";
import { walkTextPlacements, type GlyphPlacement } from "./textState";
import type { ContentFontInfo } from "./glyphWidths";
import { removeCoveredGlyphs } from "./removeGlyphs";

const enc = new TextEncoder();
const dec = new TextDecoder("latin1");

const latinFont: ContentFontInfo = {
  ok: true,
  bytesPerCode: 1,
  widthOf: (code) => (code === 0x20 ? 250 : 500),
  ascentEm: 0.8,
  descentEm: -0.2,
  appliesWordSpacing: true,
};

function walk(bytes: Uint8Array) {
  const ops = tokenizeContentStream(bytes);
  const result = walkTextPlacements(ops, { resolveFont: () => latinFont });
  if (!result.ok) throw new Error(result.reason);
  return { ops, glyphs: result.glyphs };
}

function run(source: string, rects: PdfRect[]) {
  const bytes = enc.encode(source);
  const { ops, glyphs } = walk(bytes);
  return { bytes, glyphs, result: removeCoveredGlyphs(bytes, ops, glyphs, rects) };
}

// The gold assertion: glyphs surviving the rewrite sit at EXACTLY the same
// user-space positions as their originals — removal must not move anything.
function expectSurvivorsUnmoved(
  original: GlyphPlacement[],
  rewrittenBytes: Uint8Array,
  survivorCodes: number[],
) {
  const rewalked = walk(rewrittenBytes).glyphs;
  expect(rewalked.map((g) => g.code)).toEqual(survivorCodes);
  const originalByCode = new Map(original.map((g) => [g.code, g]));
  for (const survivor of rewalked) {
    const source = originalByCode.get(survivor.code)!;
    for (let corner = 0; corner < 4; corner += 1) {
      expect(survivor.quad[corner]!.x).toBeCloseTo(source.quad[corner]!.x, 4);
      expect(survivor.quad[corner]!.y).toBeCloseTo(source.quad[corner]!.y, 4);
    }
  }
}

// Fully covers glyph B of (ABC) at 12pt from x=100: B spans x 106…112,
// y 697.6…709.6.
const B_RECT: PdfRect = { x: 105, y: 697, w: 8, h: 13 };

describe("glyph removal rewrite", () => {
  test("removes a fully covered glyph and keeps neighbors in place", () => {
    const source = "BT /F1 12 Tf 100 700 Td (ABC) Tj ET";
    const { glyphs, result } = run(source, [B_RECT]);
    if (!result.changed) throw new Error("expected a rewrite");
    expect(result.removedCount).toBe(1);
    expect(result.cleanRects).toEqual([false]);
    const text = dec.decode(result.bytes);
    expect(text).toBe("BT /F1 12 Tf 100 700 Td [<41> -500 <43>] TJ ET");
    expectSurvivorsUnmoved(glyphs, result.bytes, [0x41, 0x43]);
  });

  test("reports a rect clean when all intersecting glyphs are removed", () => {
    const source = "BT /F1 12 Tf 106 700 Td (B) Tj ET";
    const { result } = run(source, [B_RECT]);
    if (!result.changed) throw new Error("expected a rewrite");
    expect(result.removedCount).toBe(1);
    expect(result.cleanRects).toEqual([true]);
  });

  test("keeps partially covered glyphs (conservative hit policy)", () => {
    // Rect stops mid-B: covers only its left half.
    const halfB: PdfRect = { x: 105, y: 697, w: 4, h: 13 };
    const { result } = run("BT /F1 12 Tf 100 700 Td (ABC) Tj ET", [halfB]);
    expect(result.changed).toBe(false);
    expect(result.cleanRects).toEqual([false]);
  });

  test("merges removal compensation with original TJ kerning numbers", () => {
    // Cover B (second glyph): spans x 6…12 around baseline 0.
    const rect: PdfRect = { x: 5.9, y: -3, w: 6.2, h: 13 };
    const source = "BT /F1 12 Tf [(AB) -50 (CD)] TJ ET";
    const { glyphs, result } = run(source, [rect]);
    if (!result.changed) throw new Error("expected a rewrite");
    const text = dec.decode(result.bytes);
    expect(text).toBe("BT /F1 12 Tf [<41> -550 <4344>] TJ ET");
    expectSurvivorsUnmoved(glyphs, result.bytes, [0x41, 0x43, 0x44]);
  });

  test("a removed word-spaced space still displaces what follows", () => {
    // ( A): space 2.5pt + Tw 2 = 4.5pt before A.
    const rect: PdfRect = { x: -1, y: -3, w: 4, h: 13 };
    const source = "BT /F1 12 Tf 2 Tw ( A) Tj ET";
    const { glyphs, result } = run(source, [rect]);
    if (!result.changed) throw new Error("expected a rewrite");
    expectSurvivorsUnmoved(glyphs, result.bytes, [0x41]);
  });

  test("rewrites ' into T* + TJ preserving later lines", () => {
    const source = "BT /F1 12 Tf 14 TL 0 700 Td (AB) ' (CD) ' ET";
    // First-line A: baseline 686 (700 − TL), x 0…6.
    const rect: PdfRect = { x: -1, y: 683, w: 8, h: 14 };
    const { glyphs, result } = run(source, [rect]);
    if (!result.changed) throw new Error("expected a rewrite");
    const text = dec.decode(result.bytes);
    expect(text).toContain("T* [-500 <42>] TJ");
    expect(text).toContain("(CD) '");
    expectSurvivorsUnmoved(glyphs, result.bytes, [0x42, 0x43, 0x44]);
  });

  test('rewrites " re-emitting its word/char spacing side effects', () => {
    const source = 'BT /F1 12 Tf 14 TL 0 700 Td 3 1 (AB) " (C) Tj ET';
    // A on the quote line: baseline 686, advance includes Tc 1 → x 0…6.
    const rect: PdfRect = { x: -1, y: 683, w: 7, h: 14 };
    const { glyphs, result } = run(source, [rect]);
    if (!result.changed) throw new Error("expected a rewrite");
    const text = dec.decode(result.bytes);
    expect(text).toContain("3 Tw 1 Tc T* [-583.3333 <42>] TJ");
    expectSurvivorsUnmoved(glyphs, result.bytes, [0x42, 0x43]);
  });

  test("leaves bytes outside rewritten ops untouched", () => {
    const source =
      "q 1 0 0 1 0 0 cm % keep me\nBT /F1 12 Tf 100 700 Td (ABC) Tj ET Q";
    const { result } = run(source, [B_RECT]);
    if (!result.changed) throw new Error("expected a rewrite");
    const text = dec.decode(result.bytes);
    expect(text.startsWith("q 1 0 0 1 0 0 cm % keep me\nBT /F1 12 Tf 100 700 Td ")).toBe(true);
    expect(text.endsWith(" ET Q")).toBe(true);
  });

  test("drops the alternate text of marked content around removed glyphs", () => {
    // /ActualText, /Alt and /E would hand the removed word to any extractor
    // that honours them; a span with no removed glyph keeps its own.
    const source =
      "/Figure <</Alt (pic)>> BDC /Span <</ActualText (Bee) /MCID 0>> BDC " +
      "BT /F1 12 Tf 106 700 Td (B) Tj ET EMC EMC " +
      "/Span <</ActualText (Sea)>> BDC BT /F1 12 Tf 300 700 Td (C) Tj ET EMC";
    const { result } = run(source, [B_RECT]);
    if (!result.changed) throw new Error("expected a rewrite");
    expect(dec.decode(result.bytes)).toBe(
      "/Figure << >> BDC /Span <<  /MCID 0>> BDC " +
        "BT /F1 12 Tf 106 700 Td [-500] TJ ET EMC EMC " +
        "/Span <</ActualText (Sea)>> BDC BT /F1 12 Tf 300 700 Td (C) Tj ET EMC",
    );
  });

  test("no covered glyphs → no rewrite", () => {
    const far: PdfRect = { x: 400, y: 400, w: 50, h: 50 };
    const { result } = run("BT /F1 12 Tf 100 700 Td (ABC) Tj ET", [far]);
    expect(result).toEqual({
      changed: false,
      removedCount: 0,
      cleanRects: [true],
      rectFonts: [{ kind: "none" }],
    });
  });
});
