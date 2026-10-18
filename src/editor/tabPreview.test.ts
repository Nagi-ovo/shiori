import { describe, expect, test } from "bun:test";
import { previewCrop } from "./tabPreview";

describe("tab preview viewport crop", () => {
  test("keeps the visible page at its position inside the reader viewport", () => {
    const crop = previewCrop(
      { left: 0, top: 0, right: 800, bottom: 550, width: 800, height: 550 },
      { left: 100, top: -50, right: 700, bottom: 750, width: 600, height: 800 },
      1200,
      1600,
    );
    expect(crop).not.toBeNull();
    expect(crop).toMatchObject({
      sx: 0,
      sy: 100,
      sw: 1200,
      sh: 1100,
      dx: 40,
      dy: 0,
      dw: 240,
      dh: 220,
    });
  });

  test("returns no crop for an unmounted or offscreen page", () => {
    expect(
      previewCrop(
        { left: 0, top: 0, right: 800, bottom: 550, width: 800, height: 550 },
        { left: 100, top: 600, right: 700, bottom: 1400, width: 600, height: 800 },
        1200,
        1600,
      ),
    ).toBeNull();
  });
});
