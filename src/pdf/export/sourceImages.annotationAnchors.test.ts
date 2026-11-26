import { expect, test } from "bun:test";
import { PDFDocument, PDFName } from "pdf-lib";
import { buildContentTextPreview } from "../../editor/components/contentTextPreview";
import type { PageModel, SourceImageEditOverlay } from "../model/types";
import { exportPdf } from "./exportPdf";
import { listSourceImages } from "./sourceImages";

const page: PageModel = { id: "image", sourceIndex: 0, widthPt: 300, heightPt: 200, rotation: 0 };
const options = { preserveSourceAnnotations: true };
const unchangedBounds = { x: 40, y: 70, w: 40, h: 30 };

async function replaceImage(content: string, geometry: Partial<Pick<SourceImageEditOverlay, "crop" | "rect">> = {}) {
  const doc = await PDFDocument.create();
  const input = doc.addPage([page.widthPt, page.heightPt]);
  const ctx = doc.context;
  const image = ctx.register(ctx.flateStream(Uint8Array.of(100), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8,
  }));
  input.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { Image: image } }));
  input.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
  input.node.set(PDFName.of("Annots"), ctx.obj([{ Subtype: "Link", Rect: [65, 75, 70, 85] }]));
  const source = await doc.save();
  const [target] = await listSourceImages(source, 0);
  const overlays: SourceImageEditOverlay[] = [{
    id: "replace", type: "sourceImageEdit", pageId: page.id, target: target!,
    replace: {
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    },
    ...geometry,
  }];
  const result = await exportPdf(source, { pages: [page], overlays }, options);
  const preview = await buildContentTextPreview(source, page, overlays, undefined, undefined, options);
  expect(preview.imageOutcomes).toEqual(result.sourceImageOutcomes);
  return { source, target: target!, result, preview };
}

const clipped = "q 60 70 20 30 re W n 40 0 0 30 40 70 cm /Image Do Q";

// The writer must distinguish a restated clip from a crop that removes
// visible paint and a rect that changes sample orientation at the same bounds.
test.each([
  { label: "without geometry" },
  { label: "with an explicitly unchanged rect", rect: unchangedBounds, crop: { x: .5, y: 0, w: .5, h: 1 } },
  { label: "with the authored clip restated", crop: { x: .5, y: 0, w: .5, h: 1 } },
  { label: "with a sheared authored clip restated",
    content: "q 40 12 -5 30 40 65 cm .5 0 .5 1 re W n /Image Do Q", crop: { x: .5, y: 0, w: .5, h: 1 } },
])("installs a same-place replacement $label under a link", async ({ content, crop, rect }) => {
  const { result, target, preview } = await replaceImage(content ?? clipped, { crop, rect });
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "replace", mode: "applied" }]);
  const [saved] = await listSourceImages(result.bytes, 0);
  expect(saved?.matrix).toEqual(target.matrix);
  expect(saved?.fingerprint).not.toBe(target.fingerprint);
  expect(await listSourceImages(preview.bytes!, 0)).toEqual([saved]);
});

test.each([
  { label: "a crop that removes visible paint", content: clipped, crop: { x: .75, y: 0, w: .25, h: 1 } },
  { label: "a crop that cuts a corner inside an unchanged visible box",
    content: "q 400 0 -200 200 -50 0 cm /Image Do Q", crop: { x: .25, y: 0, w: .75, h: 1 } },
  { label: "a mirror correction with the same visible box",
    content: "q -40 0 0 30 80 70 cm /Image Do Q", rect: unchangedBounds },
])("refuses $label under a link", async ({ content, crop, rect }) => {
  const { source, result, preview } = await replaceImage(content, { crop, rect });
  expect(result.sourceImageOutcomes).toEqual([{
    overlayId: "replace", mode: "unsupported", reason: "annotation-anchor",
    detail: "annotation direct:0 Link",
    anchoredAnnotations: [{ ref: "direct:0", subtype: "Link", kind: "link", rect: [65, 75, 70, 85] }],
  }]);
  expect(result.bytes).toEqual(source);
  expect(preview.bytes).toBeNull();
});
