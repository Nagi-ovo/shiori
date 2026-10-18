import { describe, expect, test } from "bun:test";
import type { Overlay, PageModel } from "./types";
import {
  overlayToPdfPageSpace,
  pdfPointToPageLocal,
  pdfRectToPageLocal,
} from "./pageSpace";

const page: PageModel = {
  id: "p1",
  sourceIndex: 0,
  rotation: 0,
  originXPt: 50,
  originYPt: 100,
  widthPt: 300,
  heightPt: 400,
};

describe("page-space conversions", () => {
  test("converts source PDF points and rects into visible-page local space", () => {
    expect(pdfPointToPageLocal(page, { x: 72, y: 130 })).toEqual({
      x: 22,
      y: 30,
    });
    expect(pdfRectToPageLocal(page, { x: 60, y: 120, w: 40, h: 20 })).toEqual({
      x: 10,
      y: 20,
      w: 40,
      h: 20,
    });
  });

  test("translates overlay geometry back into source PDF page space", () => {
    const overlay: Overlay = {
      id: "content",
      type: "contentText",
      pageId: "p1",
      rect: { x: 10, y: 20, w: 80, h: 24 },
      coverRects: [{ x: 12, y: 22, w: 76, h: 18 }],
      originalText: "Old",
      text: "New",
      fontSize: 12,
      color: "#1a1815",
      bold: false,
      align: "left",
      fontFamily: "sans",
      backgroundColor: "#ffffff",
    };

    expect(overlayToPdfPageSpace(page, overlay)).toMatchObject({
      rect: { x: 60, y: 120, w: 80, h: 24 },
      coverRects: [{ x: 62, y: 122, w: 76, h: 18 }],
    });
  });

  test("translates callout target, label, and leader together", () => {
    const overlay: Overlay = {
      id: "callout",
      type: "callout",
      pageId: "p1",
      targetRects: [{ x: 10, y: 20, w: 80, h: 14 }],
      rect: { x: 130, y: 5, w: 144, h: 54 },
      leader: [
        { x: 90, y: 27 },
        { x: 110, y: 32 },
        { x: 130, y: 32 },
      ],
      leaderKind: "polyline",
      text: "Explain",
      fontSize: 12,
      color: "#b13a2e",
      bold: false,
      align: "left",
      fontFamily: "sans",
    };

    expect(overlayToPdfPageSpace(page, overlay)).toMatchObject({
      rect: { x: 180, y: 105, w: 144, h: 54 },
      targetRects: [{ x: 60, y: 120, w: 80, h: 14 }],
      leader: [
        { x: 140, y: 127 },
        { x: 160, y: 132 },
        { x: 180, y: 132 },
      ],
    });
  });
});
