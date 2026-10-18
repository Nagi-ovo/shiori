import { describe, expect, test } from "bun:test";
import { isFindHotkey, isPrintHotkey, isShortcutsHotkey } from "./hotkeys";

describe("keyboard shortcut helpers", () => {
  test("matches the advertised shortcuts sheet hotkey", () => {
    // Canonical ⌘? (Mac) / Ctrl+? (Windows/Linux).
    expect(isShortcutsHotkey({ key: "?", metaKey: true, ctrlKey: false })).toBe(
      true,
    );
    expect(isShortcutsHotkey({ key: "?", metaKey: false, ctrlKey: true })).toBe(
      true,
    );
    // No modifier → no match.
    expect(isShortcutsHotkey({ key: "?", metaKey: false, ctrlKey: false })).toBe(
      false,
    );
    // ⌘/ without shift — accepted as a layout-independent fallback
    // so the macOS Help → Search menu doesn't swallow the shortcut.
    expect(isShortcutsHotkey({ key: "/", metaKey: true, ctrlKey: false })).toBe(
      true,
    );
    // Fullwidth ？ that Chinese IMs emit with fullwidth punctuation on.
    expect(isShortcutsHotkey({ key: "？", metaKey: true, ctrlKey: false })).toBe(
      true,
    );
    // WKWebView sometimes reports the physical key code instead of
    // translating "/" → "?" under shift; match `code: "Slash"`.
    expect(
      isShortcutsHotkey({
        key: "Unidentified",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        code: "Slash",
      }),
    ).toBe(true);
  });

  test("matches the advertised find hotkey", () => {
    expect(isFindHotkey({ key: "f", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isFindHotkey({ key: "F", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isFindHotkey({ key: "f", metaKey: false, ctrlKey: false })).toBe(
      false,
    );
    expect(isFindHotkey({ key: "g", metaKey: true, ctrlKey: false })).toBe(false);
  });

  test("matches the advertised print hotkey", () => {
    expect(isPrintHotkey({ key: "p", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPrintHotkey({ key: "P", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPrintHotkey({ key: "p", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isPrintHotkey({ key: "q", metaKey: true, ctrlKey: false })).toBe(false);
  });
});
