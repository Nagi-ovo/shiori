import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MARKDOWN_APPEARANCE,
  isMarkdownFontChoice,
  markdownFontFamilyCss,
  normalizeMarkdownAppearance,
  normalizeMarkdownAppearanceOverride,
  normalizeRecentMarkdownFonts,
  pushRecentMarkdownFont,
  resolveMarkdownAppearance,
  type MarkdownFontChoice,
} from "./markdownAppearance";

describe("markdown appearance model", () => {
  test("accepts eligible built-in and bounded system font families", () => {
    expect(
      isMarkdownFontChoice({ source: "builtin", family: "Inter Tight" }),
    ).toBe(true);
    expect(
      isMarkdownFontChoice({ source: "builtin", family: "Klee One" }),
    ).toBe(false);
    expect(
      isMarkdownFontChoice({ source: "system", family: "霞鹜文楷" }),
    ).toBe(true);
    expect(
      isMarkdownFontChoice({ source: "system", family: "Bad\nFont" }),
    ).toBe(false);
    expect(
      isMarkdownFontChoice({ source: "system", family: "Safe\u202Espoofed" }),
    ).toBe(false);
    expect(
      isMarkdownFontChoice({ source: "system", family: " padded " }),
    ).toBe(false);
  });

  test("quotes CSS family names and always appends a safe fallback", () => {
    expect(
      markdownFontFamilyCss(
        { source: "system", family: 'Writer "Display" \\ Pro' },
        "body",
      ),
    ).toBe('"Writer \\"Display\\" \\\\ Pro", var(--opx-font-sans)');
    expect(markdownFontFamilyCss(null, "code")).toBe(
      "var(--opx-font-mono)",
    );
    expect(
      markdownFontFamilyCss(
        { source: "builtin", family: "Instrument Serif" },
        "body",
      ),
    ).toBe('"Instrument Serif", var(--opx-font-serif)');
  });

  test("normalizes corrupted global and partial document values", () => {
    expect(
      normalizeMarkdownAppearance({
        bodyFont: { source: "system", family: "Avenir Next" },
        codeFont: { source: "builtin", family: "Shiori Nerd Symbols" },
        headingColor: "#3A7",
        fontSize: 99,
        lineHeight: 1.8,
        contentWidth: "wide",
      }),
    ).toEqual({
      ...DEFAULT_MARKDOWN_APPEARANCE,
      bodyFont: { source: "system", family: "Avenir Next" },
      headingColor: "#33aa77",
      lineHeight: 1.8,
    });

    expect(
      normalizeMarkdownAppearanceOverride({
        bodyFont: null,
        codeFont: { source: "system", family: "Cascadia Code" },
        headingColor: null,
        fontSize: 18,
        lineHeight: -1,
        contentWidth: 720,
        injected: true,
      }),
    ).toEqual({
      bodyFont: null,
      codeFont: { source: "system", family: "Cascadia Code" },
      headingColor: null,
      fontSize: 18,
      contentWidth: 720,
    });

    expect(
      normalizeMarkdownAppearanceOverride({
        headingColor: "#11223344",
      }),
    ).toEqual({});
  });

  test("merges document overrides without mutating the global preference", () => {
    const global = {
      ...DEFAULT_MARKDOWN_APPEARANCE,
      bodyFont: { source: "builtin", family: "Instrument Serif" } as const,
    };
    const resolved = resolveMarkdownAppearance(global, {
      fontSize: 19,
      bodyFont: null,
      headingColor: null,
    });
    expect(resolved).toEqual({
      ...global,
      fontSize: 19,
      bodyFont: null,
      headingColor: null,
    });
    expect(global.fontSize).toBe(16);
  });

  test("deduplicates and caps recent fonts with the newest first", () => {
    const fonts: MarkdownFontChoice[] = Array.from({ length: 8 }, (_, index) => ({
      source: "system",
      family: `Font ${index}`,
    }));
    const normalized = normalizeRecentMarkdownFonts([
      fonts[0],
      { source: "system", family: "font 0" },
      ...fonts.slice(1),
      { source: "system", family: "Bad\nFont" },
    ]);
    expect(normalized).toHaveLength(6);
    expect(normalized[0]?.family).toBe("Font 0");

    const pushed = pushRecentMarkdownFont(normalized, {
      source: "system",
      family: "Font 3",
    });
    expect(pushed.map((font) => font.family)).toEqual([
      "Font 3",
      "Font 0",
      "Font 1",
      "Font 2",
      "Font 4",
      "Font 5",
    ]);
  });
});
