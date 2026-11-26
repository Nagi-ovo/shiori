import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { openPdfium } from "../../../scripts/pdf-inplace/nativePdfium";
import type { PdfRect, Overlay, PageModel, SourceImageEditOverlay } from "../model/types";
import { fixture, overlay as textEdit } from "./contentText/fixtures.test-support";
import { exportPdf } from "./exportPdf";
import { inspectSourceImages, listSourceImages, type SourceImageAddress } from "./sourceImages";

const key = PDFName.of;
const library = "vendor/pdfium/linux-x64/lib/libpdfium.so";
const native = existsSync(library) ? openPdfium(library) : undefined;
afterAll(() => native?.close());
const page = (id: string, sourceIndex = 0): PageModel => ({
  id, sourceIndex, widthPt: 300, heightPt: 200, rotation: 0,
});
const edit = (target: SourceImageAddress, patch: Partial<SourceImageEditOverlay> = {}): SourceImageEditOverlay =>
  ({ type: "sourceImageEdit", id: "image", pageId: "p", target, ...patch });
const run = (bytes: Uint8Array, overlays: Overlay[], pages = [page("p")]) =>
  exportPdf(bytes, { pages, overlays });

function paintFixture(pdf: PDFDocument, name: string, bytes: number[], entries = {}) {
  return pdf.context.register(pdf.context.flateStream(Uint8Array.from(bytes), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
    BitsPerComponent: 8, ColorSpace: name, ...entries,
  }));
}

function pixel(bytes: Uint8Array, x: number, y: number, index = 0) {
  const { width, height, pixels } = native!.inspectPage(bytes, index, true);
  const at = 4 * ((Math.round(height * 2) - 1 - y * 2) * Math.round(width * 2) + x * 2);
  return Array.from(pixels!.subarray(at, at + 3)).reverse();
}

function expectBounds(actual: PdfRect | undefined, expected: PdfRect) {
  for (const dimension of ["x", "y", "w", "h"] as const) {
    expect(actual?.[dimension]).toBeCloseTo(expected[dimension], 5);
  }
}

// Risks covered below: the wrong repeated call is changed; expansion exposes
// sibling artwork; source page indices drift; stream edits shift later targets;
// image bytes, masks or untouched inline data change; an unsafe edit mutates
// its page; a source image edit interferes with text verification.
test.skipIf(!native)("moves one nested shared paint outside both Form boxes without revealing neighboring paint", async () => {
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 200]);
  const second = doc.addPage([300, 200]);
  const red = paintFixture(doc, "DeviceRGB", [226, 16, 31]);
  const inner = doc.context.register(doc.context.flateStream(
    "0 0 1 rg 0 0 90 5 re f q 1 0 0 1 69 10 cm 13 0 0 8 0 0 cm /Red Do Q 0 0.5 0 rg 10 0 4 12 re f",
    { Type: "XObject", Subtype: "Form", BBox: [0, 0, 90, 40], Matrix: [1, 0, 0, 1, 0, 0], Resources: { XObject: { Red: red } } },
  ));
  const outer = doc.context.register(doc.context.flateStream(
    "0 1 0 rg -20 22 150 6 re f q /Inner Do Q 1 0 0 rg 65 34 35 4 re f",
    { Type: "XObject", Subtype: "Form", BBox: [0, 0, 74, 43], Resources: { XObject: { Inner: inner } } },
  ));
  for (const p of [first, second]) {
    p.node.set(key("Resources"), doc.context.obj({ XObject: { Outer: outer } }));
    const content = p === first
      ? "q 1 0 0 1 15 30 cm /Outer Do Q q 1 0 0 1 150 30 cm /Outer Do Q"
      : "q 1 0 0 1 15 30 cm /Outer Do Q";
    p.node.set(key("Contents"), doc.context.register(doc.context.flateStream(content)));
  }
  const input = await doc.save();
  const [target, sibling] = await listSourceImages(input, 0);
  const pages = [page("p"), page("q", 1)];
  const rect = { x: 130, y: 86, w: 27, h: 17 };
  const refused = await run(input, [edit(target!, { rect })], pages);
  expect(refused.sourceImageOutcomes?.[0]).toMatchObject({ mode: "unsupported", reason: "unsupported-context" });
  expect(refused.unexcisedEdits).toBe(1);
  expect(refused.bytes).toEqual(input);
  // Keep the source crop imposed by the outer Form when the image moves.
  const result = await run(input, [edit(target!, { rect, crop: { x: 0, y: 0, w: .375, h: 1 } })], pages);
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "image", mode: "applied" }]);
  const [changed, preserved] = await listSourceImages(result.bytes, 0);
  expectBounds(changed?.bbox, { x: 130, y: 86, w: 27, h: 17 });
  expect(changed?.fingerprint).toBe(target?.fingerprint);
  expect(preserved?.matrix).toEqual(sibling?.matrix);
  expect(native!.inspectPage(result.bytes, 1, true).pixels).toEqual(native!.inspectPage(input, 1, true).pixels);
  expect(pixel(result.bytes, 137, 95)).toEqual([226, 16, 31]);
  expect(pixel(result.bytes, 150, 95)).toEqual([255, 255, 255]);
  expect(pixel(result.bytes, 43, 32)).toEqual(pixel(input, 43, 32));
  expect(pixel(result.bytes, 94, 32)).toEqual([255, 255, 255]);
  expect(pixel(result.bytes, 94, 54)).toEqual([255, 255, 255]);
  expect(pixel(result.bytes, 94, 65)).toEqual([255, 255, 255]);
});

