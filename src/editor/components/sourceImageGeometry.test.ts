import { expect, test } from "bun:test";
import { sourceImageAddress } from "../store/sourceImageEdits";
import { PDFDocument, PDFName } from "pdf-lib";
import { exportPdf } from "../../pdf/export/exportPdf";
import { listImmutableSourceImages, listSourceImages, type SourceImageInfo } from "../../pdf/export/sourceImages";
import type { PageModel, SourceImageEditOverlay } from "../../pdf/model/types";
import { buildContentTextPreview } from "./contentTextPreview";
import { hitSourceImage, imageGesturePatch, imageResizePoint, imageVisibleCrop, imageVisibleOutline } from "./sourceImageGeometry";

const page: PageModel = {
  id: "images", sourceIndex: 1, widthPt: 180, heightPt: 120, rotation: 90, originXPt: 20, originYPt: 30,
};

test("visible skewed and cropped paint wins at rotated zoom, with overlap resolved in paint order", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const p = pdf.addPage([250, 200]);
  p.setCropBox(20, 30, 180, 120);
  const ctx = pdf.context;
  const image = ctx.register(ctx.flateStream(Uint8Array.of(255), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8,
  }));
  p.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { I: image } }));
  p.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(
    "q 80 0 0 60 30 40 cm /I Do Q q 40 10 20 40 40 45 cm /I Do Q",
  )));
  const paints = await listSourceImages(await pdf.save(), 1);
  const hit = (x: number, y: number, edits: SourceImageEditOverlay[] = []) =>
    hitSourceImage(paints, edits, page, 2, { x, y })?.occurrence;
  expect(hit(80, 100)).toBe(1); // inside both paints
  expect(hit(34, 145)).toBe(0); // inside upper paint's AABB, outside its unit square
  const crop: SourceImageEditOverlay = {
    id: "edit", type: "sourceImageEdit", pageId: page.id,
    target: sourceImageAddress(paints[1]!), crop: { x: .7, y: 0, w: .3, h: 1 },
  };
  expect(hit(80, 100, [crop])).toBe(0);
  expect(hit(80, 124, [crop])).toBe(1);
  expect(hit(80, 124, [{ ...crop, delete: true }])).toBe(0);
  const moved = { ...crop, crop: undefined, rect: { x: 95, y: 15, w: 60, h: 50 }, angle: 90 };
  expect(hit(80, 100, [moved])).toBe(0);
  expect(hit(80, 250, [moved])).toBe(1);
  expect(hit(80, 100, [{ ...crop, pageId: "other" }])).toBe(1);
});

test("dragging the rotated resize handle pins the opposite corner and crop stays in image units", async () => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([200, 200]);
  const ctx = pdf.context;
  p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(
    "q 40 0 0 20 10 10 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI Q",
  )));
  const [paint] = await listSourceImages(await pdf.save(), 0);
  const edit: SourceImageEditOverlay = { type: "sourceImageEdit", id: "edit", pageId: page.id,
    target: sourceImageAddress(paint!), angle: 90 };
  expect(imageGesturePatch(paint!, edit, "resize", { x: 40, y: 0 }, { x: 50, y: -20 })).toEqual({
    rect: { x: 5, y: -5, w: 60, h: 30 },
  });
  expect(imageGesturePatch(paint!, edit, "crop", { x: 40, y: 0 }, { x: 35, y: 10 }).crop).toEqual({
    x: 0, y: 0, w: .75, h: .75,
  });
});

test("nested Form and rectangular source clips let the visible paint below receive the click", async () => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([180, 120]);
  const ctx = pdf.context;
  const image = ctx.register(ctx.flateStream(Uint8Array.of(0), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8,
  }));
  const form = ctx.register(ctx.flateStream("q 0 0 40 25 re W n 80 0 0 50 0 0 cm /I Do Q", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 30, 50], Resources: { XObject: { I: image } },
  }));
  p.node.set(PDFName.of("Resources"), ctx.obj({ XObject: { I: image, F: form } }));
  p.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(
    "q 100 0 0 100 10 10 cm /I Do Q q 1 0 0 1 10 10 cm /F Do Q",
  )));
  const images = await listImmutableSourceImages(await pdf.save(), 0);
  const targetPage = { ...page, sourceIndex: 0, rotation: 0 as const, originXPt: 0, originYPt: 0 };
  const hit = (x: number, y: number) => hitSourceImage(images, [], targetPage, 1, { x, y: 120 - y })?.occurrence;
  expect(hit(23, 21)).toBe(1);
  expect(hit(45, 21)).toBe(0);
  expect(hit(23, 43)).toBe(0);
});

