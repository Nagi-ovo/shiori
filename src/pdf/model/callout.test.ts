import { describe, expect, test } from "bun:test";
import {
  CALLOUT_DEFAULT_HEIGHT_PT,
  calloutConnectorGeometry,
  collapsedCalloutRect,
  collapsedCalloutSizePx,
  CALLOUT_DEFAULT_WIDTH_PT,
  CALLOUT_PAGE_MARGIN_PT,
  placeCalloutLabel,
} from "./callout";
import type { PageModel, PdfRect } from "./types";

const PAGE: PageModel = {
  id: "p1",
  sourceIndex: 0,
  widthPt: 612,
  heightPt: 792,
  rotation: 0,
};

const COLUMN_X = 72;
const COLUMN_RIGHT = 540;

/** 12pt-tall lines on a 14pt pitch, spanning the text column. */
function bodyLines(fromY: number, toY: number): PdfRect[] {
  const lines: PdfRect[] = [];
  for (let y = fromY; y + 12 <= toY; y += 14) {
    lines.push({ x: COLUMN_X, y, w: COLUMN_RIGHT - COLUMN_X, h: 12 });
  }
  return lines;
}

function overlapArea(a: PdfRect, b: PdfRect): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

function coverFraction(label: PdfRect, rects: readonly PdfRect[]): number {
  const covered = rects.reduce((sum, r) => sum + overlapArea(label, r), 0);
  return Math.min(1, covered / (label.w * label.h));
}

function insidePage(rect: PdfRect, page: PageModel = PAGE): boolean {
  const m = CALLOUT_PAGE_MARGIN_PT;
  return (
    rect.x >= m - 1e-6 &&
    rect.y >= m - 1e-6 &&
    rect.x + rect.w <= page.widthPt - m + 1e-6 &&
    rect.y + rect.h <= page.heightPt - m + 1e-6
  );
}