test("deletes one Form invocation while preserving the same Form used as an annotation appearance", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const samples = [226, 16, 31];
  const pic = paintFixture(doc, "DeviceRGB", samples);
  const form = doc.context.register(doc.context.flateStream("/Pic Do", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1], Resources: { XObject: { Pic: pic } },
  }));
  p.node.set(key("Resources"), doc.context.obj({ XObject: { F: form, Last: pic } }));
  p.node.set(key("Contents"), doc.context.register(doc.context.flateStream(
    "q 24 0 0 24 3 3 cm /F Do Q q 20 0 0 20 100 100 cm /Last Do Q",
  )));
  p.node.set(key("Annots"), doc.context.obj([doc.context.register(doc.context.obj({
    Type: "Annot", Subtype: "Stamp", Rect: [55, 55, 80, 80], AP: { N: form },
  }))]));
  const input = await doc.save();
  const [target, sibling] = await listSourceImages(input, 0);
  const result = await run(input, [edit(target!, { delete: true })]);
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "image", mode: "applied" }]);
  expect(await listSourceImages(result.bytes, 0)).toEqual([{ ...sibling!, occurrence: 0, shared: true }]);

  const output = await PDFDocument.load(result.bytes);
  const annots = output.getPage(0).node.lookup(key("Annots"), PDFArray);
  const normal = annots.lookup(0, PDFDict).lookup(key("AP"), PDFDict).lookup(key("N"), PDFRawStream);
  expect(new TextDecoder().decode(decodePDFRawStream(normal).decode())).toBe("/Pic Do");
  const survivingPic = normal.dict.lookup(key("Resources"), PDFDict).lookup(key("XObject"), PDFDict)
    .lookup(key("Pic"), PDFRawStream);
  expect(decodePDFRawStream(survivingPic).decode()).toEqual(Uint8Array.from(samples));
});

