import { describe, expect, test } from "bun:test";
import {
  MAX_PAGE_DIMENSION_PT,
  PdfOpenError,
  assertCanvasPixelBudget,
  assertPdfPageDimensionsWithinLimit,
  clampScaleToCanvasBudget,
  classifyPdfOpenError,
  isCanvasWithinPixelBudget,
  maxScaleForCanvasBudget,
} from "./openPolicy";

describe("PDF open/render policy", () => {
  test("rejects pathological page dimensions", () => {
    expect(() => {
      assertPdfPageDimensionsWithinLimit(
        MAX_PAGE_DIMENSION_PT + 1,
        100,
        1,
      );
    }).toThrow(PdfOpenError);
  });

  test("rejects canvas dimensions over the pixel budget", () => {
    expect(isCanvasWithinPixelBudget(100, 100, 10_000)).toBe(true);
    expect(isCanvasWithinPixelBudget(101, 100, 10_000)).toBe(false);
    expect(() => assertCanvasPixelBudget(101, 100, 10_000)).toThrow(
      PdfOpenError,
    );
  });

  test("computes safe render scale for the canvas pixel budget", () => {
    expect(maxScaleForCanvasBudget(100, 100, 1, 10_000)).toBeCloseTo(1);
    expect(maxScaleForCanvasBudget(100, 100, 2, 10_000)).toBeCloseTo(0.5);
    expect(clampScaleToCanvasBudget(2, 100, 100, 1, 10_000)).toBeCloseTo(1);
    expect(clampScaleToCanvasBudget(0.5, 100, 100, 1, 10_000)).toBeCloseTo(0.5);
  });

  test("classifies password-protected PDF errors", () => {
    const pwErr = Object.assign(new Error("need a password"), {
      name: "PasswordException",
    });
    expect(classifyPdfOpenError(pwErr)).toBe("password");

    const encMsg = new Error("This PDF is encrypted");
    expect(classifyPdfOpenError(encMsg)).toBe("password");

    const wrongPw = Object.assign(
      new Error("Incorrect Password"),
      { name: "PasswordException" },
    );
    expect(classifyPdfOpenError(wrongPw)).toBe("password");
  });

  test("classifies damaged and unknown PDF errors", () => {
    const damaged = Object.assign(new Error("bad xref table"), {
      name: "InvalidPDFException",
    });
    expect(classifyPdfOpenError(damaged)).toBe("damaged");
    expect(classifyPdfOpenError(new Error("something else"))).toBe("unknown");
    expect(classifyPdfOpenError(new PdfOpenError("tooLarge", "big"))).toBe("tooLarge");
  });

  test("classifies a PdfOpenError from another copy of this module by its kind", () => {
    // The CLI bundle holds two copies of this module, so the class thrown
    // by one copy is not the class the other checks against; the name and
    // a known kind still identify it. Neither alone does.
    class OtherCopy extends Error {
      kind: string;
      constructor(kind: string, message: string) {
        super(message);
        this.name = "PdfOpenError";
        this.kind = kind;
      }
    }
    expect(classifyPdfOpenError(new OtherCopy("engineUnavailable", "addon did not load"))).toBe(
      "engineUnavailable",
    );
    expect(classifyPdfOpenError(new OtherCopy("pageTooLarge", "PDF page 1 has dimensions"))).toBe(
      "pageTooLarge",
    );
    expect(classifyPdfOpenError(new OtherCopy("notAKind", "something else"))).toBe("unknown");
    expect(
      classifyPdfOpenError(Object.assign(new Error("something else"), { kind: "tooLarge" })),
    ).toBe("unknown");
  });
});
