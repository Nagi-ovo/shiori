import { expect, test } from "bun:test";
import { degrees, PDFDocument, PDFName } from "pdf-lib";
import { renderFixtureRegion } from "../../../scripts/pdf-inplace/fixtureRaster.test-support";
import type { ContentTextOverlay } from "../model/types";
import { inspectRunPage } from "./contentStreamEdit/replaceRunPage";
import { bytes, fixture, model, overlay } from "./contentText/fixtures.test-support";
import { exportPdf } from "./exportPdf";
import type { ExportSourceEncryption } from "./encryptedSource";

// Exercise the writer and raster assessment together. A report without a
// region, a policy that drops siblings, or a rollback that leaks candidate
// resources or pixels would each leave an observable difference here.
const rasterTest = test.skipIf(!Bun.which("pdftoppm"));
const renderOptions = { renderContentText: renderFixtureRegion };
const collisionRegion = { x: 50.75, y: 104.5, w: 1, h: 1 };
const mark = "1 0 0 rg 50.75 104.5 1 1 re f 0 g";

function withoutWriteTime(bytes: Uint8Array) {
  // Exports can straddle a clock tick while the renderer is running.
  return Buffer.from(bytes).toString("latin1").replace(/\/ModDate \(D:\d{14}Z\)/g, "/ModDate (D:20000101000000Z)");
}

function edit(originalText: string, replacement: string, x: number, patch: Partial<ContentTextOverlay> = {}) {
  const rect = { x: x - 0.1, y: 98, w: originalText.length * 6 + 0.2, h: 13 };
  return overlay({ originalText, text: replacement, rect, coverRects: [rect], ...patch });
}

rasterTest("review measures contact without changing bytes and strict restores a singly edited page", async () => {
  const { doc } = await fixture(`${mark} BT /F1 10 Tf 50 100 Td (I) Tj ET`);
  const source = await doc.save();
  const edited = model([edit("I", "X", 50)]);
  const collision = { kind: "new-collision", overlayId: "edit", pageIndex: 0, region: collisionRegion };
  const review = await exportPdf(source, edited, renderOptions);
  expect(review.acceptance).toMatchObject({ status: "needs-review", findings: [collision] });
  expect(withoutWriteTime(review.bytes)).toBe(withoutWriteTime((await exportPdf(source, edited)).bytes));
  expect(review.bytes).not.toEqual(source);

  const strict = await exportPdf(source, edited, { ...renderOptions, acceptance: "strict" });
  expect(strict.acceptance.status).toBe("refused");
  expect(strict.acceptance.findings).toContainEqual(collision);
  expect(strict.contentTextOutcomes).toMatchObject([{
    overlayId: "edit", pageIndex: 0, mode: "unsupported", reason: "acceptance-strict",
    contact: { kind: "new-collision", region: collisionRegion },
  }]);
  // No other changes are requested, so rollback can preserve the entire PDF.
  expect(strict.bytes).toEqual(source);
  const tile = { x: 0, y: 0, width: 300, height: 200 };
  expect(await renderFixtureRegion(strict.bytes, 0, tile, 1)).toEqual(await renderFixtureRegion(source, 0, tile, 1));
});

