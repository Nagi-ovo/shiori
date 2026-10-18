import { describe, expect, test } from "bun:test";
import type { TextRunDisplayBounds } from "./highlightRects";
import {
  dominantSourceFontName,
  isPdfJsInternalFontName,
  normalizeBaseFontName,
} from "./sourceFontName";

function run(fontName?: string): TextRunDisplayBounds {
  return { text: "x", x: 0, y: 0, w: 10, h: 10, fontName };
}

describe("sourceFontName", () => {
  test("strips the subset tag, keeps plain names", () => {
    expect(normalizeBaseFontName("KAXVBH+EBGaramond-Regular")).toBe(
      "EBGaramond-Regular",
    );
    expect(normalizeBaseFontName("NimbusRomNo9L-Regu")).toBe(
      "NimbusRomNo9L-Regu",
    );
    // Only the exact 6-uppercase-letter tag form is a subset prefix.
    expect(normalizeBaseFontName("ABC+Font")).toBe("ABC+Font");
  });

  test("recognises pdf.js session-internal names", () => {
    expect(isPdfJsInternalFontName("g_d0_f3")).toBe(true);
    expect(isPdfJsInternalFontName("g_d12_f1")).toBe(true);
    expect(isPdfJsInternalFontName("EBGaramond-Regular")).toBe(false);
  });

  test("majority vote picks the dominant resolved name", () => {
    const runs = [
      run("KAXVBH+EBGaramond-Regular"),
      run("ZZAABB+EBGaramond-Regular"),
      run("KAXVBH+EBGaramond-Italic"),
    ];
    expect(dominantSourceFontName(runs)).toBe("EBGaramond-Regular");
  });

  test("internal and missing names never win", () => {
    expect(dominantSourceFontName([run("g_d0_f1"), run(undefined)])).toBe(
      undefined,
    );
  });
});
