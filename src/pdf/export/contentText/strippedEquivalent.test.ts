import { expect, test } from "bun:test";
import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { inspectRunPage } from "../contentStreamEdit/replaceRunPage";
import { inventorySemantics } from '../semanticGate';
import { exportPdf } from "../exportPdf";
import { applyContentTextEdits } from "./apply";
import { bytes, fixture, model, overlay } from "./fixtures.test-support";

// Failures to catch: ignoring an enclosing property, assigning one edit's
// finding to a sibling, resolving a Form property from the wrong resources,
// and counting a one-glyph equivalent that is still emitted after the edit.
const finding = (overlayId: string) => ({ kind: "stripped-equivalent", overlayId, pageIndex: 0 });

function edit(id: string, originalText: string, text: string, x: number, y = 100) {
  const rect = { x: x - 0.1, y: y - 2, w: originalText.length * 6 + 0.2, h: 13 };
  return overlay({ id, originalText, text, rect, coverRects: [rect] });
}

test.each(["ActualText", "Alt", "E"])("review reports stripped %s and strict restores the source page", async key => {
  // A nested BMC must not hide its ancestor's inline property list.
  const { doc } = await fixture(`/Span <</${key} (Expanded label) /MCID 4>> BDC /Artifact BMC
    BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC EMC`);
  const source = await doc.save();
  const changes = model([edit("label", "ABCDE", "AXCDE", 50)]);
  const review = await exportPdf(source, changes, { acceptance: "review" });
  expect(review.contentTextOutcomes).toMatchObject([{ mode: "retypeset", strippedEquivalent: true }]);
  expect(review.acceptance).toMatchObject({ status: "needs-review", findings: [finding("label")] });
  expect(review.bytes).not.toEqual(source);
  expect(review.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: "label", action: "stripped", dependency: expect.objectContaining({ text: "Expanded label" }),
  }));

  const strict = await exportPdf(source, changes, { acceptance: "strict" });
  expect(strict.contentTextOutcomes).toMatchObject([{ mode: "unsupported", reason: "acceptance-strict" }]);
  expect(strict.acceptance).toMatchObject({ status: "refused" });
  expect(strict.acceptance.findings).toContainEqual(finding("label"));
  expect(strict.bytes).toEqual(source);
  expect(strict.semanticChanges?.some(row => row.action === "stripped") ?? false).toBe(false);
});

async function namedEquivalent(key: string, suffix = "") {
  const { doc, page } = await fixture(`/Span /Label BDC BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC ${suffix}`);
  page.node.Resources()!.set(PDFName.of("Properties"), doc.context.obj({
    Label: doc.context.register(doc.context.obj({ [key]: PDFString.of("Expanded label") })),
  }));
  return doc.save();
}

test.each([
  ["ActualText", "actual-text"], ["Alt", "alt"], ["E", "expansion"],
])("review strips named %s from the live span and strict restores the source", async (key, kind) => {
  const source = await namedEquivalent(key);
  const changes = model([edit("label", "ABCDE", "AXCDE", 50)]);
  const review = await exportPdf(source, changes);
  expect(review.contentTextOutcomes).toMatchObject([{ mode: "retypeset", strippedEquivalent: true }]);
  expect(review.acceptance).toMatchObject({ status: "needs-review", findings: [finding("label")] });
  expect(review.semanticChanges).toMatchObject([{
    overlayId: "label", action: "stripped", dependency: { source: "properties", kind, text: "Expanded label" },
  }]);
  expect(await inventorySemantics(review.bytes, 0)).toEqual([]);

  const strict = await exportPdf(source, changes, { acceptance: "strict" });
  expect(strict.contentTextOutcomes).toMatchObject([{ mode: "unsupported", reason: "acceptance-strict" }]);
  expect(strict.acceptance.status).toBe("refused");
  expect(strict.acceptance.findings).toContainEqual(finding("label"));
  expect(strict.bytes).toEqual(source);
});

test("stripping one use of a named equivalent keeps a shared dictionary live for its sibling", async () => {
  const source = await namedEquivalent("Alt", "/Span /Label BDC BT /F1 10 Tf 50 65 Td (FGHIJ) Tj ET EMC");
  const out = await exportPdf(source, model([edit("label", "ABCDE", "AXCDE", 50)]));
  expect(out.semanticChanges).toMatchObject([{ action: "stripped" }]);
  const remaining = await inventorySemantics(out.bytes, 0);
  expect(remaining).toMatchObject([{ text: "Expanded label" }]);
  expect(remaining[0]!.bbox!.y).toBeLessThan(80);
});

test("partially replacing a named equivalent keeps the source bytes", async () => {
  const source = await namedEquivalent("Alt");
  const out = await exportPdf(source, model([edit("label", "BC", "XX", 56)]));
  expect(out.contentTextOutcomes).toMatchObject([{ mode: "unsupported", reason: "semantic-dependency" }]);
  expect(out.semanticChanges).toMatchObject([{ action: "refused", reason: "semantic-replacement-text" }]);
  expect(out.bytes).toEqual(source);
});