test("an explicit same-bounds rect replaces shear for selection and the resize handle follows the cropped outline", () => {
  const image: SourceImageInfo = {
    pageIndex: 1, occurrence: 0, kind: "inline", formPath: [], fingerprint: "ab".repeat(32),
    bbox: { x: 20, y: 10, w: 80, h: 60 }, matrix: [25, 40, 55, 20, 40, 40],
    widthPx: 2, heightPx: 2, masked: false, shared: false,
  };
  const p = { ...page, rotation: 0 as const };
  const edit: SourceImageEditOverlay = {
    id: "edited", type: "sourceImageEdit", pageId: p.id, target: sourceImageAddress(image), rect: image.bbox,
  };
  expect(hitSourceImage([image], [], p, 1, { x: 93, y: 106 })).toBeUndefined();
  expect(hitSourceImage([image], [edit], p, 1, { x: 93, y: 106 })).toBe(image);
  const crop = { x: .125, y: .25, w: .375, h: .5 };
  expect(imageResizePoint(image, { crop })).toEqual({ x: 73.75, y: 45 });
  expect(imageResizePoint(image, { rect: image.bbox, angle: 90, crop })).toEqual({ x: 75, y: 40 });
});

test("resize accepts sub-point dimensions and ignores zero motion and invalid dimensions", () => {
  const image: SourceImageInfo = {
    pageIndex: 1, occurrence: 0, kind: "inline", formPath: [], fingerprint: "cd".repeat(32),
    bbox: { x: 15, y: 20, w: 6, h: 5 }, matrix: [6, 0, 0, 5, 35, 50],
    widthPx: 1, heightPx: 1, masked: false, shared: false,
  };
  const corner = { x: 21, y: 25 };
  expect(imageGesturePatch(image, undefined, "resize", corner, { x: 15.25, y: 25 })).toEqual({
    rect: { x: 15, y: 20, w: .25, h: 5 },
  });
  expect(imageGesturePatch(image, undefined, "resize", corner, corner)).toEqual({});
  expect(imageGesturePatch(image, undefined, "move", corner, corner)).toEqual({});
  expect(imageGesturePatch(image, undefined, "resize", corner, { x: 15, y: 25 })).toEqual({});
  expect(imageGesturePatch(image, undefined, "resize", corner, { x: 15 + 1e-12, y: 25 })).toEqual({});
  const cropped: SourceImageEditOverlay = {
    id: "cropped", type: "sourceImageEdit", pageId: page.id, target: sourceImageAddress(image),
    crop: { x: .25, y: .25, w: .5, h: .5 },
  };
  const start = { x: 19.5, y: 23.75 };
  expect(imageGesturePatch(image, cropped, "resize", start, { x: 20.5, y: 24.75 })).toEqual({
    rect: { x: 14.5, y: 19.5, w: 8, h: 7 },
  });
});

test("a settled isolated escape can be selected at the destination shown by preview", async () => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([180, 120]);
  const ctx = pdf.context;
  p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(
    "q 20 20 40 20 re W n q 40 0 0 20 20 20 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI Q Q",
  )));
  const bytes = await pdf.save();
  const images = await listImmutableSourceImages(bytes, 0);
  const targetPage = { ...page, sourceIndex: 0, rotation: 0 as const, originXPt: 0, originYPt: 0 };
  const edit: SourceImageEditOverlay = {
    type: "sourceImageEdit", id: "move", pageId: page.id, target: sourceImageAddress(images[0]!),
    rect: { x: 90, y: 50, w: 40, h: 20 },
  };
  const preview = await buildContentTextPreview(bytes, targetPage, [edit]);
  expect(preview.imageOutcomes).toEqual([{ overlayId: edit.id, mode: "applied" }]);
  expect(hitSourceImage(images, [edit], targetPage, 1, { x: 110, y: 60 })).toBe(images[0]);
  expect(hitSourceImage(images, [edit], targetPage, 1, { x: 40, y: 90 })).toBeUndefined();
});

