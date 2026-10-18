import { describe, expect, test } from "bun:test";
import {
  displayRectToPdf,
  displayToPdf,
  pdfRectToDisplay,
  pdfToDisplay,
  rotatedSize,
} from "./coords";
import type { PdfPoint, PdfRect, Rotation } from "../model/types";

const rotations: Rotation[] = [0, 90, 180, 270];

describe("PDF/display coordinate transforms", () => {
  test("points round-trip across supported rotations", () => {
    const page = { width: 612, height: 792 };
    const point: PdfPoint = { x: 120.5, y: 640.25 };
    for (const rotation of rotations) {
      const display = pdfToDisplay(
        point,
        page.width,
        page.height,
        rotation,
        1.75,
      );
      const roundTrip = displayToPdf(
        display,
        page.width,
        page.height,
        rotation,
        1.75,
      );
      expect(roundTrip.x).toBeCloseTo(point.x, 6);
      expect(roundTrip.y).toBeCloseTo(point.y, 6);
    }
  });

  test("rectangles round-trip without losing bounds", () => {
    const page = { width: 612, height: 792 };
    const rect: PdfRect = { x: 42, y: 220, w: 180, h: 34 };
    for (const rotation of rotations) {
      const display = pdfRectToDisplay(
        rect,
        page.width,
        page.height,
        rotation,
        2,
      );
      const roundTrip = displayRectToPdf(
        display,
        page.width,
        page.height,
        rotation,
        2,
      );
      expect(roundTrip.x).toBeCloseTo(rect.x, 6);
      expect(roundTrip.y).toBeCloseTo(rect.y, 6);
      expect(roundTrip.w).toBeCloseTo(rect.w, 6);
      expect(roundTrip.h).toBeCloseTo(rect.h, 6);
    }
  });

  test("rotated page size swaps only quarter turns", () => {
    expect(rotatedSize(612, 792, 0)).toEqual({ width: 612, height: 792 });
    expect(rotatedSize(612, 792, 90)).toEqual({ width: 792, height: 612 });
    expect(rotatedSize(612, 792, 180)).toEqual({ width: 612, height: 792 });
    expect(rotatedSize(612, 792, 270)).toEqual({ width: 792, height: 612 });
  });

  // Round-trip assertions pass for ANY self-inverse mapping, so they cannot
  // catch a swapped 90/270 pair. These pin the absolute direction against
  // pdf.js's PageViewport, which is what actually paints the canvas: the
  // overlay layer and the canvas must agree or annotations land 180° off.
  //
  // Expected values are pdf.js's own transform for viewBox [0,0,W,H], scale 1:
  //   0   -> [ 1,  0,  0, -1, 0, H]  => (x, y) -> (x,     H - y)
  //   90  -> [ 0,  1,  1,  0, 0, 0]  => (x, y) -> (y,     x)
  //   180 -> [-1,  0,  0,  1, W, 0]  => (x, y) -> (W - x, y)
  //   270 -> [ 0, -1, -1,  0, H, W]  => (x, y) -> (H - y, W - x)
  describe("matches pdf.js PageViewport direction", () => {
    const W = 612;
    const H = 792;
    const point: PdfPoint = { x: 100, y: 700 };

    const expected: Record<Rotation, { x: number; y: number }> = {
      0: { x: point.x, y: H - point.y },
      90: { x: point.y, y: point.x },
      180: { x: W - point.x, y: point.y },
      270: { x: H - point.y, y: W - point.x },
    };

    for (const rotation of rotations) {
      test(`rotation ${rotation}`, () => {
        const got = pdfToDisplay(point, W, H, rotation, 1);
        expect(got.x).toBeCloseTo(expected[rotation].x, 6);
        expect(got.y).toBeCloseTo(expected[rotation].y, 6);
      });
    }

    test("a top-left origin point lands inside the rotated page box", () => {
      // The PDF-space top-left corner (0, H) must map to display (0, 0) at
      // rotation 0, and stay within the rotated page for quarter turns.
      for (const rotation of rotations) {
        const size = rotatedSize(W, H, rotation);
        const corner = pdfToDisplay({ x: 0, y: H }, W, H, rotation, 1);
        expect(corner.x).toBeGreaterThanOrEqual(0);
        expect(corner.y).toBeGreaterThanOrEqual(0);
        expect(corner.x).toBeLessThanOrEqual(size.width);
        expect(corner.y).toBeLessThanOrEqual(size.height);
      }
    });
  });
});
