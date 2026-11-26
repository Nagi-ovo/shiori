import { describe, expect, test } from "bun:test";
import { evaluateAcceptance } from "../../pdf/export/acceptance";
import type { ExportResult } from "../../pdf/export/exportPdf";
import {
  cachePreviewResult,
  type PreviewResultCache,
} from "./exportPreviewCache";

function result(bytesOrSize: Uint8Array | number): ExportResult {
  const bytes = typeof bytesOrSize === "number" ? new Uint8Array(bytesOrSize) : bytesOrSize;
  return { bytes, lostChars: 0, acceptance: evaluateAcceptance({ lostChars: 0 }, "review") };
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
      cachePreviewResult(cache, "original", result(view), 50),
    ).toBe(false);
  });
});