rasterTest("strict keeps neutral downstream and other-page edits with reordered, cropped and rotated pages", async () => {
  const { doc, page } = await fixture("BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET");
  const second = doc.addPage([380, 260]);
  second.setCropBox(25, 10, 300, 200);
  second.setRotation(degrees(90));
  second.node.set(PDFName.of("Resources"), page.node.Resources()!);
  second.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(bytes(
    `q 1 0 0 1 25 10 cm ${mark} BT /F1 10 Tf 50 100 Td (I) Tj 140 0 Td (SECOND) Tj ET Q`,
  ))));
  const source = await doc.save();
  const originalPage = model([]).pages[0]!;
  const overlays = [
    overlay({ id: "other-page" }),
    edit("I", "X", 50, { id: "collision", pageId: "second" }),
    edit("SECOND", "GECOND", 190, { id: "downstream", pageId: "second" }),
    edit("WRONG", "ABC", 250, { id: "ordinary", pageId: "second" }),
  ];
  const edited = {
    pages: [{ ...originalPage, id: "second", sourceIndex: 1, rotation: 270 as const, originXPt: 25, originYPt: 10 }, originalPage],
    overlays,
  };
  const review = await exportPdf(source, edited, renderOptions);
  const strict = await exportPdf(source, edited, { ...renderOptions, acceptance: "strict" });
  const ordinary = review.contentTextOutcomes?.find(outcome => outcome.overlayId === "ordinary");
  expect(ordinary).toMatchObject({ mode: "unsupported" });
  expect(strict.contentTextOutcomes).toMatchObject([
    { overlayId: "collision", pageIndex: 0, mode: "unsupported", reason: "acceptance-strict" },
    { overlayId: "downstream", pageIndex: 0, mode: "in-place", contact: { kind: "clear" } },
    ordinary!,
    { overlayId: "other-page", pageIndex: 1, mode: "in-place", contact: { kind: "clear" } },
  ]);
  expect(strict.acceptance.findings).toContainEqual({
    kind: "new-collision", pageIndex: 0, overlayId: "collision", region: collisionRegion,
  });
  const surviving = await exportPdf(source, { ...edited, overlays: [overlays[0]!, overlays[2]!] });
  expect(withoutWriteTime(strict.bytes)).toBe(withoutWriteTime(surviving.bytes));
  const out = await PDFDocument.load(strict.bytes);
  expect(out.getPage(0).getRotation().angle).toBe(270);
  expect(out.getPage(0).getCropBox()).toEqual({ x: 25, y: 10, width: 300, height: 200 });
});

rasterTest("strict installs a measured edit that leaves pre-existing contact in place", async () => {
  const { doc } = await fixture("1 0 0 rg 52.5 102.5 1 1 re f 0 g BT /F1 10 Tf 50 100 Td (IX) Tj ET");
  const source = await doc.save();
  const edited = model([edit("IX", "IY", 50)]);
  const strict = await exportPdf(source, edited, { ...renderOptions, acceptance: "strict" });
  expect(strict.acceptance).toMatchObject({
    status: "accepted", findings: [], notes: [{ kind: "pre-existing-contact", overlayId: "edit" }],
  });
  expect(strict.contentTextOutcomes).toMatchObject([{ mode: "in-place", contact: { kind: "pre-existing-contact" } }]);
  expect(inspectRunPage((await PDFDocument.load(strict.bytes)).getPage(0))).not.toEqual(
    inspectRunPage((await PDFDocument.load(source)).getPage(0)),
  );
});

rasterTest("export measures contact when a size change keeps the same text", async () => {
  const { doc } = await fixture("1 0 0 rg 53 106.4 1 1 re f 0 g BT /F1 10 Tf 50 100 Td (I) Tj ET");
  const source = await doc.save();
  const edited = model([{ ...edit("I", "I", 50), fontSize: 12 }]);
  const review = await exportPdf(source, edited, renderOptions);
  expect(review.acceptance.findings).toContainEqual({
    kind: "new-collision", overlayId: "edit", pageIndex: 0, region: { x: 53, y: 106.5, w: 1, h: 0.25 },
  });
});

test("an encrypted strict export keeps the source ciphertext and analytic refusal evidence", async () => {
  const { doc } = await fixture(
    "BT /F1 10 Tf 12 TL 60 190 Td (RUNNING HEAD) Tj ET 0.4 w 30 184 m 270 184 l S " +
    "BT /F1 10 Tf 60 150 Td (BODY TEXT) Tj ET",
  );
  const plain = await doc.save();
  const ciphertext = Uint8Array.of(1, 2, 3);
  const sourceEncryption: ExportSourceEncryption = {
    security: null,
    plaintext: async () => plain,
    encrypt: async () => { throw Error("Unexpected encryption of unchanged PDF"); },
  };
  const rect = { x: 59, y: 187, w: 74, h: 12 };
  const overlayModel = model([overlay({ originalText: "RUNNING HEAD", text: "RUNNING HEAD XYZ", rect, coverRects: [rect] })]);
  const strict = await exportPdf(ciphertext, overlayModel, { sourceEncryption, acceptance: "strict" });

  expect(strict.bytes).toEqual(ciphertext);
  expect(strict.unexcisedEdits).toBe(1);
  expect(strict.contentTextOutcomes).toMatchObject([{ mode: "unsupported", reason: "acceptance-strict" }]);
  expect(strict.acceptance.status).toBe("refused");
  expect(strict.acceptance.findings).toContainEqual({ kind: "overflow-envelope", overlayId: "edit", pageIndex: 0 });
});