describe("placeCalloutLabel", () => {
  test("keeps the eight-way ring when no text geometry is supplied", () => {
    const target = { x: 250, y: 380, w: 80, h: 14 };
    const rect = placeCalloutLabel(PAGE, [target]);
    // First ring candidate: to the right of the quote, vertically centred.
    expect(rect).toEqual({
      x: target.x + target.w + 18,
      y: target.y + target.h / 2 - CALLOUT_DEFAULT_HEIGHT_PT / 2,
      w: CALLOUT_DEFAULT_WIDTH_PT,
      h: CALLOUT_DEFAULT_HEIGHT_PT,
    });
  });

  test("prefers an outer margin over covering body text", () => {
    const textRects = bodyLines(100, 720);
    const target = { x: COLUMN_X, y: 400, w: COLUMN_RIGHT - COLUMN_X, h: 12 };
    const rect = placeCalloutLabel(PAGE, [target], { textRects });

    const flushLeft = Math.abs(rect.x - CALLOUT_PAGE_MARGIN_PT) < 1e-6;
    const flushRight =
      Math.abs(rect.x + rect.w - (PAGE.widthPt - CALLOUT_PAGE_MARGIN_PT)) < 1e-6;
    expect(flushLeft || flushRight).toBe(true);

    const below = {
      x: PAGE.widthPt / 2 - CALLOUT_DEFAULT_WIDTH_PT / 2,
      y: target.y - 18 - CALLOUT_DEFAULT_HEIGHT_PT,
      w: CALLOUT_DEFAULT_WIDTH_PT,
      h: CALLOUT_DEFAULT_HEIGHT_PT,
    };
    expect(coverFraction(rect, textRects)).toBeLessThan(0.55);
    expect(coverFraction(rect, textRects)).toBeLessThan(
      coverFraction(below, textRects),
    );
  });

  test("narrows to exactly the free margin so it covers nothing", () => {
    const textRects = bodyLines(100, 720);
    const target = { x: COLUMN_X, y: 400, w: COLUMN_RIGHT - COLUMN_X, h: 12 };
    const rect = placeCalloutLabel(PAGE, [target], { textRects });
    // Letter with a 72pt column start leaves 62pt beside the text.
    expect(rect.w).toBeCloseTo(COLUMN_X - CALLOUT_PAGE_MARGIN_PT, 6);
    expect(rect.w).toBeLessThan(CALLOUT_DEFAULT_WIDTH_PT);
    expect(coverFraction(rect, textRects)).toBe(0);
    expect(coverFraction(rect, [target])).toBe(0);
  });

  test("keeps the full width when the margin is too thin to be readable", () => {
    // A 30pt margin cannot hold a legible note; better a wider card than a
    // sliver, so the narrowed candidate is not offered at all.
    const textRects = bodyLines(100, 720).map((line) => ({
      ...line,
      x: 40,
      w: 532,
    }));
    const target = { x: 40, y: 400, w: 532, h: 12 };
    const rect = placeCalloutLabel(PAGE, [target], { textRects });
    expect(rect.w).toBe(CALLOUT_DEFAULT_WIDTH_PT);
  });

  test("reaches the margin even for a short mid-line quote", () => {
    const textRects = bodyLines(100, 720);
    const target = { x: 250, y: 400, w: 60, h: 12 };
    const rect = placeCalloutLabel(PAGE, [target], { textRects });
    expect(rect.x).toBeCloseTo(CALLOUT_PAGE_MARGIN_PT, 6);
  });

  test("drops into the blank band under the last line on a short page", () => {
    // Full-bleed text: no margin wide enough for a note, so the only free
    // space is the band beneath the last line.
    const textRects = bodyLines(600, 720).map((line) => ({
      ...line,
      x: 40,
      w: 532,
    }));
    const target = { x: 40, y: 600, w: 532, h: 12 };
    const rect = placeCalloutLabel(PAGE, [target], { textRects });
    expect(rect.y + rect.h).toBeLessThanOrEqual(600 + 1e-6);
    expect(coverFraction(rect, textRects)).toBe(0);
  });

  test("prefers a clear margin beside the quote over a band far from it", () => {
    const textRects = bodyLines(600, 720);
    const target = { x: COLUMN_X, y: 600, w: COLUMN_RIGHT - COLUMN_X, h: 12 };
    const rect = placeCalloutLabel(PAGE, [target], { textRects });
    expect(coverFraction(rect, textRects)).toBe(0);
    // Vertically level with the line it annotates.
    expect(rect.y).toBeLessThan(612);
    expect(rect.y + rect.h).toBeGreaterThan(600);
  });

  test("never lands in a text-free hole in the middle of the page", () => {
    // A 300pt gap between two text blocks: almost always a figure or a table.
    const textRects = [...bodyLines(100, 300), ...bodyLines(600, 720)];
    const target = { x: COLUMN_X, y: 650, w: COLUMN_RIGHT - COLUMN_X, h: 12 };
    const rect = placeCalloutLabel(PAGE, [target], { textRects });
    const insideHole = rect.y >= 300 && rect.y + rect.h <= 600;
    expect(insideHole).toBe(false);
  });

  test("does not cover the quote it belongs to", () => {
    const textRects = bodyLines(100, 720);
    const target = { x: 250, y: 400, w: 60, h: 12 };
    const rect = placeCalloutLabel(PAGE, [target], { textRects });
    expect(coverFraction(rect, [target])).toBe(0);
  });

  test("keeps clear of a callout already placed on the page", () => {
    const textRects = bodyLines(100, 720);
    const target = { x: 250, y: 400, w: 60, h: 12 };
    const first = placeCalloutLabel(PAGE, [target], { textRects });
    const second = placeCalloutLabel(PAGE, [target], {
      textRects,
      occupiedRects: [first],
    });
    expect(coverFraction(second, [first])).toBeLessThan(0.25);
  });

  test("always stays inside the page margins", () => {
    const textRects = bodyLines(100, 720);
    for (let i = 0; i < 20; i += 1) {
      const target = {
        x: 20 + i * 26,
        y: 30 + i * 37,
        w: 40 + i * 3,
        h: 12,
      };
      for (const environment of [{}, { textRects }]) {
        const rect = placeCalloutLabel(PAGE, [target], environment);
        expect(insidePage(rect)).toBe(true);
        expect(Number.isFinite(rect.x + rect.y + rect.w + rect.h)).toBe(true);
      }
    }
  });

  test("is deterministic and order-independent", () => {
    const textRects = bodyLines(100, 720);
    const a = { x: 100, y: 400, w: 60, h: 12 };
    const b = { x: 180, y: 386, w: 60, h: 12 };
    const first = placeCalloutLabel(PAGE, [a, b], { textRects });
    expect(placeCalloutLabel(PAGE, [a, b], { textRects })).toEqual(first);
    expect(placeCalloutLabel(PAGE, [b, a], { textRects })).toEqual(first);
  });

  test("survives degenerate pages and targets", () => {
    const tiny: PageModel = { ...PAGE, widthPt: 200, heightPt: 150 };
    const rect = placeCalloutLabel(tiny, [{ x: 0, y: 0, w: 0, h: 0 }], {
      textRects: [{ x: 10, y: 10, w: 180, h: 130 }],
    });
    expect(Number.isFinite(rect.x + rect.y + rect.w + rect.h)).toBe(true);
    expect(insidePage(rect, tiny)).toBe(true);

    const huge = placeCalloutLabel(PAGE, [
      { x: -100, y: -100, w: 1000, h: 1000 },
    ]);
    expect(insidePage(huge)).toBe(true);
  });
});