test("rewrites original inline addresses in one batch and preserves untouched inline bytes", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const raw = "BI /W 5 /H 1 /BPC 8 /CS /G ID A EI  EI";
  p.node.set(key("Contents"), doc.context.register(doc.context.flateStream(
    `q 14 0 0 9 5 5 cm ${raw} Q q 19 0 0 15 35 10 cm ${raw} Q q 12 0 0 8 70 10 cm ${raw} Q`,
  )));
  const input = await doc.save();
  const [first, second, third] = await listSourceImages(input, 0);
  expect(first?.kind).toBe("inline");
  const result = await run(input, [
    edit(first!, { delete: true }),
    edit(third!, { id: "last", angle: 90, crop: { x: 0.2, y: 0, w: 0.6, h: 1 } }),
    edit({ ...second!, fingerprint: "0".repeat(64) }, { id: "stale", delete: true }),
  ]);
  expect(result.sourceImageOutcomes).toEqual([
    { overlayId: "image", mode: "applied" }, { overlayId: "last", mode: "applied" },
    expect.objectContaining({ overlayId: "stale", mode: "unsupported", reason: "stale-source" }),
  ]);
  expect(result.unexcisedEdits).toBe(1);
  expect(result.acceptance.status).toBe("needs-review");
  const surviving = inspectSourceImages(await PDFDocument.load(result.bytes), 0).occurrences;
  expect(surviving).toHaveLength(2);
  expect(surviving[0]?.info.matrix).toEqual(second?.matrix);
  expectBounds(surviving[1]?.info.bbox, { x: 72, y: 8, w: 8, h: 12 });
  for (const { paint } of surviving) {
    expect(new TextDecoder().decode(paint.owner.bytes.subarray(paint.start, paint.end))).toBe(raw);
  }
});

test("replaces a private nested image and drops stale aliases only from the edited page copy", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  const p = doc.addPage([300, 200]);
  p.setCropBox(10, 20, 270, 170);
  const picture = paintFixture(doc, "DeviceRGB", [77, 103, 118], { Decode: [1, 0, 0, 1, 0, 1] });
  const form = doc.context.register(doc.context.flateStream("q 20 5 -3 15 30 40 cm /Pic Do Q", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 280, 180],
    Resources: { XObject: { Pic: picture, PicAlias: picture } },
  }));
  const vector = doc.context.register(doc.context.flateStream("0 0.5 0 rg 23 110 14 7 re f", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 280, 180],
    Resources: { XObject: { Unused: picture } },
  }));
  const unused = doc.context.register(doc.context.flateStream("/Unused Do", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 280, 180],
    Resources: { XObject: { Unused: picture } },
  }));
  p.node.set(key("Resources"), doc.context.obj({ XObject: { F: form, Alias: form, Old: picture, Vector: vector, Dormant: unused } }));
  p.node.set(key("Contents"), doc.context.register(doc.context.flateStream("/F Do /Vector Do")));
  const source = await doc.save();
  const [image] = await listSourceImages(source, 1);
  const pages = ["copy", "p"].map(id => ({ ...page(id, 1), originXPt: 10, originYPt: 20, widthPt: 270, heightPt: 170 }));
  const result = await run(source, [edit(image!, {
    rect: { x: 65, y: 50, w: 46, h: 40 },
    replace: { mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  })], [pages[0]!, page("other"), pages[1]!]);
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "image", mode: "applied" }]);
  expect((await listSourceImages(result.bytes, 0))[0]?.fingerprint).toBe(image?.fingerprint);
  const [changed] = await listSourceImages(result.bytes, 2);
  expectBounds(changed?.bbox, { x: 65, y: 50, w: 46, h: 40 });
  expect(changed?.masked).toBe(true);
  const output = await PDFDocument.load(result.bytes);
  const oldSamples = [77, 103, 118];
  const seen = new Set<unknown>();
  function samplesIn(root: PDFDict) {
    const pending = [root as unknown];
    const images: number[][] = [];
    while (pending.length) {
      const value = pending.pop();
      if (seen.has(value)) continue;
      seen.add(value);
      if (value instanceof PDFDict) {
        pending.push(...value.entries().filter(([k]) => k !== key("Parent")).map(([, v]) => output.context.lookup(v)));
      } else if (value instanceof PDFArray) {
        pending.push(...value.asArray().map(v => output.context.lookup(v)));
      } else if (value instanceof PDFRawStream) {
        if (value.dict.lookup(key("Subtype")) === key("Image")) images.push(Array.from(decodePDFRawStream(value).decode()));
        pending.push(value.dict);
      }
    }
    return images;
  }
  expect(samplesIn(output.getPage(2).node)).not.toContainEqual(oldSamples);
  seen.clear();
  expect(samplesIn(output.getPage(0).node)).toContainEqual(oldSamples);
  if (native) expect(pixel(result.bytes, 17, 93, 2)).toEqual(pixel(source, 17, 93, 1));
});

