import { expect, test } from "bun:test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFObject, type PDFRef } from "pdf-lib";
import type { Overlay, PageModel } from "../model/types";
import { exportPdf } from "./exportPdf";
import { listSourceImages, type SourceImageAddress } from "./sourceImages";

const key = PDFName.of;
const page: PageModel = { id: "art", sourceIndex: 0, widthPt: 240, heightPt: 170, rotation: 0 };
const witness: PageModel = { ...page, id: "witness", sourceIndex: 1 };
const edit = (target: SourceImageAddress, id = "refused", pageId = page.id): Overlay =>
  ({ type: "sourceImageEdit", id, pageId, target, delete: true });
const inline = "q 8 0 0 7 5 3 cm BI /W 1 /H 1 /BPC 8 /CS /G ID G EI Q";

function artwork(doc: PDFDocument, values: number[]) {
  return doc.context.register(doc.context.flateStream(Uint8Array.from(values), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: "DeviceRGB",
  }));
}

function fixture() {
  return PDFDocument.create().then(doc => {
    const ctx = doc.context;
    const original = doc.addPage([page.widthPt, page.heightPt]);
    const twin = doc.addPage([page.widthPt, page.heightPt]);
    const contents = (body: string) => ctx.register(ctx.flateStream(body));
    const form = (body: string, objects: Record<string, PDFRef>, extra = {}) => ctx.register(ctx.flateStream(body, {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 55, 38], Resources: { XObject: objects }, ...extra,
    }));
    return { doc, ctx, original, twin, form, contents };
  });
}

function snapshot(input: Uint8Array) {
  return PDFDocument.load(input).then(doc => {
    const node = doc.getPage(0).node;
    const resolve = (object?: PDFObject): unknown => {
      const value = doc.context.lookup(object);
      if (value instanceof PDFRawStream) return [resolve(value.dict), Array.from(value.getContents())];
      if (value instanceof PDFArray) return value.asArray().map(resolve);
      if (value instanceof PDFDict) return Object.fromEntries(value.entries().map(([k, v]) => [k.decodeText(), resolve(v)]));
      return value?.toString();
    };
    return [resolve(node.get(key("Contents"))), resolve(node.Resources())];
  });
}

async function targets(input: Uint8Array) {
  return (await listSourceImages(input, witness.sourceIndex)).map(info => ({ ...info, pageIndex: page.sourceIndex }));
}

// Separate occurrence sequences are needed even when an adjacent ordinary
// paint has the same inner name. An idle resource has no paint evidence.
test.each([false, true])("refuses only matching tiling pattern addresses (with ordinary paint: %s)", async adjacent => {
  const { doc, ctx, original, twin, form, contents } = await fixture();
  const sample = artwork(doc, [229, 43, 83]);
  const ordinary = artwork(doc, [39, 108, 203]);
  const nested = form(`q 9 0 0 6 12 3 cm /Swatch Do Q ${inline}`, { Swatch: sample });
  const tiles = form("/Nested Do q 7 0 0 8 2 15 cm /Alias Do Q", { Nested: nested, Alias: sample });
  const tile = (alias: string) => ctx.register(ctx.flateStream(`/${alias} Do`, {
    Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 55, 38], XStep: 55, YStep: 38,
    Resources: { XObject: { [alias]: tiles } },
  }));
  original.node.set(key("Resources"), ctx.obj({
    XObject: { Swatch: ordinary }, Pattern: { Fill: tile("First"), Alternate: tile("Second"), Idle: tile("Idle") },
  }));
  const fill = (name: string, x: number) => `q /Pattern cs /${name} scn ${x} 12 50 38 re f Q`;
  original.node.set(key("Contents"), contents([
    adjacent ? "q 14 0 0 11 15 90 cm /Swatch Do Q" : "",
    "q /Pattern cs /Idle scn Q", fill("Fill", 8), fill("Alternate", 72), fill("Fill", 136), fill("Fill", 188),
  ].join("\n")));
  twin.node.set(key("Resources"), ctx.obj({ XObject: { First: tiles, Second: tiles, Idle: tiles } }));
  twin.node.set(key("Contents"), contents("/First Do /Second Do /First Do /First Do /Idle Do"));
  const input = await doc.save();
  const [normal] = await listSourceImages(input, 0);
  expect(normal?.name).toBe(adjacent ? "Swatch" : undefined);
  expect(await listSourceImages(input, 0)).toHaveLength(adjacent ? 1 : 0);
  const paints = await targets(input);
  expect(paints[0]?.formPath).toEqual(["First", "Nested"]);
  expect(paints[1]?.kind).toBe("inline");
  const cases = [
    ...paints.slice(0, 12).map(target => [target, "unsupported-context"] as const),
    [paints[12]!, "target-not-found"],
    [{ ...paints[0]!, fingerprint: "0".repeat(64) }, "target-not-found"],
    [{ ...paints[0]!, formPath: ["Nested", "First"] }, "target-not-found"],
    [{ ...paints[0]!, occurrence: 2 }, "target-not-found"],
    [{ ...paints[0]!, kind: "inline" as const }, "target-not-found"],
    [{ ...paints[0]!, name: "SwatchAlias" }, "target-not-found"],
    [{ ...paints[0]!, pageIndex: 1 }, "target-not-found"],
    ...(normal ? [[{ ...normal, fingerprint: "0".repeat(64) }, "stale-source"] as const] : []),
  ] as const;
  const refused = await exportPdf(input, {
    pages: [page, witness], overlays: cases.map(([target], i) => edit(target, String(i))),
  }, { acceptance: "strict" });
  expect(refused.sourceImageOutcomes).toMatchObject(cases.map(([, reason], i) => ({
    overlayId: String(i), mode: "unsupported", reason,
  })));
  expect(refused.unexcisedEdits).toBe(cases.length);
  expect(refused.acceptance).toMatchObject({
    status: "refused", findings: [{ kind: "unexcised-edit", count: cases.length }],
  });
  expect(refused.bytes).toEqual(input);

  // Force a real rebuild on a different page while the refusal still counts.
  const twinPaint = (await listSourceImages(input, 1))[0]!;
  const mixed = await exportPdf(input, {
    pages: [page, witness], overlays: [edit(paints[0]!), edit(twinPaint, "ordinary", witness.id)],
  });
  expect(mixed.sourceImageOutcomes).toMatchObject([
    { overlayId: "refused", mode: "unsupported", reason: "unsupported-context" },
    { overlayId: "ordinary", mode: "applied" },
  ]);
  expect(mixed.unexcisedEdits).toBe(1);
  expect(await snapshot(mixed.bytes)).toEqual(await snapshot(input));
  if (normal) {
    const applied = await exportPdf(input, { pages: [page, witness], overlays: [edit(normal)] });
    expect(applied.sourceImageOutcomes).toEqual([{ overlayId: "refused", mode: "applied" }]);
    expect(applied.acceptance.status).toBe("accepted");
    expect(await listSourceImages(applied.bytes, 0)).toEqual([]);
  }
});

