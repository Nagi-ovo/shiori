import { describe, expect, test } from "bun:test";
import { PDFContext, type PDFDict } from "pdf-lib";
import { contentFontInfo } from "./glyphWidths";

function makeFont(spec: Record<string, unknown>): PDFDict {
  const context = PDFContext.create();
  return context.obj(spec) as PDFDict;
}

describe("content font info", () => {
  test("simple font: /FirstChar + /Widths with descriptor metrics", () => {
    const font = makeFont({
      Type: "Font",
      Subtype: "Type1",
      FirstChar: 65,
      Widths: [500, 600],
      FontDescriptor: { Ascent: 700, Descent: -150, MissingWidth: 300 },
    });
    const info = contentFontInfo(font);
    if (!info.ok) throw new Error(info.reason);
    expect(info.bytesPerCode).toBe(1);
    expect(info.widthOf(65)).toBe(500);
    expect(info.widthOf(66)).toBe(600);
    expect(info.widthOf(64)).toBe(300); // outside range → MissingWidth
    expect(info.ascentEm).toBeCloseTo(0.7);
    expect(info.descentEm).toBeCloseTo(-0.15);
    expect(info.appliesWordSpacing).toBe(true);
  });

  test("simple font without /Widths is unsupported (standard-14)", () => {
    const font = makeFont({
      Type: "Font",
      Subtype: "Type1",
      BaseFont: "Helvetica",
    });
    const info = contentFontInfo(font);
    expect(info.ok).toBe(false);
    if (!info.ok) expect(info.reason).toContain("Widths");
  });

  test("missing descriptor falls back to 0.8/-0.2 em and MissingWidth 0", () => {
    const font = makeFont({
      Type: "Font",
      Subtype: "TrueType",
      FirstChar: 32,
      Widths: [250],
    });
    const info = contentFontInfo(font);
    if (!info.ok) throw new Error(info.reason);
    expect(info.ascentEm).toBeCloseTo(0.8);
    expect(info.descentEm).toBeCloseTo(-0.2);
    expect(info.widthOf(99)).toBe(0);
  });

  test("Type0 Identity-H: /W ranges in both forms plus /DW default", () => {
    const context = PDFContext.create();
    const descendant = context.register(
      context.obj({
        Type: "Font",
        Subtype: "CIDFontType2",
        DW: 750,
        W: [1, [10, 20], 5, 8, 300],
        FontDescriptor: { Ascent: 880, Descent: -120 },
      }),
    );
    const font = context.obj({
      Type: "Font",
      Subtype: "Type0",
      Encoding: "Identity-H",
      DescendantFonts: [descendant],
    }) as PDFDict;
    const info = contentFontInfo(font);
    if (!info.ok) throw new Error(info.reason);
    expect(info.bytesPerCode).toBe(2);
    expect(info.widthOf(1)).toBe(10); // c [w …] form
    expect(info.widthOf(2)).toBe(20);
    expect(info.widthOf(6)).toBe(300); // cFirst cLast w form
    expect(info.widthOf(9999)).toBe(750); // /DW
    expect(info.ascentEm).toBeCloseTo(0.88);
    expect(info.appliesWordSpacing).toBe(false);
  });

  test("Type0 with vertical or non-identity encodings is unsupported", () => {
    const vertical = contentFontInfo(
      makeFont({ Subtype: "Type0", Encoding: "Identity-V" }),
    );
    expect(vertical.ok).toBe(false);
    if (!vertical.ok) expect(vertical.reason).toContain("vertical");

    const cmap = contentFontInfo(
      makeFont({ Subtype: "Type0", Encoding: "UniJIS-UCS2-H" }),
    );
    expect(cmap.ok).toBe(false);
    if (!cmap.ok) expect(cmap.reason).toContain("CMap");
  });

  test("Type3 and unknown subtypes are unsupported", () => {
    const type3 = contentFontInfo(makeFont({ Subtype: "Type3" }));
    expect(type3.ok).toBe(false);
    const unknown = contentFontInfo(makeFont({ BaseFont: "X" }));
    expect(unknown.ok).toBe(false);
  });
});
