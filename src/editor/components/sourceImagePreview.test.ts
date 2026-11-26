import { expect, test } from "bun:test";
import { sourceImageAddress } from "../store/sourceImageEdits";
import { PDFDict, PDFName } from "pdf-lib";
import { fixture, model, overlay } from "../../pdf/export/contentText/fixtures.test-support";
import { listSourceImages } from "../../pdf/export/sourceImages";
import { renderFixtureRegion } from "../../../scripts/pdf-inplace/fixtureRaster.test-support";
import { buildContentTextPreview } from "./contentTextPreview";
import type { SourceImageEditOverlay } from "../../pdf/model/types";

const page = model([]).pages[0]!;

test("writer preview raster shows moved masked pixels, foreground paint and edited text together", async () => {
  const { doc, page: input } = await fixture(
    "0 1 0 rg 0 0 300 200 re f q 30 0 0 30 50 45 cm /I Do Q 0 0 1 rg 125 53 7 9 re f BT 0 g /F1 10 Tf 50 100 Td (ABCDE) Tj ET",
  );
  const ctx = doc.context;
  const mask = ctx.register(ctx.flateStream(Uint8Array.of(0, 255), {
    Type: "XObject", Subtype: "Image", Width: 2, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8,
  }));
  const image = ctx.register(ctx.flateStream(Uint8Array.of(255, 0, 0, 255, 0, 0), {
    Type: "XObject", Subtype: "Image", Width: 2, Height: 1, ColorSpace: "DeviceRGB", BitsPerComponent: 8, SMask: mask,
  }));
  input.node.lookup(PDFName.of("Resources"), PDFDict).set(PDFName.of("XObject"), ctx.obj({ I: image }));
  const bytes = await doc.save();
  const [paint] = await listSourceImages(bytes, 0);
  const edit: SourceImageEditOverlay = {
    id: "image", pageId: page.id, type: "sourceImageEdit", target: sourceImageAddress(paint!),
    rect: { x: 109, y: 45, w: 30, h: 30 },
  };
  const result = await buildContentTextPreview(bytes, page, [overlay(), edit]);
  expect(result.outcomes).toMatchObject([{ mode: "in-place" }]);
  expect(result.imageOutcomes).toEqual([{ overlayId: edit.id, mode: "applied" }]);
  const bounds = (await listSourceImages(result.bytes!, 0))[0]!.bbox;
  expect(bounds.x).toBeCloseTo(edit.rect!.x, 5);
  expect(bounds).toMatchObject({ y: 45, w: 30, h: 30 });
  const imageOnly = await buildContentTextPreview(bytes, page, [edit]);
  expect(imageOnly.bytes).not.toBeNull();
  const refused = await buildContentTextPreview(bytes, page, [{ ...edit, target: { ...edit.target, fingerprint: "0".repeat(64) } }]);
  expect(refused.bytes).toBeNull();
  expect(refused.imageOutcomes).toMatchObject([{ mode: "unsupported", reason: "stale-source" }]);
  if (Bun.which("pdftoppm")) {
    const raster = await renderFixtureRegion(result.bytes!, 0, { x: 0, y: 0, width: 300, height: 200 }, 1);
    const color = (x: number, y: number) => {
      const offset = ((199 - y) * raster.width + x) * 4;
      return Array.from(raster.data.subarray(offset, offset + 3));
    };
    expect(color(73, 52)).toEqual([0, 255, 0]);
    expect(color(113, 52)).toEqual([0, 255, 0]);
    expect(color(135, 52)).toEqual([255, 0, 0]);
    expect(color(128, 57)).toEqual([0, 0, 255]);
  }
});