test.each(["glyph", "annotation", "mask"] as const)("recognizes a painted %s program from the original source", async context => {
  const { doc, ctx, original, twin, form, contents } = await fixture();
  const sample = artwork(doc, [185, 64, 142]);
  const nested = form(`/Swatch Do ${inline}`, { Swatch: sample });
  const group = form("/Insert Do", { Insert: nested }, { Group: { S: "Transparency", CS: "DeviceRGB" } });
  const ordinary = artwork(doc, [40, 55, 85]);
  const objects = { Insert: nested, Nearby: ordinary };
  const glyph = (body: string) => contents(`1 0 d0 ${body}`);
  const invisible = form(`/Unpainted Do`, { Unpainted: sample });
  original.node.set(key("Contents"), contents("q 12 0 0 18 19 85 cm /Nearby Do Q"));
  if (context === "annotation") {
    original.node.set(key("Resources"), ctx.obj({ XObject: { Nearby: ordinary } }));
    original.node.set(key("Annots"), ctx.obj([
      { Type: "Annot", Subtype: "Highlight", Rect: [12, 15, 67, 53], QuadPoints: [12, 53, 67, 53, 12, 15, 67, 15],
        AP: { N: group, R: invisible } },
      { Type: "Annot", Subtype: "Stamp", F: 2, Rect: [72, 15, 127, 53], AP: { N: invisible } },
    ]));
  } else if (context === "mask") {
    original.node.set(key("Resources"), ctx.obj({ XObject: objects, ExtGState: {
      Alpha: { SMask: { S: "Alpha", G: group } },
      Idle: { SMask: { S: "Alpha", G: invisible } },
    } }));
    original.node.set(key("Contents"), contents(
      "q /Idle gs Q q /Alpha gs 10 12 47 33 re f Q q 12 0 0 18 19 85 cm /Nearby Do Q",
    ));
  } else {
    original.node.set(key("Resources"), ctx.obj({
      XObject: objects, Font: { Letter: {
        Type: "Font", Subtype: "Type3", FontMatrix: [.04, 0, 0, .04, 0, 0], FontBBox: [0, 0, 55, 38],
        FirstChar: 65, LastChar: 66, Widths: [1, 1], Resources: { XObject: { Insert: nested, Idle: invisible } },
        Encoding: { Differences: [65, "Visible", "Unused"] },
        CharProcs: { Visible: glyph("/Insert Do"), Unused: glyph("/Idle Do") },
      } },
    }));
    original.node.set(key("Contents"), contents(
      "BT /Letter 26 Tf 1 0 0 1 15 20 Tm (A) Tj 3 Tr (B) Tj ET q 12 0 0 18 19 85 cm /Nearby Do Q",
    ));
  }
  twin.node.set(key("Resources"), ctx.obj({ XObject: { ...objects, Unpainted: sample, Idle: invisible } }));
  twin.node.set(key("Contents"), contents("/Insert Do /Unpainted Do /Idle Do"));
  const input = await doc.save();
  expect((await listSourceImages(input, 0)).map(({ name }) => name)).toEqual(["Nearby"]);
  const paints = await targets(input);
  const baseline = await exportPdf(input, { pages: [page, witness], overlays: [] });
  if (context === "annotation") {
    const baselinePdf = await PDFDocument.load(baseline.bytes);
    expect(baselinePdf.getPage(0).node.Annots()?.size()).toBe(1);
  }
  const result = await exportPdf(input, {
    pages: [page, witness], overlays: paints.map((target, i) => edit(target, String(i))),
  });
  expect(result.sourceImageOutcomes).toMatchObject([
    { mode: "unsupported", reason: "unsupported-context" },
    { mode: "unsupported", reason: "unsupported-context" },
    { mode: "unsupported", reason: "target-not-found" },
    { mode: "unsupported", reason: "target-not-found" },
  ]);
  expect(result.unexcisedEdits).toBe(paints.length);
  expect(result.acceptance).toMatchObject({
    status: "needs-review", findings: [{ kind: "unexcised-edit", count: paints.length }],
  });
  expect(await snapshot(result.bytes)).toEqual(await snapshot(baseline.bytes));
  if (context === "annotation") {
    const preserved = await exportPdf(input, {
      pages: [page, witness], overlays: [edit(paints[0]!)],
    }, { preserveSourceAnnotations: true });
    expect(preserved.sourceImageOutcomes).toMatchObject([{ mode: "unsupported", reason: "unsupported-context" }]);
    expect(preserved.bytes).toEqual(input);
  }
});
