import { describe, expect, test } from "bun:test";
import type { Overlay, PdfRect } from "../../pdf/model/types";
import { displayToPdf } from "../../pdf/geometry/coords";
import {
  adjustRect,
  boundsOf,
  cloneOverlay,
  cloneOverlayWithId,
  resizeOverlayGeometry,
  rotateDelta,
  rotateVec,
  translateOverlay,
} from "./geometry";

describe("overlay geometry helpers", () => {
  test("translates every overlay geometry shape without mutating the source", () => {
    const overlays = sampleOverlays();
    for (const overlay of overlays) {
      const cloned = cloneOverlay(overlay);
      const patch = translateOverlay(cloned, 5, -7);
      expect(cloned).toEqual(overlay);
      if ("rect" in patch && patch.rect) {
        expect(patch.rect.x).toBe((overlay as { rect: PdfRect }).rect.x + 5);
        expect(patch.rect.y).toBe((overlay as { rect: PdfRect }).rect.y - 7);
      }
      if ("rects" in patch && patch.rects) {
        expect(patch.rects[0]?.x).toBe(15);
        expect(patch.rects[0]?.y).toBe(13);
      }
      if ("coverRects" in patch && patch.coverRects) {
        expect(patch.coverRects[0]?.x).toBe(25);
        expect(patch.coverRects[0]?.y).toBe(23);
      }
      if ("paths" in patch && patch.paths) {
        expect(patch.paths[0]?.[0]).toEqual({ x: 6, y: -5 });
      }
    }
  });

  test("clones overlays with a fresh id without sharing geometry", () => {
    const source = sampleOverlays()[1]!;
    const copy = cloneOverlayWithId(source, "copy");

    expect(copy).toEqual({ ...source, id: "copy" });
    if (copy.type !== "ink" || source.type !== "ink") {
      throw new Error("sample overlay should be ink");
    }

    copy.paths[0]![0]!.x = 99;
    expect(source.paths[0]?.[0]?.x).toBe(1);
  });


  test("a copy does not inherit where the original came from", () => {
    // Paste, duplicate and alt-drag all mint a NEW annotation. Carrying the
    // original's provenance made a fresh copy claim a stranger's authorship —
    // it would export attributed to them, and the Live digest would rank it
    // as old imported content rather than something the reader just made.
    const source = {
      ...sampleOverlays()[1]!,
      origin: "imported" as const,
      importedAt: 1_700_000_000_000,
      sourceAuthor: "Acrobat reviewer",
      sourceCreatedAt: 1_600_000_000_000,
      sourceModifiedAt: 1_650_000_000_000,
      sourceInReplyToId: "pdf-annotation-0-42",
      sourceReplyType: "R" as const,
    };

    const copy = cloneOverlayWithId(source, "copy");

    expect(copy.origin).toBeUndefined();
    expect(copy.importedAt).toBeUndefined();
    expect(copy.sourceAuthor).toBeUndefined();
    expect(copy.sourceCreatedAt).toBeUndefined();
    expect(copy.sourceModifiedAt).toBeUndefined();
    expect(copy.sourceInReplyToId).toBeUndefined();
    expect(copy.sourceReplyType).toBeUndefined();
    // The original is untouched.
    expect(source.sourceAuthor).toBe("Acrobat reviewer");
  });

  test("rotates drag deltas from display space into PDF space", () => {
    expect(rotateDelta(10, 4, 0)).toEqual({ x: 10, y: -4 });
    expect(rotateDelta(10, 4, 90)).toEqual({ x: 4, y: 10 });
    expect(rotateDelta(10, 4, 180)).toEqual({ x: -10, y: 4 });
    expect(rotateDelta(10, 4, 270)).toEqual({ x: -4, y: -10 });
  });

  // rotateDelta must equal the linear part of coords.ts displayToPdf, or a
  // drag on a rotated page moves the overlay somewhere other than the cursor.
  // Deriving it numerically here means the two can never drift apart again.
  test("matches the linear part of displayToPdf on every rotation", () => {
    const W = 612;
    const H = 792;
    const origin = { x: 200, y: 300 };
    const delta = { x: 10, y: 4 };

    for (const rotation of [0, 90, 180, 270] as const) {
      const before = displayToPdf(origin, W, H, rotation, 1);
      const after = displayToPdf(
        { x: origin.x + delta.x, y: origin.y + delta.y },
        W,
        H,
        rotation,
        1,
      );
      const expected = { x: after.x - before.x, y: after.y - before.y };
      const got = rotateDelta(delta.x, delta.y, rotation);
      expect(got.x).toBeCloseTo(expected.x, 6);
      expect(got.y).toBeCloseTo(expected.y, 6);
    }
  });

  test("resizes rectangles through rotated handles and clamps tiny boxes", () => {
    const start: PdfRect = { x: 10, y: 20, w: 100, h: 60 };
    expect(adjustRect(start, "se", { x: 10, y: -5 }, 0)).toEqual({
      x: 10,
      y: 15,
      w: 110,
      h: 65,
    });
    expect(adjustRect(start, "nw", { x: 200, y: -200 }, 0)).toEqual({
      x: 210,
      y: 20,
      w: 4,
      h: 4,
    });
    expect(adjustRect(start, "nw", { x: 5, y: 5 }, 90)).toEqual({
      x: 10,
      y: 20,
      w: 105,
      h: 65,
    });
  });

  test("rotateVec spins a vector clockwise in a y-down frame", () => {
    const near = (got: { x: number; y: number }, x: number, y: number) => {
      expect(got.x).toBeCloseTo(x, 9);
      expect(got.y).toBeCloseTo(y, 9);
    };
    // Identity at 0°.
    near(rotateVec(10, 0, 0), 10, 0);
    near(rotateVec(3, -7, 0), 3, -7);
    // 90° clockwise (y-down): +x → +y.
    near(rotateVec(10, 0, 90), 0, 10);
    // 180°: negate both.
    near(rotateVec(10, 0, 180), -10, 0);
    near(rotateVec(3, -7, 180), -3, 7);
    // 270°: +x → -y.
    near(rotateVec(10, 0, 270), 0, -10);
    // Inverse round-trips back to the original vector.
    near(rotateVec(rotateVec(5, 9, 37).x, rotateVec(5, 9, 37).y, -37), 5, 9);
  });

  test("resize composes the element angle: un-spin then adjust", () => {
    // A box rotated 90° (clockwise) on an unrotated page. The user grabs
    // the SE handle and drags +10px right (display dx) / 0 down. Because
    // the box is spun 90°, that screen drag is "down" in the box's local
    // frame, so we un-spin by -90° before the page pipeline.
    const start: PdfRect = { x: 10, y: 20, w: 100, h: 60 };
    const dxPt = 10;
    const dyPt = 0;
    const theta = 90;
    const local = rotateVec(dxPt, dyPt, -theta);
    // rotateVec(10,0,-90) = (0,-10): the drag is purely in local -y.
    expect(local.x).toBeCloseTo(0, 9);
    expect(local.y).toBeCloseTo(-10, 9);
    const dPdf = rotateDelta(local.x, local.y, 0); // page rotation 0
    const rect = adjustRect(start, "se", dPdf, 0);
    // rotateDelta(0,-10,0) = {x:0, y:10}; adjustRect SE: w+=0, y+=10, h-=10.
    expect(rect).toEqual({ x: 10, y: 30, w: 100, h: 50 });

    // θ=0 must be byte-identical to a plain resize (regression guard).
    const local0 = rotateVec(10, -5, -0);
    const dPdf0 = rotateDelta(local0.x, local0.y, 0);
    expect(adjustRect(start, "se", dPdf0, 0)).toEqual(
      adjustRect(start, "se", rotateDelta(10, -5, 0), 0),
    );
  });

  test("resizes content text covers with the text box", () => {
    const overlay = sampleOverlays().find((o) => o.type === "contentText");
    if (!overlay || overlay.type !== "contentText") {
      throw new Error("sample overlay should include content text");
    }

    const patch = resizeOverlayGeometry(overlay, {
      x: 28,
      y: 10,
      w: 140,
      h: 40,
    });

    expect(patch.rect).toEqual({ x: 28, y: 10, w: 140, h: 40 });
    expect(patch.coverRects).toEqual([{ x: 32, y: 30, w: 128, h: 24 }]);
  });

  test("resizes ink geometry by scaling paths from their bounds", () => {
    const overlay: Overlay = {
      type: "ink",
      id: "sig",
      pageId: "p",
      paths: [[{ x: 10, y: 20 }, { x: 30, y: 40 }]],
      color: "#111111",
      width: 2,
      source: "signature",
    };

    const patch = resizeOverlayGeometry(overlay, {
      x: 100,
      y: 200,
      w: 40,
      h: 80,
    }) as Partial<Extract<Overlay, { type: "ink" }>>;

    expect(patch.paths).toEqual([[{ x: 100, y: 200 }, { x: 140, y: 280 }]]);
    expect(patch.width).toBe(4);
  });

  test("computes ink bounds with a non-zero hit target", () => {
    expect(boundsOf([{ x: 4, y: 7 }])).toEqual({ x: 4, y: 7, w: 1, h: 1 });
    expect(
      boundsOf([
        { x: 4, y: 7 },
        { x: -2, y: 12 },
        { x: 8, y: 3 },
      ]),
    ).toEqual({ x: -2, y: 3, w: 10, h: 9 });
  });
});

