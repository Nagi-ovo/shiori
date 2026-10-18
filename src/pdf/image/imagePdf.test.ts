import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { imageBytesToPdf } from "./imagePdf";

const onePixelPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("image PDF helpers", () => {
  test("wraps an image as a one-page PDF", async () => {
    const out = await imageBytesToPdf(onePixelPng, "image/png");
    const loaded = await PDFDocument.load(out);
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getPage(0).getWidth()).toBe(1);
    expect(loaded.getPage(0).getHeight()).toBe(1);
  });
});