test("a partial equivalent is refused while independent text in the same line still exports", async () => {
  const { doc } = await fixture(`BT /F1 10 Tf 50 100 Td
    /Span <</Alt (Semantic description)>> BDC (ABCDE) Tj EMC (--) Tj (FGHIJ) Tj ET`);
  const source = await doc.save();
  const marked = edit("marked", "BC", "XX", 56);
  const plain = edit("plain", "FGHIJ", "FGTIJ", 92);
  const unsupported = edit("unsupported", "MISSING", "REPLACE", 200);
  const changes = model([plain, unsupported, marked]);
  const review = await exportPdf(source, changes);
  expect(review.contentTextOutcomes?.map(o => [o.overlayId, o.mode])).toEqual([
    ["plain", "in-place"], ["unsupported", "unsupported"], ["marked", "unsupported"],
  ]);
  expect(review.semanticChanges).toMatchObject([{ overlayId: "marked", action: "refused", reason: "semantic-replacement-text" }]);
  const strict = await exportPdf(source, changes, { acceptance: "strict" });
  expect(strict.contentTextOutcomes?.map(o => [o.mode, o.reason])).toEqual([
    ["in-place", undefined], ["unsupported", review.contentTextOutcomes?.[1]?.reason], ["unsupported", "semantic-dependency"],
  ]);
  const plainOnly = await exportPdf(source, model([plain]));
  const content = async (data: Uint8Array) => inspectRunPage((await PDFDocument.load(data)).getPage(0));
  expect(await content(strict.bytes)).toEqual(await content(plainOnly.bytes));
});

test("an equivalent on an unselected portion of a rewritten line is outside the edit", async () => {
  const { page } = await fixture(`BT /F1 10 Tf 50 100 Td
    /Span <</E (Expansion)>> BDC (ABCDE) Tj EMC (--) Tj (FGHIJ) Tj ET`);
  const out = await applyContentTextEdits(page, [edit("plain", "FGHIJ", "LONG SENTENCE", 92)], { stage5Reflow: false });
  expect(out.outcomes[0]?.mode).toBe("retypeset");
  expect(out.outcomes[0]?.strippedEquivalent).toBeUndefined();
});

test("a sibling that leaves a selected marked line unchanged does not inherit the finding", async () => {
  const { page } = await fixture(`BT /F1 10 Tf 12 TL 50 112 Td (ABCDE) Tj T*
    /Span <</ActualText (Second line)>> BDC (FGHIJ--KLMNO) Tj EMC ET`);
  const first = overlay({
    id: "first-line",
    originalText: "ABCDE\nFGHIJ",
    text: "AXCDE\nFGHIJ",
    coverRects: [112, 100].map(y => ({ x: 49.9, y: y - 2, w: 30.2, h: 13 })),
  });
  const second = edit("second-line", "KLMNO", "KPMNO", 92);
  const out = await applyContentTextEdits(page, [first, second]);
  expect(out.outcomes.map(o => [o.mode, o.strippedEquivalent])).toEqual([
    ["retypeset", undefined], ["retypeset", true],
  ]);
});

test("a named equivalent in a nested Form refuses a change to just one shared invocation", async () => {
  const { doc, page } = await fixture("/Parent Do q 1 0 0 1 0 -60 cm /Parent Do Q");
  const resources = page.node.Resources()!;
  resources.set(PDFName.of("Properties"), doc.context.obj({ Label: { MCID: 1 } }));
  const properties = doc.context.obj({
    Label: doc.context.register(doc.context.obj({ E: PDFString.of("Expanded label"), MCID: 2 })),
  });
  const childResources = resources.clone();
  childResources.set(PDFName.of("Properties"), properties);
  const child = doc.context.register(doc.context.stream(
    bytes("/Span /Label BDC BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC"),
    { Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 200], Resources: childResources },
  ));
  const parent = doc.context.register(doc.context.stream(bytes("/Child Do"), {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 300, 200], Resources: { XObject: { Child: child } },
  }));
  resources.set(PDFName.of("XObject"), doc.context.obj({ Parent: parent }));
  const source = await doc.save();
  const changes = model([edit("form", "ABCDE", "AXCDE", 50)]);
  const review = await exportPdf(source, changes);
  expect(review.contentTextOutcomes).toMatchObject([{ mode: "unsupported", reason: "semantic-dependency" }]);
  expect(review.semanticChanges).toContainEqual(expect.objectContaining({
    overlayId: "form", action: "refused", reason: "semantic-replacement-text",
    dependency: expect.objectContaining({ source: "properties", kind: "expansion", stream: child.toString() }),
  }));
  const saved = (await PDFDocument.load(review.bytes)).getPage(0);
  const objects = saved.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  expect(objects.keys()).toEqual([PDFName.of("Parent")]);
  const strict = await exportPdf(source, changes, { acceptance: "strict" });
  expect(strict.semanticChanges).toEqual(review.semanticChanges);
});

test.each([
  { text: "+-+", label: "+", action: "updated" },
  { text: "?--", label: "?", action: "preserved" },
])("upright column keeps the cell's equivalent correct ($text)", async ({ text, label, action }) => {
  const { doc } = await fixture(`BT /F1 10 Tf
    1 0 0 1 50 150 Tm /Span <</ActualText (?)>> BDC (!) Tj EMC
    1 0 0 1 50 135 Tm (-) Tj 1 0 0 1 50 120 Tm (+) Tj ET`);
  const coverRects = [150, 135, 120].map(y => ({ x: 49, y: y - 3, w: 10, h: 13 }));
  const out = await exportPdf(await doc.save(), model([overlay({ originalText: "?-+", text, coverRects })]));
  expect(out.contentTextOutcomes).toMatchObject([{ mode: "retypeset" }]);
  expect(out.contentTextOutcomes?.[0]?.strippedEquivalent).toBeUndefined();
  expect(out.semanticChanges).toMatchObject([{ action, dependency: { kind: "actual-text", text: "?" } }]);
  expect((await inventorySemantics(out.bytes, 0)).map(d => d.text)).toEqual([label]);
});
