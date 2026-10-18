import { describe, expect, test } from "bun:test";
import {
  EVERFOREST_PDF_PAPER,
  MIN_PDF_PAPER_LUMINANCE,
  compositePdfPaperColor,
  pdfPaperColor,
  resolvePdfPaperCustomColor,
} from "./pdfPaperTone";
import { relativeLuminance } from "./color";

describe("PDF paper tone", () => {
  test("uses the existing Everforest light paper token", () => {
    expect(pdfPaperColor("Original")).toBeNull();
    expect(pdfPaperColor("Everforest")).toBe("#efebd4");
    expect(pdfPaperColor("Custom", "#fdf6e3")).toBe("#fdf6e3");
  });

  test("preserves light custom colors and gently lifts dark colors", () => {
    expect(resolvePdfPaperCustomColor("#FDF6E3")).toEqual({
      color: "#fdf6e3",
      adjusted: false,
    });

    const dark = resolvePdfPaperCustomColor("#173f35");
    expect(dark.adjusted).toBe(true);
    expect(dark.color).not.toBe("#173f35");
    expect(relativeLuminance(dark.color)).toBeGreaterThanOrEqual(
      MIN_PDF_PAPER_LUMINANCE,
    );
  });

  test("wraps the multiplied page bitmap in saved canvas state", () => {
    const calls: string[] = [];
    const ctx = {
      globalCompositeOperation: "source-over",
      fillStyle: "#000000",
      save: () => calls.push("save"),
      fillRect: (x: number, y: number, width: number, height: number) =>
        calls.push(`fill:${x},${y},${width},${height}`),
      restore: () => calls.push("restore"),
    } as unknown as CanvasRenderingContext2D;

    compositePdfPaperColor(ctx, 320, 480, EVERFOREST_PDF_PAPER);

    expect(calls).toEqual(["save", "fill:0,0,320,480", "restore"]);
    expect(ctx.globalCompositeOperation).toBe("multiply");
    expect(ctx.fillStyle).toBe("#efebd4");
  });
});
