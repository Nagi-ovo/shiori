import { describe, expect, test } from "bun:test";
import type { ExportResult } from "../../pdf/export/exportPdf";
import {
  cachePreviewResult,
  type PreviewResultCache,
} from "./exportPreviewCache";

function result(size: number): ExportResult {
  return { bytes: new Uint8Array(size), lostChars: 0 };
}

describe("export preview cache", () => {
  test("applies one shared byte budget across every quality", () => {
    const cache: PreviewResultCache = {};

    expect(cachePreviewResult(cache, "original", result(60), 100)).toBe(true);
    expect(cachePreviewResult(cache, "standard", result(60), 100)).toBe(false);
    expect(cache.original?.bytes.byteLength).toBe(60);
    expect(cache.standard).toBeUndefined();
  });

  test("replacing one quality does not count its stale bytes twice", () => {
    const cache: PreviewResultCache = { original: result(60) };

    expect(cachePreviewResult(cache, "original", result(80), 100)).toBe(true);
    expect(cache.original?.bytes.byteLength).toBe(80);
  });

  test("counts a shared fallback backing store only once", () => {
    const shared = result(60);
    const cache: PreviewResultCache = {};

    expect(cachePreviewResult(cache, "standard", shared, 100)).toBe(true);
    expect(cachePreviewResult(cache, "compact", shared, 100)).toBe(true);
  });

  test("budgets the whole backing store rather than a small view", () => {
    const cache: PreviewResultCache = {};
    const view = new Uint8Array(new ArrayBuffer(100), 0, 10);

    expect(
      cachePreviewResult(cache, "original", { bytes: view, lostChars: 0 }, 50),
    ).toBe(false);
  });
});
