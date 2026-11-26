import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { PDFDocument, PDFName } from "pdf-lib";
import { openPdfium } from "../../../scripts/pdf-inplace/nativePdfium";
import type { PageModel, PdfRect, SourceImageEditOverlay } from "../model/types";
import { exportPdf } from "./exportPdf";
import { listSourceImages } from "./sourceImages";

const library = "vendor/pdfium/linux-x64/lib/libpdfium.so";
const native = existsSync(library) ? openPdfium(library) : undefined;
afterAll(() => native?.close());
const page: PageModel = {
  id: "picture", sourceIndex: 0, widthPt: 270, heightPt: 235, originXPt: 19, originYPt: 37, rotation: 0,
};
const red = [240, 20, 30], green = [12, 221, 42], blue = [32, 60, 235], gold = [238, 205, 16];

async function fixture(matrix: number[]) {
  const doc = await PDFDocument.create();
  const input = doc.addPage([325, 320]);
  input.setCropBox(page.originXPt!, page.originYPt!, page.widthPt, page.heightPt);
  const ctx = doc.context;
  const image = ctx.register(ctx.flateStream(Uint8Array.from([...red, ...green, ...blue, ...gold]), {
    Type: "XObject", Subtype: "Image", Width: 2, Height: 2, BitsPerComponent: 8, ColorSpace: "DeviceRGB",
  }));
  input.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Picture: image } }));
  input.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(`q ${matrix.join(" ")} cm /Picture Do Q`)));
  const bytes = await doc.save();
  const [target] = await listSourceImages(bytes, 0);
  const run = (patch: Partial<SourceImageEditOverlay>) => exportPdf(bytes, {
    pages: [page], overlays: [{ id: "edit", pageId: page.id, type: "sourceImageEdit", target: target!, ...patch }],
  });
  return { bytes, target: target!, run };
}

function pixels(bytes: Uint8Array) {
  const { width, height, pixels } = native!.inspectPage(bytes, 0, true);
  return (x: number, y: number) => {
    const i = 4 * ((height * 2 - 1 - Math.round(y * 2)) * width * 2 + Math.round(x * 2));
    return Array.from(pixels!.subarray(i, i + 3)).reverse();
  };
}

// A same-bounds mirror can pass a bounds-only check. The labelled samples
// also expose preserved quarter-turns, shear, double origin shifts and crop drift.
test.skipIf(!native).each([
  { label: "mirrored", matrix: [-60, 0, 0, 48, 111, 76], keepBounds: true },
  { label: "quarter-turned", matrix: [0, 68, -46, 0, 123, 69], keepBounds: false },
  { label: "strongly sheared", matrix: [36, 48, 58, 21, 44, 65], keepBounds: false },
])("paints positive rect quadrants for a $label source", async ({ matrix, keepBounds }) => {
  const { target, run } = await fixture(matrix);
  const rect: PdfRect = keepBounds ? target.bbox : { x: 138, y: 93, w: 72, h: 52 };
  const result = await run({ rect });
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "edit", mode: "applied" }]);
  const at = pixels(result.bytes);
  expect(at(rect.x + rect.w / 4, rect.y + rect.h * .75)).toEqual(red);
  expect(at(rect.x + rect.w * .75, rect.y + rect.h * .75)).toEqual(green);
  expect(at(rect.x + rect.w / 4, rect.y + rect.h / 4)).toEqual(blue);
  expect(at(rect.x + rect.w * .75, rect.y + rect.h / 4)).toEqual(gold);
});

test.skipIf(!native)("rotates a requested rect clockwise and clips it in image units", async () => {
  const { run } = await fixture([28, 49, 60, 16, 39, 80]);
  const result = await run({
    rect: { x: 142, y: 103, w: 64, h: 44 }, angle: 90, crop: { x: 0, y: .5, w: 1, h: .5 },
  });
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "edit", mode: "applied" }]);
  const at = pixels(result.bytes);
  expect(at(185, 141)).toEqual(red);
  expect(at(185, 109)).toEqual(green);
  expect(at(163, 141)).toEqual([255, 255, 255]);
  expect(at(163, 109)).toEqual([255, 255, 255]);
});

test.skipIf(!native)("uses the original mirrored and sheared CTM for crop-only and replacement edits", async () => {
  const matrix = [-64, 13, 26, 49, 121, 73];
  const { target, run } = await fixture(matrix);
  const result = await run({ crop: { x: 0, y: 0, w: .5, h: 1 } });
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "edit", mode: "applied" }]);
  const [cropped] = await listSourceImages(result.bytes, 0);
  expect(cropped?.matrix).toEqual(matrix);
  const at = pixels(result.bytes);
  // The affine transform can interpolate by a few sample levels.
  expect(at(105, 76).every((value, i) => Math.abs(value - red[i]!) <= 3)).toBe(true);
  expect(at(93, 52).every((value, i) => Math.abs(value - blue[i]!) <= 3)).toBe(true);
  expect(at(73, 83)).toEqual([255, 255, 255]);
  expect(at(61, 58)).toEqual([255, 255, 255]);
  const replacement = await run({
    replace: {
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    },
  });
  expect(replacement.sourceImageOutcomes).toEqual([{ overlayId: "edit", mode: "applied" }]);
  expect((await listSourceImages(replacement.bytes, 0))[0]?.matrix).toEqual(target.matrix);
});
