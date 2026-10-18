import { describe, expect, test } from "bun:test";
import {
  collapsedCalloutRect,
  collapsedCalloutSizePx,
} from "../../../pdf/model/callout";
import type { CalloutOverlay, PageModel } from "../../../pdf/model/types";
import { overlayHitsMarquee } from "./overlayHitTesting";

const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};

const callout: CalloutOverlay = {
  type: "callout",
  id: "callout-1",
  pageId: page.id,
  targetRects: [{ x: 100, y: 400, w: 120, h: 12 }],
  rect: { x: 300, y: 380, w: 144, h: 54 },
  text: "A remark",
  fontSize: 12,
  color: "#b13a2e",
  bold: false,
  align: "left",
  fontFamily: "sans",
};

const scale = 1;
const seal = collapsedCalloutRect(
  callout.rect,
  collapsedCalloutSizePx(scale),
  scale,
);

/** PDF rect → display marquee, for a page with no rotation at scale 1. */
function marqueeOver(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number; w: number; h: number } {
  return {
    x: rect.x,
    y: page.heightPt - (rect.y + rect.h),
    w: rect.w,
    h: rect.h,
  };
}

describe("overlayHitsMarquee for callouts", () => {
  test("catches the open label box", () => {
    expect(
      overlayHitsMarquee(callout, marqueeOver(callout.rect), page, scale),
    ).toBe(true);
  });

  test("a collapsed callout is only where its seal is", () => {
    // The corner of the old card, well clear of the concentric seal.
    const oldCorner = { x: callout.rect.x + 2, y: callout.rect.y + 2, w: 8, h: 8 };
    expect(
      overlayHitsMarquee(callout, marqueeOver(oldCorner), page, scale, seal),
    ).toBe(false);
    expect(
      overlayHitsMarquee(callout, marqueeOver(seal), page, scale, seal),
    ).toBe(true);
  });

  test("the quoted text stays selectable in both states", () => {
    const overTarget = marqueeOver(callout.targetRects[0]!);
    expect(overlayHitsMarquee(callout, overTarget, page, scale)).toBe(true);
    expect(overlayHitsMarquee(callout, overTarget, page, scale, seal)).toBe(
      true,
    );
  });
});