test("a refused escape keeps the source clip in the preview outline and hit test", async () => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([180, 120]);
  const ctx = pdf.context;
  p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(
    "q 20 20 m 60 20 l 40 40 l h W n q 40 0 0 20 20 20 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI Q Q",
  )));
  const bytes = await pdf.save();
  const images = await listImmutableSourceImages(bytes, 0);
  const targetPage = { ...page, sourceIndex: 0, rotation: 0 as const, originXPt: 0, originYPt: 0 };
  const edit: SourceImageEditOverlay = {
    type: "sourceImageEdit", id: "move", pageId: page.id, target: sourceImageAddress(images[0]!),
    rect: { x: 90, y: 50, w: 40, h: 20 },
  };
  const preview = await buildContentTextPreview(bytes, targetPage, [edit]);
  expect(preview.imageOutcomes?.[0]).toMatchObject({ mode: "unsupported", reason: "unsupported-context" });
  expect(preview.bytes).toBeNull();
  const drawnEdits = [edit].filter(o => preview.imageOutcomes?.some(r => r.overlayId === o.id && r.mode === "applied"));
  const outline = imageVisibleOutline(images[0]!, drawnEdits[0], targetPage);
  expect(new Set(outline.map(({ x, y }) => `${x},${y}`))).toEqual(new Set(["20,20", "60,20", "40,40"]));
  expect(hitSourceImage(images, drawnEdits, targetPage, 1, { x: 40, y: 94 })).toBe(images[0]);
  expect(hitSourceImage(images, drawnEdits, targetPage, 1, { x: 24, y: 84 })).toBeUndefined();
  expect(hitSourceImage(images, drawnEdits, targetPage, 1, { x: 110, y: 60 })).toBeUndefined();
});

test("cropping starts at the visible handle and refuses a drag into hidden samples", async () => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([180, 120]);
  const ctx = pdf.context;
  p.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(
    "q 20 20 20 20 re W n q 40 0 0 20 20 20 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI Q Q",
  )));
  const bytes = await pdf.save();
  const [image] = await listImmutableSourceImages(bytes, 0);
  const targetPage = { ...page, sourceIndex: 0, rotation: 0 as const, originXPt: 0, originYPt: 0 };
  const outline = imageVisibleOutline(image!, undefined, targetPage);
  const crop = imageVisibleCrop(image!, undefined, outline);
  expect(crop).toEqual({ x: 0, y: 0, w: .5, h: 1 });
  const patch = imageGesturePatch(image!, undefined, "crop", { x: 40, y: 40 }, { x: 36, y: 40 }, false, crop);
  expect(patch.crop).toEqual({ x: 0, y: 0, w: .4, h: 1 });

  const outward = imageGesturePatch(image!, undefined, "crop", { x: 40, y: 40 }, { x: 50, y: 40 }, false, crop);
  expect(outward.crop).toEqual({ x: 0, y: 0, w: .75, h: 1 });
  const edit: SourceImageEditOverlay = {
    type: "sourceImageEdit", id: "crop", pageId: targetPage.id, target: sourceImageAddress(image!), ...outward,
  };
  const preview = await buildContentTextPreview(bytes, targetPage, [edit]);
  expect(preview.imageOutcomes).toMatchObject([{ overlayId: edit.id, mode: "unsupported", reason: "unsupported-context" }]);
  expect(preview.acceptance).toMatchObject({ status: "needs-review", findings: [{ kind: "unexcised-edit", count: 1 }] });
  expect(preview.bytes).toBeNull();

  const result = await exportPdf(bytes, { pages: [targetPage], overlays: [edit] }, { acceptance: "review" });
  expect(result.sourceImageOutcomes).toEqual(preview.imageOutcomes);
  expect(result.unexcisedEdits).toBe(1);
  expect(result.acceptance.status).toBe("needs-review");
  expect(result.bytes).toEqual(bytes);
});
