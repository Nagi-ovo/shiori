import { PDF_CORE_AVAILABLE } from "../../platform/pdfCore";
import { pdfiumDesktopEngine } from "./pdfiumEngine";
import { pdfiumWebEngine } from "./pdfiumWebEngine";
import type { PdfEngine } from "./types";

// Set by vite.config.ts: true for the web and mobile builds, false for the
// desktop build, which has the native core and so leaves the wasm one (and
// its 5 MB of wasm) out. Undefined under tests.
declare const __SHIORI_WASM_CORE__: boolean | undefined;

const WASM_CORE =
  typeof __SHIORI_WASM_CORE__ === "boolean" &&
  __SHIORI_WASM_CORE__ &&
  typeof Worker === "function" &&
  typeof WebAssembly === "object";

/** Where neither core can run: every document fails to open, and says why. */
const unavailableEngine: PdfEngine = new Proxy({ label: "none" } as PdfEngine, {
  get(target, key) {
    if (key === "label") return target.label;
    if (key === "load") {
      return () => Promise.reject(new Error("PDF engine unavailable: no WebAssembly or worker support"));
    }
    return () => {
      throw new Error("PDF engine unavailable");
    };
  },
});

let current: PdfEngine = PDF_CORE_AVAILABLE
  ? pdfiumDesktopEngine
  : WASM_CORE
    ? pdfiumWebEngine
    : unavailableEngine;

/**
 * The engine the app reads and draws PDFs with: shiori-core (PDFium)
 * natively on desktop, as wasm in a worker on web and mobile.
 */
export const appPdfEngine: PdfEngine = new Proxy({} as PdfEngine, {
  get: (_target, key) => current[key as keyof PdfEngine],
});

/**
 * Tests only: answer with `engine` until the returned restore runs. Tests run
 * where no core does, and this keeps a fake from leaking between test files
 * the way a module mock would.
 */
export function setAppPdfEngineForTest(engine: PdfEngine): () => void {
  const previous = current;
  current = engine;
  return () => {
    current = previous;
  };
}
