import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  mixHexColors,
  THEME_COLOR_SWATCHES,
} from "./color";
import {
  applyTheme,
  DARK_PALETTE,
  EVERFOREST_DARK_PALETTE,
  EVERFOREST_LIGHT_PALETTE,
  LIGHT_PALETTE,
  paletteForTheme,
  resolveEffectiveTheme,
} from "./theme";

describe("paletteForTheme", () => {
  test("uses Everforest only when selected", () => {
    expect(paletteForTheme("Everforest", "dark")).toBe(EVERFOREST_DARK_PALETTE);
    expect(paletteForTheme("Default", "light")).toBe(LIGHT_PALETTE);
  });

  test("keeps a custom accent exactly equal to the supplied HEX color", () => {
    expect(paletteForTheme("Default", "light", "#FFFFFF").accent).toBe(
      "#ffffff",
    );
    expect(paletteForTheme("Everforest", "dark", "#123456").accent).toBe(
      "#123456",
    );
  });

  test("prefers a white logo until the accent becomes too light", () => {
    const logoForeground = (accent: string | null) =>
      paletteForTheme("Default", "light", accent).logoOnAccent;

    expect(logoForeground(null)).toBe("#ffffff");
    expect(logoForeground("#3388bb")).toBe("#ffffff");
    expect(logoForeground("#eaeff6")).toBe("#13161d");
  });

  test("resolves Auto from the supplied system color scheme", () => {
    expect(resolveEffectiveTheme("Auto", false)).toBe("light");
    expect(resolveEffectiveTheme("Auto", true)).toBe("dark");
    expect(resolveEffectiveTheme("Light", true)).toBe("light");
    expect(resolveEffectiveTheme("Dark", false)).toBe("dark");
  });

  test("derives accessible semantic accents for every swatch and theme", () => {
    const themes = [
      ["Default", "light", LIGHT_PALETTE],
      ["Default", "dark", DARK_PALETTE],
      ["Everforest", "light", EVERFOREST_LIGHT_PALETTE],
      ["Everforest", "dark", EVERFOREST_DARK_PALETTE],
    ] as const;

    for (const [theme, effective, base] of themes) {
      for (const seed of ["#000000", "#ffffff", ...THEME_COLOR_SWATCHES]) {
        const palette = paletteForTheme(theme, effective, seed);
        const ghostAlpha = effective === "dark" ? 0.09 : 0.06;
        for (const surface of [palette.paper, palette.cream, palette.surface]) {
          expect(
            contrastRatio(palette.accentText, surface),
          ).toBeGreaterThanOrEqual(4.5);
          const selectedSurface = mixHexColors(
            surface,
            palette.accent,
            ghostAlpha,
          );
          expect(
            contrastRatio(palette.accentText, selectedSurface),
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          contrastRatio(palette.onAccent, palette.accent),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(palette.logoOnAccent, palette.accent),
        ).toBeGreaterThanOrEqual(3);
        expect(palette.accentSoft).toEndWith(
          effective === "dark" ? ",0.18)" : ",0.12)",
        );
        expect(palette.accentGhost).toEndWith(
          effective === "dark" ? ",0.09)" : ",0.06)",
        );
        expect(palette.accent).toBe(seed.toLowerCase());
      }
      expect(paletteForTheme(theme, effective)).toBe(base);
    }
  });

  test("keeps secondary text readable on every chrome surface", () => {
    // ink2 is the enabled-tool label, dim the status bar / hints / metadata.
    // Both are normal-size text and must clear WCAG 4.5:1 on each surface
    // the chrome actually paints them over, in all four presets.
    for (const palette of [
      LIGHT_PALETTE,
      DARK_PALETTE,
      EVERFOREST_LIGHT_PALETTE,
      EVERFOREST_DARK_PALETTE,
    ]) {
      for (const surface of [
        palette.paper,
        palette.cream,
        palette.surface,
        palette.tint,
      ]) {
        expect(contrastRatio(palette.ink2, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.dim, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("applies the custom semantic tokens before React renders", () => {
    applyTheme("light", "Default", "#CC6633");
    const expected = paletteForTheme("Default", "light", "#cc6633");
    expect(
      document.documentElement.style.getPropertyValue("--opx-accent"),
    ).toBe(expected.accent);
    expect(
      document.documentElement.style.getPropertyValue("--opx-accentText"),
    ).toBe(expected.accentText);
    expect(
      document.documentElement.style.getPropertyValue("--opx-onAccent"),
    ).toBe(expected.onAccent);
    expect(
      document.documentElement.style.getPropertyValue("--opx-logoOnAccent"),
    ).toBe(expected.logoOnAccent);

    applyTheme("light", "Default", null);
    expect(
      document.documentElement.style.getPropertyValue("--opx-accent"),
    ).toBe(LIGHT_PALETTE.accent);
  });
});
