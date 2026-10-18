import { describe, expect, test } from "bun:test";
import tauriConf from "../../src-tauri/tauri.conf.json";
import linuxConf from "../../src-tauri/tauri.linux.conf.json";
import windowsConf from "../../src-tauri/tauri.windows.conf.json";

// Windows draws its own caption buttons (WindowCaption.tsx), so its window
// entry turns decorations off. Tauri merges platform files with JSON Merge
// Patch, which replaces arrays whole: tauri.windows.conf.json must restate
// the entire main window, and a size or title changed only in
// tauri.conf.json would silently skip Windows. The macOS-only keys
// (titleBarStyle, hiddenTitle) come along in the copy; Windows ignores them.
describe("the Windows window entry tracks tauri.conf.json", () => {
  const base = tauriConf.app.windows;
  const windows = (windowsConf as { app?: { windows?: unknown[] } }).app?.windows;

  test("it restates every window, changing only decorations", () => {
    expect(windows).toEqual(base.map((window) => ({ ...window, decorations: false })));
  });

  test("Linux keeps the native title bar", () => {
    expect((linuxConf as { app?: unknown }).app).toBeUndefined();
    expect(base.every((window) => !("decorations" in window))).toBe(true);
  });
});
