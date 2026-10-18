import { describe, expect, test } from "bun:test";
import { convertKeyGlyphs } from "./keys";
import en from "../i18n/locales/en.json";
import zh from "../i18n/locales/zh.json";
import ja from "../i18n/locales/ja.json";

describe("convertKeyGlyphs", () => {
  test("adjacent glyph chords gain + separators in Ctrl-first order", () => {
    expect(convertKeyGlyphs("⌘Z")).toBe("Ctrl+Z");
    expect(convertKeyGlyphs("⇧⌘Z")).toBe("Ctrl+Shift+Z");
    expect(convertKeyGlyphs("Undo (⌘Z)")).toBe("Undo (Ctrl+Z)");
    expect(convertKeyGlyphs("Print · ⌘P")).toBe("Print · Ctrl+P");
  });

  test("existing separators are preserved, not doubled", () => {
    expect(convertKeyGlyphs("⌘+drag")).toBe("Ctrl+drag");
    expect(convertKeyGlyphs("⌘ ?")).toBe("Ctrl ?");
    expect(convertKeyGlyphs("⇧ = free angle")).toBe("Shift = free angle");
  });

  test("prose without glyphs passes through untouched", () => {
    // The i18next post-processor runs this over every translation, so words
    // that merely contain modifier names must never be rewritten.
    for (const s of [
      "Alternatively, shift the selection",
      "Shift-click to multi-select",
      "Control the zoom level",
    ]) {
      expect(convertKeyGlyphs(s)).toBe(s);
    }
  });

  test("is idempotent (safe under double application via k(t(...)))", () => {
    for (const s of ["⇧⌘Z", "⌘+drag", "⌘ ?", "Print · ⌘P"]) {
      const once = convertKeyGlyphs(s);
      expect(convertKeyGlyphs(once)).toBe(once);
    }
  });

  test("every locale string converts to a glyph-free label", () => {
    const glyphs = /[⌘⇧⌥⌃]/;
    const walk = (node: unknown, path: string): void => {
      if (typeof node === "string") {
        if (!glyphs.test(node)) return;
        const converted = convertKeyGlyphs(node);
        expect(`${path}: ${converted}`).not.toMatch(glyphs);
        // A fused "CtrlShift" means a chord slipped past the separator rule.
        expect(converted).not.toMatch(/(Ctrl|Shift|Alt)(Ctrl|Shift|Alt)/);
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          walk(value, path ? `${path}.${key}` : key);
        }
      }
    };
    walk(en, "en");
    walk(zh, "zh");
    walk(ja, "ja");
  });
});
