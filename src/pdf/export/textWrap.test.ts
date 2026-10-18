import { describe, expect, test } from "bun:test";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { measureTextWidth, wrapText } from "./textWrap";
import type { PathTextFont } from "./vectorText";

describe("PDF text wrapping", () => {
  test("never splits an oversized Unicode grapheme cluster", () => {
    const font = {
      widthOfTextAtSize: (text: string) => Array.from(text).length * 10,
    } as unknown as PDFFont;

    expect(wrapText("A\u0301B", font, 12, 15)).toEqual(["A\u0301", "B"]);
  });
});

describe("measurement follows the font that will actually be drawn", () => {
  // Real fonts, because the whole bug is that two real faces disagree about
  // ASCII advances by a few percent — a mock would just encode whatever
  // answer the test author expected.
  const notoUrl = new URL(
    "../../assets/fonts/NotoSansSC-Regular.otf",
    import.meta.url,
  ).href;

  async function fonts() {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const notoBytes = await fetch(notoUrl).then((r) => r.arrayBuffer());
    const noto = fontkit.create(new Uint8Array(notoBytes)) as PathTextFont;
    return { helv, noto };
  }

  const LINE = "Draft - do not circulate";
  const SIZE = 14;

  test("the two faces really do disagree about ASCII width", async () => {
    const { helv, noto } = await fonts();
    const helvWidth = measureTextWidth(helv, LINE, SIZE);
    const notoWidth = measureTextWidth(helv, LINE, SIZE, noto, true);
    // Guards the premise of this whole test: if the faces ever converge, the
    // assertions below stop proving anything.
    expect(Math.abs(notoWidth - helvWidth)).toBeGreaterThan(1);
  });

  test("ASCII measures on the standard font unless the drawer overrides", async () => {
    const { helv, noto } = await fonts();
    const plain = measureTextWidth(helv, LINE, SIZE);
    // Without the flag, a path font present but ASCII text keeps standard
    // advances — that is the behaviour the editable annotation path relies on.
    expect(measureTextWidth(helv, LINE, SIZE, noto)).toBeCloseTo(plain, 6);
  });

  test("ASCII measures on the path font when flatten will draw it as outlines", async () => {
    const { helv, noto } = await fonts();
    const drawn = measureTextWidth(helv, LINE, SIZE, noto, true);
    const measuredAsHelvetica = measureTextWidth(helv, LINE, SIZE, noto, false);
    expect(drawn).not.toBeCloseTo(measuredAsHelvetica, 3);

    // Centring uses (boxWidth - textWidth) / 2, so measuring on the wrong face
    // offsets the line by half the difference.
    const centringError = Math.abs(drawn - measuredAsHelvetica) / 2;
    expect(centringError).toBeGreaterThan(0.5);
  });

  test("wrapping breaks against the same width it will be drawn at", async () => {
    const { helv, noto } = await fonts();
    const text = "alpha bravo charlie delta";
    const boxWidth = measureTextWidth(helv, "alpha bravo charlie", SIZE, noto, true);

    // Every produced line must fit the box when measured the way it is drawn.
    for (const line of wrapText(text, helv, SIZE, boxWidth, noto, true)) {
      expect(measureTextWidth(helv, line, SIZE, noto, true)).toBeLessThanOrEqual(
        boxWidth + 1e-6,
      );
    }
  });
});
