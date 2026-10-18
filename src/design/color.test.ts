import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  hexToRgba,
  mixHexColors,
  normalizeHexColor,
  resolveReadableColor,
  resolveReadableColorForBackgrounds,
  THEME_COLOR_SWATCHES,
} from "./color";
import {
  DARK_PALETTE,
  EVERFOREST_DARK_PALETTE,
  EVERFOREST_LIGHT_PALETTE,
  LIGHT_PALETTE,
} from "./theme";

describe("theme color utilities", () => {
  test("normalizes opaque short and long hex colors only", () => {
    expect(normalizeHexColor(" #38B ")).toBe("#3388bb");
    expect(normalizeHexColor("#33AA77")).toBe("#33aa77");
    for (const value of ["3388bb", "#abcd", "#11223344", "red", ""]) {
      expect(normalizeHexColor(value)).toBeNull();
    }
  });

  test("computes WCAG contrast and deterministic RGB mixing", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(mixHexColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(hexToRgba("#3388bb", 0.12)).toBe("rgba(51,136,187,0.12)");
    expect(hexToRgba("#3388bb", 2)).toBe("rgba(51,136,187,1)");
  });

  test("finds one readable color across multiple surfaces", () => {
    const resolved = resolveReadableColorForBackgrounds(
      "#f4d674",
      ["#f6f8fb", "#eef3f8", "#ffffff"],
      "#13161d",
    );
    for (const background of ["#f6f8fb", "#eef3f8", "#ffffff"]) {
      expect(contrastRatio(resolved.color, background)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    expect(() =>
      resolveReadableColorForBackgrounds("#000", [], "#fff"),
    ).toThrow("theme-color-backgrounds-empty");
  });

  test("preserves readable seeds and adjusts unsafe seeds toward theme ink", () => {
    const readable = resolveReadableColor(
      "#2d5a3d",
      "#f6f8fb",
      "#13161d",
    );
    expect(readable.color).toBe("#2d5a3d");
    expect(readable.adjusted).toBe(false);

    const unsafeLight = resolveReadableColor(
      "#f4d674",
      "#f6f8fb",
      "#13161d",
    );
    expect(unsafeLight.adjusted).toBe(true);
    expect(unsafeLight.contrast).toBeGreaterThanOrEqual(4.5);

    const unsafeDark = resolveReadableColor(
      "#13161d",
      "#111418",
      "#eaeff6",
    );
    expect(unsafeDark.adjusted).toBe(true);
    expect(unsafeDark.contrast).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps every heading swatch readable across all built-in themes", () => {
    const palettes = [
      LIGHT_PALETTE,
      DARK_PALETTE,
      EVERFOREST_LIGHT_PALETTE,
      EVERFOREST_DARK_PALETTE,
    ];
    for (const palette of palettes) {
      for (const seed of THEME_COLOR_SWATCHES) {
        const resolved = resolveReadableColor(
          seed,
          palette.paper,
          palette.ink,
        );
        expect(contrastRatio(resolved.color, palette.paper)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });
});