test("preserves a stencil and authored clipping, and leaves strict refusals unchanged", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const stencil = paintFixture(doc, "DeviceGray", [0x80], {
    Width: 8, BitsPerComponent: 1, ImageMask: true, Decode: [1, 0],
  });
  p.node.set(key("Resources"), doc.context.obj({ XObject: { S: stencil } }));
  p.node.set(key("Contents"), doc.context.register(doc.context.flateStream(
    "q 0 0 100 100 re W n 0 0 1 rg 40 0 0 20 21 13 cm /S Do Q",
  )));
  const source = await doc.save();
  const [image] = await listSourceImages(source, 0);
  const crop = await run(source, [edit(image!, { crop: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 } })]);
  expect(crop.sourceImageOutcomes).toEqual([{ overlayId: "image", mode: "applied" }]);
  expect((await listSourceImages(crop.bytes, 0))[0]?.fingerprint).toBe(image?.fingerprint);
  const restored = await run(source, [edit(image!, { crop: { x: 0, y: 0, w: 1, h: 1 } })]);
  if (native) expect(native.inspectPage(restored.bytes, 0, true).pixels).toEqual(native.inspectPage(source, 0, true).pixels);
  const refused = await exportPdf(source, { pages: [page("p")], overlays: [
    edit(image!, { crop: { x: -0.1, y: 0, w: 1, h: 1 } }),
    edit({ ...image!, formPath: ["Missing"] }, { id: "wrong", delete: true }),
  ] }, { acceptance: "strict" });
  expect(refused.sourceImageOutcomes).toEqual([
    expect.objectContaining({ overlayId: "image", mode: "unsupported", reason: "unsupported-context" }),
    expect.objectContaining({ overlayId: "wrong", mode: "unsupported", reason: "target-not-found" }),
  ]);
  expect(refused.acceptance.status).toBe("refused");
  expect(refused.unexcisedEdits).toBe(2);
  expect(refused.bytes).toEqual(source);
});

test("keeps in-place text verification and image addressing on the same page", async () => {
  const f = await fixture("BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET q 20 0 0 20 70 40 cm /Image Do Q");
  f.page.node.Resources()!.set(key("XObject"), f.doc.context.obj({ Image: paintFixture(f.doc, "DeviceRGB", [5, 88, 102]) }));
  const input = await f.doc.save();
  const [target] = await listSourceImages(input, 0);
  const result = await run(input, [textEdit({ text: "EDCBA" }), edit(target!, { delete: true })]);
  expect(result.contentTextOutcomes?.[0]?.mode).toBe("in-place");
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "image", mode: "applied" }]);
  expect(result.acceptance.status).toBe("accepted");
  expect(await listSourceImages(result.bytes, 0)).toEqual([]);
  if (native) expect(native.inspectPage(result.bytes).text.trim()).toBe("EDCBA");
});

