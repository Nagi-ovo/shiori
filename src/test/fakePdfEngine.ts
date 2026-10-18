import "./buildGlobals";
import { afterEach, beforeEach } from "bun:test";
import { setAppPdfEngineForTest } from "../pdf/engine/appEngine";
import type { PdfDocument, PdfEngine } from "../pdf/engine/types";

/**
 * An engine for component tests: every member a test does not provide
 * throws, so a test states exactly what the engine answers.
 */
export function fakePdfEngine(provided: Partial<PdfEngine>): PdfEngine {
  return new Proxy({ label: "fake", ...provided } as PdfEngine, {
    get(target, key) {
      if (key in target) return target[key as keyof PdfEngine];
      return () => {
        throw new Error(`fake engine: ${String(key)} not provided`);
      };
    },
  });
}

/** Answers with this engine for each test of the current file. */
export function withFakePdfEngine(provided: Partial<PdfEngine> | (() => Partial<PdfEngine>)): void {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    restore = setAppPdfEngineForTest(fakePdfEngine(typeof provided === "function" ? provided() : provided));
  });
  afterEach(() => {
    restore?.();
    restore = null;
  });
}

/** A document handle for the fake engine: opaque, compared by identity. */
export function fakePdfDocument(): PdfDocument {
  return Object.freeze({}) as unknown as PdfDocument;
}
