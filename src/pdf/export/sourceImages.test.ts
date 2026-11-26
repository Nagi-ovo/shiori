import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { degrees, PDFDocument, PDFHexString, PDFName, type PDFPage, type PDFRef } from "pdf-lib";
import { inspectSourceImages, listImmutableSourceImages, listSourceImages } from "./sourceImages";

const key = PDFName.of;
const utf8 = new TextDecoder();
const encode = (value: string) => new TextEncoder().encode(value);
const save = (pdf: PDFDocument) => pdf.save({ useObjectStreams: false });
const matrix = [1, 0, 0, 1, 0, 0];

function image(pdf: PDFDocument, samples = [192, 10, 50], dict = {}) {
  return pdf.context.register(pdf.context.stream(Uint8Array.from(samples), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
    ColorSpace: "DeviceRGB", BitsPerComponent: 8, ...dict,
  }));
}

function form(pdf: PDFDocument, body: string, entries = {}) {
  return pdf.context.register(pdf.context.flateStream(encode(body), {
    Type: "XObject", Subtype: "Form", BBox: [-100, -100, 100, 100], ...entries,
  }));
}

function contents(page: PDFPage, ...parts: Array<string | Uint8Array>) {
  const refs = parts.map(part => page.doc.context.register(
    page.doc.context.flateStream(typeof part === "string" ? encode(part) : part),
  ));
  page.node.set(key("Contents"), refs.length === 1 ? refs[0]! : page.doc.context.obj(refs));
  return refs;
}

function resources(page: PDFPage, objects: Record<string, PDFRef>) {
  page.node.set(key("Resources"), page.doc.context.obj({ XObject: objects }));
}

function inline(header: string, samples: Uint8Array, tail: string) {
  const before = encode(`BI ${header} ID `);
  const after = encode(` EI\n${tail}`);
  const bytes = new Uint8Array(before.length + samples.length + after.length);
  bytes.set(before);
  bytes.set(samples, before.length);
  bytes.set(after, before.length + samples.length);
  return bytes;
}