test.skipIf(!native)("embeds a JPEG over an inline paint and reports invalid replacement data on an untouched page", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  p.node.set(key("Contents"), doc.context.register(doc.context.flateStream(
    "q 30 0 0 24 77 44 cm BI /W 1 /H 1 /BPC 8 /CS /G ID x EI Q",
  )));
  const input = await doc.save();
  const [target] = await listSourceImages(input, 0);
  // A generated 3 by 2 grayscale JPEG with all samples set to 77.
  const jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAMBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AGP/Z";
  const replace = { mimeType: "image/jpeg" as const, dataUrl: `data:image/jpeg;base64,${jpeg}` };
  const result = await run(input, [edit(target!, { replace })]);
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "image", mode: "applied" }]);
  const [changed] = await listSourceImages(result.bytes, 0);
  expect(changed).toMatchObject({ kind: "xobject", widthPx: 3, heightPx: 2, matrix: target?.matrix });
  expect(pixel(result.bytes, 85, 50)).toEqual([77, 77, 77]);
  const incomplete = atob(jpeg).slice(0, -2);
  const refused = await run(input, [edit(target!, { replace: { ...replace, dataUrl: `data:image/jpeg;base64,${btoa(incomplete)}` } })]);
  expect(refused.sourceImageOutcomes).toEqual([
    expect.objectContaining({ overlayId: "image", mode: "unsupported", reason: "unsupported-context" }),
  ]);
  expect(refused.bytes).toEqual(input);
});

test("refuses expansion of a tagged Form and preserves the original-only and permission paths", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const picture = paintFixture(doc, "DeviceRGB", [17, 182, 93]);
  const tagged = doc.context.register(doc.context.flateStream("/Span << /MCID 0 >> BDC /Pic Do EMC", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 25, 25], StructParents: 1, Resources: { XObject: { Pic: picture } },
  }));
  p.node.set(key("Resources"), doc.context.obj({ XObject: { Form: tagged } }));
  p.node.set(key("Contents"), doc.context.register(doc.context.flateStream("/Form Do")));
  const input = await doc.save();
  const [target] = await listSourceImages(input, 0);
  const overlays = [edit(target!, { rect: { x: 85, y: 74, w: 26, h: 18 } })];
  const refused = await run(input, overlays);
  expect(refused.sourceImageOutcomes).toEqual([
    expect.objectContaining({ overlayId: "image", mode: "unsupported", reason: "unsupported-context" }),
  ]);
  expect(refused.bytes).toEqual(input);
  const original = await exportPdf(input, { pages: [page("p")], overlays }, { mode: "none" });
  expect(original.sourceImageOutcomes).toEqual([]);
  expect(original.unexcisedEdits).toBe(0);
  expect(original.bytes).toEqual(input);
  const permissions = 1 << 5;
  const protectedResult = exportPdf(input, { pages: [page("p")], overlays }, {
    sourceEncryption: {
      security: { revision: 4, permissions, userPermissions: permissions },
      plaintext: async () => input,
      encrypt: async () => { throw Error("permissions must be checked before encrypting"); },
    },
  });
  await expect(protectedResult).rejects.toMatchObject({ name: "ExportPermissionError", denied: ["content"] });
});

test("keeps a replaced image's original object when another paint uses it as a soft mask", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  const mask = paintFixture(doc, "DeviceGray", [121]);
  const image = paintFixture(doc, "DeviceRGB", [228, 5, 19], { SMask: mask });
  p.node.set(key("Resources"), doc.context.obj({ XObject: { Gray: mask, Red: image } }));
  p.node.set(key("Contents"), doc.context.register(doc.context.flateStream(
    "q 20 0 0 20 30 30 cm /Gray Do Q q 20 0 0 20 60 30 cm /Red Do Q",
  )));
  const input = await doc.save();
  const [target, second] = await listSourceImages(input, 0);
  const result = await run(input, [edit(target!, {
    replace: { mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  })]);
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "image", mode: "applied" }]);
  expect((await listSourceImages(result.bytes, 0))[1]?.fingerprint).toBe(second?.fingerprint);
  if (native) expect(pixel(result.bytes, 64, 34)).toEqual(pixel(input, 64, 34));
});