function sampleOverlays(): Overlay[] {
  return [
    {
      type: "highlight",
      id: "h",
      pageId: "p",
      rects: [{ x: 10, y: 20, w: 30, h: 12 }],
      color: "#f4d674",
      opacity: 0.4,
    },
    {
      type: "ink",
      id: "i",
      pageId: "p",
      paths: [[{ x: 1, y: 2 }]],
      color: "#111111",
      width: 2,
    },
    {
      type: "text",
      id: "t",
      pageId: "p",
      rect: { x: 5, y: 8, w: 40, h: 20 },
      text: "hello",
      fontSize: 12,
      color: "#111111",
      bold: false,
      align: "left",
      fontFamily: "sans",
    },
    {
      type: "strikethrough",
      id: "s",
      pageId: "p",
      rects: [{ x: 10, y: 20, w: 30, h: 12 }],
      color: "#b13a2e",
      opacity: 1,
    },
    {
      type: "stamp",
      id: "stamp",
      pageId: "p",
      kind: "cross",
      rect: { x: 12, y: 24, w: 14, h: 14 },
      color: "#1a1815",
      strokeWidth: 1.8,
    },
    {
      type: "contentText",
      id: "ct",
      pageId: "p",
      rect: { x: 18, y: 20, w: 70, h: 20 },
      coverRects: [{ x: 20, y: 30, w: 64, h: 12 }],
      originalText: "old",
      text: "new",
      fontSize: 12,
      color: "#111111",
      bold: false,
      align: "left",
      fontFamily: "sans",
      backgroundColor: "#ffffff",
    },
  ];
}

describe("contentText baseline translation", () => {

  test("translating a contentText edit moves its absolute baselines too", () => {
    const overlay = sampleOverlays().find((o) => o.type === "contentText");
    if (!overlay || overlay.type !== "contentText") {
      throw new Error("sample overlay should include content text");
    }
    // sourceBaselinesPt is absolute page-space: render and export draw at
    // baselines[i] directly, so a translate that moves the covers must
    // carry the baselines (mirrors pageSpace.ts).
    const withBaselines = { ...overlay, sourceBaselinesPt: [38, 26] };
    const patch = translateOverlay(withBaselines, 5, -7) as {
      sourceBaselinesPt?: number[];
    };
    expect(patch.sourceBaselinesPt).toEqual([31, 19]);
  });
});
