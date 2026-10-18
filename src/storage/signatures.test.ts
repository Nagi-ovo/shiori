import { describe, expect, test } from "bun:test";
import {
  normalizeInkSignature,
  signatureToOverlay,
  type SavedImageSignature,
} from "./signatures";

describe("signature helpers", () => {
  test("normalizes ink paths and places them into PDF space", () => {
    const signature = normalizeInkSignature({
      id: "sig-a",
      name: "Signature",
      paths: [[{ x: 0, y: 0 }, { x: 100, y: 50 }]],
      width: 100,
      height: 50,
      color: "#111111",
      lineWidth: 2,
      now: 10,
    });

    expect(signature.aspectRatio).toBe(2);
    const overlay = signatureToOverlay(
      signature,
      { x: 10, y: 20, w: 200, h: 100 },
      "page-a",
      () => "overlay-a",
    );

    expect(overlay.type).toBe("ink");
    if (overlay.type !== "ink") return;
    expect(overlay.source).toBe("signature");
    expect(overlay.paths[0]).toEqual([
      { x: 10, y: 120 },
      { x: 210, y: 20 },
    ]);
    expect(overlay.width).toBe(4);
  });

  test("preserves image signatures as image overlays", () => {
    const image: SavedImageSignature = {
      kind: "image",
      id: "sig-img",
      name: "Imported",
      dataUrl: "data:image/png;base64,abc",
      mimeType: "image/png",
      width: 300,
      height: 100,
      aspectRatio: 3,
      createdAt: 1,
      updatedAt: 1,
    };

    const overlay = signatureToOverlay(
      image,
      { x: 0, y: 0, w: 100, h: 100 },
      "page-a",
      () => "overlay-img",
    );

    expect(overlay.type).toBe("image");
    if (overlay.type !== "image") return;
    expect(overlay.source).toBe("signature");
    expect(overlay.rect).toEqual({ x: 0, y: 33.33333333333333, w: 100, h: 33.333333333333336 });
    expect(overlay.dataUrl).toBe(image.dataUrl);
  });
});
