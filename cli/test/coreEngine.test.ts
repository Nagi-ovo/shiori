import { describe, expect, test } from "bun:test";
import { pdfEngineFromEnv } from "../src/coreEngine";

describe("pdfEngineFromEnv", () => {
  test("the packaged CLI reads with the core it ships; a source run with pdf.js", () => {
    expect(pdfEngineFromEnv({}, true)).toBe("pdfium");
    expect(pdfEngineFromEnv({}, false)).toBe("pdfjs");
  });

  test("SHIORI_PDF_ENGINE chooses either way", () => {
    expect(pdfEngineFromEnv({ SHIORI_PDF_ENGINE: "pdfjs" }, true)).toBe("pdfjs");
    expect(pdfEngineFromEnv({ SHIORI_PDF_ENGINE: " PDFium " }, false)).toBe("pdfium");
    expect(pdfEngineFromEnv({ SHIORI_PDF_ENGINE: "other" }, true)).toBe("pdfium");
  });
});