describe("source image discovery", () => {
  test("walks repeated nested Forms in paint order with scoped names and full transforms", async () => {
    const pdf = await PDFDocument.create();
    const other = pdf.addPage();
    const page = pdf.addPage();
    page.setMediaBox(-10, 20, 300, 240);
    page.setCropBox(-40, 50, 200, 100);
    page.setRotation(degrees(90));
    const picture = image(pdf, [192], { Width: 8, ColorSpace: "DeviceGray", BitsPerComponent: 1, ImageMask: true });
    const direct = image(pdf, [190, 10, 50], { Mask: [0, 0, 0, 0, 0, 0] });
    const inner = form(pdf, "4 0 0 2 1 2 cm /A#2341 Do", {
      Matrix: [1, 0, 1, 1, 2, 3],
      Resources: pdf.context.register(pdf.context.obj({ XObject: { "A#2341": picture } })),
    });
    const outer = form(pdf, "2 0 0 1 7 8 cm /Inner Do", {
      Matrix: [1, 0, 0, 1, 5, 6], Resources: { XObject: { Inner: inner } },
    });
    contents(other, "/Alias Do");
    resources(other, { Alias: direct });
    const inherited = pdf.context.obj({ XObject: { "Outer#2F1": outer, Pic: direct, "A#2341": direct } });
    page.node.delete(key("Resources"));
    page.node.Parent()!.set(key("Resources"), pdf.context.register(inherited));
    contents(page, "q 1 0 0 1 31 61 cm 0 2 -3", "0 4 5 cm /Outer#2f1", "Do Q /Pic Do /Outer#2F1 Do");

    const bytes = await save(pdf);
    const images = await listSourceImages(bytes, 1);
    const [first, second, third] = images;
    expect(images.map(info => [info.occurrence, info.name, info.formPath])).toEqual([
      [0, "A#41", ["Outer/1", "Inner"]], [1, "Pic", []], [2, "A#41", ["Outer/1", "Inner"]],
    ]);
    expect(first).toMatchObject({
      pageIndex: 1, matrix: [0, 16, -6, 8, -22, 110], bbox: { x: -18, y: 60, w: 6, h: 24 },
      widthPx: 8, heightPx: 1, masked: true, shared: true,
    });
    expect(second).toMatchObject({ matrix, masked: true, shared: true });
    expect(third?.fingerprint).toBe(first?.fingerprint);
    expect(second?.fingerprint).toBe((await listSourceImages(bytes, 0))[0]?.fingerprint);

    const loaded = await PDFDocument.load(bytes);
    const inspection = inspectSourceImages(loaded, 1);
    expect(inspection.unsafe).toBeUndefined();
    const location = inspection.occurrences[0]!;
    const [outerCall, innerCall] = location.forms;
    expect(outerCall?.matrix).toEqual([0, 2, -3, 0, 35, 66]);
    expect(innerCall?.formToPage).toEqual([0, 4, -3, 4, -16, 98]);
    expect(outerCall?.parts.map(({ part, start, end }) => utf8.decode(part.bytes.subarray(start, end)))).toEqual([
      "/Outer#2f1", "Do",
    ]);
    expect(outerCall?.binding.owner).toBe(loaded.getPage(1).node.Parent());
    expect(innerCall?.binding.owner).toBe(outerCall?.binding.object.dict);
    const { owner, start, end, localMatrix } = location.paint;
    expect(utf8.decode(owner.bytes.subarray(start, end))).toBe("/A#2341 Do");
    expect(localMatrix).toEqual([4, 0, 0, 2, 1, 2]);
  });

  test("preserves packed inline rows containing a complete false EI and image operator", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const raw = encode(" EI /Fake Do  ");
    contents(page, "q 3 0 0 4 10 20 cm", inline("/W 49 /H 2 /BPC 1 /CS /GrayAlias", raw, "Q /Fake Do"));
    page.node.set(key("Resources"), pdf.context.obj({
      XObject: { Fake: image(pdf) }, ColorSpace: { GrayAlias: ["Indexed", "DeviceGray", 1, PDFHexString.of("00ff")] },
    }));
    const bytes = await save(pdf);
    const [first, second] = await listSourceImages(bytes, 0);
    expect(first).toMatchObject({
      occurrence: 0, kind: "inline", widthPx: 49, heightPx: 2, matrix: [3, 0, 0, 4, 10, 20],
      masked: false, shared: false,
    });
    expect(first?.name).toBeUndefined();
    expect(second).toMatchObject({ occurrence: 1, name: "Fake", matrix, shared: false });
    const { paint } = inspectSourceImages(await PDFDocument.load(bytes), 0).occurrences[0]!;
    if (paint.kind !== "inline") throw Error("expected inline paint");
    expect(paint.owner.bytes.subarray(paint.data.dataStart, paint.data.dataEnd)).toEqual(raw);
  });

  test("reads compressed inline data by the outer filter boundary", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    resources(page, { Pic: image(pdf) });
    const raw = encode(" EI /Pic Do ");
    const stored = deflateSync(raw, { level: 0 });
    const long = encode("JPEG ABCDEFGH 12345678 EI /Pic Do ".repeat(1000));
    const compressed = deflateSync(long);
    const runLength = new Uint8Array([raw.length - 1, ...raw, 128]);
    const lzwBits = [256, 65, 66, 258, 260, 257].map(code => code.toString(2).padStart(9, "0")).join("") + "00";
    const lzw = Uint8Array.from(lzwBits.match(/.{8}/g)!, bits => parseInt(bits, 2));
    contents(page,
      inline(`/W ${raw.length} /H 1 /BPC 8 /CS /G /F /Fl`, stored, ""),
      inline(`/W ${long.length} /H 1 /BPC 8 /CS /G /F [/FlateDecode]`, compressed, ""),
      inline(`/W ${raw.length} /H 1 /BPC 8 /CS /G /F /RL`, runLength, "/Pic Do"),
      inline("/W 7 /H 1 /BPC 8 /CS /G /F /LZW /DP << /EarlyChange 0 >>", lzw, "/Pic Do"),
    );
    const bytes = await save(pdf);
    const paints = await listSourceImages(bytes, 0);
    expect(paints.map(info => info.kind)).toEqual(["inline", "inline", "inline", "xobject", "inline", "xobject"]);
    expect(paints[3]?.shared).toBe(true);
    expect(paints[0]?.fingerprint).not.toBe(paints[1]?.fingerprint);
  });

  test("shares repeated Forms containing inline images without grouping separate equal images", async () => {
    const pdf = await PDFDocument.create();
    const first = pdf.addPage();
    const second = pdf.addPage();
    const inlineForm = form(pdf, "BI /W 1 /H 1 /IM true ID Z EI");
    resources(first, { F: inlineForm, I: image(pdf), Other: image(pdf), Changed: image(pdf, [192, 10, 50], { Decode: [1, 0, 0, 1, 0, 1] }) });
    resources(second, { Again: inlineForm });
    contents(first, "/F Do /I Do /Other Do /Changed Do");
    contents(second, "/Again Do");
    const bytes = await save(pdf);
    const images = await listSourceImages(bytes, 0);
    expect(images.map(info => info.shared)).toEqual([true, false, false, false]);
    expect(images[0]).toMatchObject({ kind: "inline", masked: true });
    expect(images[0]?.fingerprint).toBe((await listSourceImages(bytes, 1))[0]?.fingerprint);
    expect(images[1]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(images[1]?.fingerprint).toBe(images[2]?.fingerprint);
    expect(images[1]?.fingerprint).not.toBe(images[3]?.fingerprint);
    expect(await listSourceImages(new Uint8Array(bytes), 0)).toEqual(images);
  });

  test("uses the containing resources for resource-less Forms and the page fallback for absent resource groups", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const shared = image(pdf);
    const inner = form(pdf, "/Pic Do");
    const outer = form(pdf, "/Inner Do", { Resources: { XObject: { Inner: inner, Pic: shared } } });
    const fallback = form(pdf, "/Pic Do", { Resources: {} });
    resources(page, { Outer: outer, Fallback: fallback, Pic: image(pdf, [22, 3, 4]) });
    contents(page, "/Outer Do /Fallback Do /Pic Do");
    const paints = await listSourceImages(await save(pdf), 0);
    expect(paints.map(info => info.formPath)).toEqual([["Outer", "Inner"], ["Fallback"], []]);
    expect(paints.map(info => info.shared)).toEqual([false, true, true]);
  });

  test("counts a painted Form in a tiling pattern without exposing the pattern paint as an address", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const page = pdf.addPage();
    const picture = image(pdf);
    const onlyDirect = image(pdf, [7, 8, 9]);
    const shared = form(pdf, "/Pic Do", { Resources: { XObject: { Pic: picture } } });
    const pattern = (namedForm: PDFRef) => pdf.context.register(pdf.context.flateStream("/F Do", {
      Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1,
      BBox: [0, 0, 1, 1], XStep: 1, YStep: 1, Resources: { XObject: { F: namedForm } },
    }));
    const unused = form(pdf, "/Pic Do", { Resources: { XObject: { Pic: onlyDirect } } });
    page.node.set(key("Resources"), pdf.context.obj({
      XObject: { F: shared, Direct: onlyDirect },
      Pattern: { P: pattern(shared), Unused: pattern(unused) },
    }));
    contents(page, "q /Pattern cs /P scn 1 2 3 4 re f Q /F Do /Direct Do");
    const pdfBytes = await save(pdf);
    const doc = await PDFDocument.load(pdfBytes);
    expect(inspectSourceImages(doc, 1).sharingComplete).toBe(true);
    const paints = await listSourceImages(pdfBytes, 1);
    expect(paints.map(info => [info.name, info.shared])).toEqual([["Pic", true], ["Direct", false]]);
    expect(await listSourceImages(pdfBytes, 0)).toEqual([]);
  });

  test("counts direct annotation appearances on another page and keeps ordinary paint indices", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const annotationPage = pdf.addPage();
    const pic = form(pdf, "/Pic Do", { BBox: [0, 0, 1, 1], Resources: { XObject: { Pic: image(pdf) } } });
    const inlineForm = form(pdf, "BI /W 1 /H 1 /BPC 8 /CS /G ID Z EI", { BBox: [0, 0, 1, 1] });
    resources(page, { F: pic, I: inlineForm, Last: image(pdf) });
    contents(page, "q 24 0 0 24 3 3 cm /F Do Q /I Do /Last Do");
    annotationPage.node.set(key("Annots"), pdf.context.obj([pic, inlineForm].map((stream, index) => ({
      Type: "Annot", Subtype: "Stamp", Rect: [55, 55 + 25 * index, 80, 80 + 25 * index], AP: { N: stream },
    }))));
    const bytes = await save(pdf);

    for (const list of [listSourceImages, listImmutableSourceImages]) {
      expect(await list(bytes, 1)).toEqual([]);
      expect((await list(bytes, 0)).map(info =>
        [info.pageIndex, info.occurrence, info.kind, info.formPath, info.shared],
      )).toEqual([
        [0, 0, "xobject", ["F"], true], [0, 1, "inline", ["I"], true], [0, 2, "xobject", [], false],
      ]);
    }
  });

  test("counts only the visible normal appearance state", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const images = { Active: image(pdf), Off: image(pdf), Over: image(pdf), Hidden: image(pdf) };
    const appearance = (name: keyof typeof images) => form(pdf, `/${name} Do`, {
      BBox: [0, 0, 1, 1], Resources: { XObject: { [name]: images[name] } },
    });
    resources(page, images);
    contents(page, "/Off Do /Active Do /Over Do /Hidden Do");
    page.node.set(key("Annots"), pdf.context.obj([
      { Type: "Annot", Subtype: "Stamp", Rect: [20, 20, 40, 40], AS: "On",
        AP: { N: { On: appearance("Active"), Off: appearance("Off") }, R: appearance("Over") } },
      { Type: "Annot", Subtype: "Stamp", Rect: [50, 50, 70, 70], F: 2, AP: { N: appearance("Hidden") } },
    ]));
    const paints = await listSourceImages(await save(pdf), 0);
    expect(paints.map(info => [info.name, info.shared])).toEqual([
      ["Off", false], ["Active", true], ["Over", false], ["Hidden", false],
    ]);
  });

  test("resolves Type 3 character codes at text show operations", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const images = { Used: image(pdf), Unused: image(pdf), Unshown: image(pdf), Unselected: image(pdf) };
    const glyph = (name: keyof typeof images) => pdf.context.register(pdf.context.flateStream(`1 0 d0 /${name} Do`));
    const font = (charProcs: Record<string, PDFRef>, differences: Array<string | number>) => pdf.context.obj({
      Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1, 1], FontMatrix: matrix,
      FirstChar: 65, LastChar: 66, Widths: [1, 1], Resources: { XObject: images },
      Encoding: { Differences: differences }, CharProcs: charProcs,
    });
    page.node.set(key("Resources"), pdf.context.obj({
      XObject: images,
      Font: {
        T: font({ one: glyph("Used"), two: glyph("Unused") }, [65, "one", "two"]),
        Miss: font({ one: glyph("Unshown") }, [65, "one"]),
        Idle: font({ one: glyph("Unselected") }, [65, "one"]),
      },
    }));
    contents(page, "BT /T 12 Tf /Miss 12 Tf /T 12 Tf 1 0 0 1 5 5 Tm [<41> -10 (A)] TJ ET /Used Do /Unused Do /Unshown Do /Unselected Do");

    const paints = await listSourceImages(await save(pdf), 0);
    expect(paints.map(info => [info.occurrence, info.name, info.shared])).toEqual([
      [0, "Used", true], [1, "Unused", false], [2, "Unshown", false], [3, "Unselected", false],
    ]);
  });

  test("counts images and enclosing Forms from a soft-mask group when a mark uses it", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const used = image(pdf);
    const unused = image(pdf);
    const group = (body: string, objects: Record<string, PDFRef> = {}) => form(pdf, body, {
      BBox: [0, 0, 1, 1], Group: { S: "Transparency", CS: "DeviceRGB" }, Resources: { XObject: objects },
    });
    const inlineGroup = group("BI /W 1 /H 1 /BPC 8 /CS /G ID Z EI");
    const usedGroup = group("/Used Do", { Used: used });
    const unusedGroup = group("/Unused Do", { Unused: unused });
    page.node.set(key("Resources"), pdf.context.obj({
      XObject: { G: inlineGroup, Used: used, Unused: unused },
      ExtGState: {
        InlineMask: { SMask: { S: "Luminosity", G: inlineGroup } },
        ImageMask: { SMask: { S: "Luminosity", G: usedGroup } },
        Idle: { SMask: { S: "Luminosity", G: unusedGroup } },
        Clear: { SMask: "None" },
      },
    }));
    contents(page,
      "q /Idle gs /Clear gs 0 0 1 1 re f Q",
      "q /InlineMask gs 0 0 1 1 re f Q q /ImageMask gs 1 1 1 1 re f Q /G Do /Used Do /Unused Do",
    );

    const paints = await listSourceImages(await save(pdf), 0);
    expect(paints.map(info => [info.occurrence, info.name, info.formPath, info.shared])).toEqual([
      [0, undefined, ["G"], true], [1, "Used", [], true], [2, "Unused", [], false],
    ]);
  });

  test("fingerprints the raw samples and indirect mask but stays stable through a page copy", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const mask = (sample: number) => image(pdf, [sample], { ColorSpace: "DeviceGray" });
    resources(page, {
      A: image(pdf, [1, 2, 3], { SMask: mask(100) }),
      B: image(pdf, [1, 2, 4], { SMask: mask(100) }),
      C: image(pdf, [1, 2, 3], { SMask: mask(101) }),
    });
    contents(page, "/A Do /B Do /C Do");
    const source = await listSourceImages(await save(pdf), 0);
    expect(new Set(source.map(info => info.fingerprint)).size).toBe(3);
    expect(source.every(info => info.masked)).toBe(true);
    const copy = await PDFDocument.create();
    copy.addPage((await copy.copyPages(pdf, [0]))[0]!);
    expect((await listSourceImages(await save(copy), 0)).map(info => info.fingerprint))
      .toEqual(source.map(info => info.fingerprint));
  });

  test("reports unsafe pages without reusing an occurrence index from an opaque Form or inline image", async () => {
    const pdf = await PDFDocument.create();
    const picture = image(pdf);
    const cyclic = form(pdf, "/Self Do");
    const broken = form(pdf, "BI /W 1 /H 1 /F /Unknown ID x EI /Pic Do");
    const valid = pdf.addPage();
    resources(valid, { Pic: picture });
    contents(valid, "/Pic Do");
    const unsafePaints = [
      "/Opaque Do /Pic Do", "/Broken Do /Pic Do", "Q /Pic Do",
      "1.2.3 0 0 1 0 0 cm /Pic Do", "1 2 m /Pic Do 3 4 l S",
    ];
    for (const body of unsafePaints) {
      const page = pdf.addPage();
      resources(page, { Opaque: cyclic, Self: cyclic, Broken: broken, Pic: picture });
      contents(page, body);
    }
    const bytes = await save(pdf);
    const loaded = await PDFDocument.load(bytes);
    for (let i = 1; i <= unsafePaints.length; i += 1) {
      expect(inspectSourceImages(loaded, i).unsafe).toBeTruthy();
      expect(await listSourceImages(bytes, i)).toEqual([]);
    }
    expect(inspectSourceImages(loaded, 0).sharingComplete).toBe(false);
    expect((await listSourceImages(bytes, 0)).map(info => info.name)).toEqual(["Pic"]);
    expect(await listSourceImages(bytes, -1)).toEqual([]);
  });
});