describe("collapsed callout geometry", () => {
  const label = { x: 260, y: 380, w: 144, h: 54 };

  test("the seal is concentric with the label it replaces", () => {
    for (const scale of [0.3, 1, 2.5, 4]) {
      const size = collapsedCalloutSizePx(scale);
      const seal = collapsedCalloutRect(label, size, scale);
      expect(seal.x + seal.w / 2).toBeCloseTo(label.x + label.w / 2, 9);
      expect(seal.y + seal.h / 2).toBeCloseTo(label.y + label.h / 2, 9);
      expect(seal.w).toBeCloseTo(size / scale, 9);
      expect(seal.w).toBe(seal.h);
    }
  });

  test("stays a constant on-screen size through the everyday zoom band", () => {
    expect(collapsedCalloutSizePx(0.3)).toBe(24);
    expect(collapsedCalloutSizePx(1)).toBe(24);
    expect(collapsedCalloutSizePx(1.7)).toBe(24);
    expect(collapsedCalloutSizePx(2)).toBe(28);
    expect(collapsedCalloutSizePx(4)).toBe(40);
    expect(collapsedCalloutSizePx(10)).toBe(40);
  });

  test("collapsing never moves the arrow end of the leader", () => {
    // The whole collapse animation rests on this: same centre means the
    // target endpoint is untouched and only the start slides along its ray.
    const overlay = {
      id: "callout-1",
      rect: label,
      targetRects: [{ x: 100, y: 400, w: 120, h: 12 }],
    };
    const open = calloutConnectorGeometry(overlay);
    const sealed = calloutConnectorGeometry({
      ...overlay,
      rect: collapsedCalloutRect(label, collapsedCalloutSizePx(1), 1),
    });
    expect(sealed.to).toEqual(open.to);
    const labelCenter = { x: label.x + label.w / 2, y: label.y + label.h / 2 };
    const distance = (p: { x: number; y: number }) =>
      Math.hypot(p.x - labelCenter.x, p.y - labelCenter.y);
    expect(distance(sealed.from)).toBeLessThan(distance(open.from));
  });
});
