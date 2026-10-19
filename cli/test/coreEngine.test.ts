import { describe, expect, test } from "bun:test";
import { pdfEngineFromEnv } from "../src/coreEngine";

describe("pdfEngineFromEnv", () => {
  test("reads with the core unless SHIORI_PDF_ENGINE=pdfjs opts out", () => {
    expect(pdfEngineFromEnv({})).toBe("pdfium");
    expect(pdfEngineFromEnv({ SHIORI_PDF_ENGINE: " PDFjs " })).toBe("pdfjs");
    expect(pdfEngineFromEnv({ SHIORI_PDF_ENGINE: "other" })).toBe("pdfium");
  });
});
