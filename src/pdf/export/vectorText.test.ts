import fontkit from "@pdf-lib/fontkit";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cjkJpExportFontUrl, cjkScExportFontUrl } from "./fontAssets";
import { drawPathText, glyphPathOperators, pathTextLostChars } from "./vectorText";

describe("vector text path operators", () => {
  test("drops non-finite glyph path commands before PDF serialization", () => {
    const operators = glyphPathOperators(
      {
        commands: [
          { command: "moveTo", args: [0, 0] },
          { command: "bezierCurveTo", args: [1, 1, NaN, 2, 3, 3] },
          { command: "lineTo", args: [4, 4] },
          { command: "quadraticCurveTo", args: [Infinity, 5, 6, 6] },
          { command: "closePath", args: [] },
        ],
      },
      10,
      20,
      0.5,
      0,
    );

    const serialized = operators.map(String).join("\n");
    expect(serialized).not.toContain("NaN");
    expect(serialized).not.toContain("Infinity");
    expect(serialized).toContain("10 20 m");
    expect(serialized).toContain("12 22 l");
  });

  test("falls back across CJK path fonts before drawing notdef boxes", () => {
    const sc = fontkit.create(readFileSync(new URL(cjkScExportFontUrl)));
    const jp = fontkit.create(readFileSync(new URL(cjkJpExportFontUrl)));

    const jpOnly = drawPathText(jp, "简", 0, 0, 12, [0, 0, 0], false);
    const withFallback = drawPathText(
      { primary: jp, fallbacks: [sc] },
      "简",
      0,
      0,
      12,
      [0, 0, 0],
      false,
    );

    expect(withFallback.length).toBeGreaterThan(jpOnly.length);
    expect(withFallback.map(String).join("\n")).not.toBe(
      jpOnly.map(String).join("\n"),
    );
  });

  test("counts glyphs missing from every path font", () => {
    const sc = fontkit.create(readFileSync(new URL(cjkScExportFontUrl)));
    const jp = fontkit.create(readFileSync(new URL(cjkJpExportFontUrl)));

    expect(pathTextLostChars({ primary: sc, fallbacks: [jp] }, "𡃁")).toBe(1);
    expect(pathTextLostChars({ primary: sc, fallbacks: [jp] }, "𠮷")).toBe(0);
  });
});
