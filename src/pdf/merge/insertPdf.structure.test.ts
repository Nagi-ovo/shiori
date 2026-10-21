import { describe, expect, test } from "bun:test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream } from "pdf-lib";
import { insertPdfPages } from "./insertPdf";

describe("insertPdfPages with tagged PDFs", () => {
  test("inserted pages do not claim entries in the base structure tree", async () => {
    const base = await PDFDocument.create();
    const basePage = base.addPage([300, 300]);
    basePage.node.set(PDFName.of("StructParents"), PDFNumber.of(0));
    const paragraph = base.context.register(base.context.obj({ Type: "StructElem", S: "P", Pg: basePage.ref, K: 0 }));
    base.catalog.set(PDFName.of("StructTreeRoot"), base.context.obj({
      Type: "StructTreeRoot",
      K: [paragraph],
      ParentTree: { Nums: [0, [paragraph]] },
      ParentTreeNextKey: 1,
    }));
    base.catalog.set(PDFName.of("MarkInfo"), base.context.obj({ Marked: true }));

    const incoming = await PDFDocument.create();
    const incomingPage = incoming.addPage([200, 200]);
    incomingPage.node.set(PDFName.of("StructParents"), PDFNumber.of(0));
    const note = incoming.context.obj({ Type: "Annot", Subtype: "Square", Rect: [10, 10, 50, 50], StructParent: 1 });
    incomingPage.node.set(PDFName.of("Annots"), incoming.context.obj([incoming.context.register(note)]));

    const result = await insertPdfPages(await base.save(), await incoming.save(), 1);
    const loaded = await PDFDocument.load(result.bytes);
    const inserted = loaded.getPage(1).node;
    const annots = inserted.lookup(PDFName.of("Annots"), PDFArray);
    const insertedNote = annots.lookup(0, PDFDict);

    expect(inserted.get(PDFName.of("StructParents"))).toBeUndefined();
    expect(insertedNote.get(PDFName.of("Subtype"))).toEqual(PDFName.of("Square"));
    expect(insertedNote.get(PDFName.of("StructParent"))).toBeUndefined();
    expect(loaded.getPage(0).node.lookup(PDFName.of("StructParents"), PDFNumber).asNumber()).toBe(0);
  });

  test("tagged form and image XObjects on inserted pages drop their structure keys too", async () => {
    const base = await PDFDocument.create();
    const basePage = base.addPage([300, 300]);
    basePage.node.set(PDFName.of("StructParents"), PDFNumber.of(0));
    const paragraph = base.context.register(base.context.obj({ Type: "StructElem", S: "P", Pg: basePage.ref, K: 0 }));
    base.catalog.set(PDFName.of("StructTreeRoot"), base.context.obj({
      Type: "StructTreeRoot",
      K: [paragraph],
      ParentTree: { Nums: [0, [paragraph], 1, paragraph] },
      ParentTreeNextKey: 2,
    }));

    const incoming = await PDFDocument.create();
    const page = incoming.addPage([200, 200]);
    const form = (extra: Record<string, unknown>) => incoming.context.register(incoming.context.stream(
      "/P <</MCID 0>> BDC EMC",
      { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], ...extra },
    ));
    const nested = form({ StructParents: 0 });
    const outer = form({ StructParents: 0, Resources: { XObject: { Inner: nested } } });
    // A form that draws itself must not hang the walk.
    const looped = form({ StructParent: 1 });
    // A tagged image is a structural content item with its own key.
    const image = incoming.context.register(incoming.context.stream(new Uint8Array([0, 0, 0]), {
      Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
      ColorSpace: "DeviceRGB", BitsPerComponent: 8, StructParent: 1,
    }));
    incoming.context.lookup(nested, PDFStream).dict.set(
      PDFName.of("Resources"),
      incoming.context.obj({ XObject: { Img: image } }),
    );
    incoming.context.lookup(looped, PDFStream).dict.set(
      PDFName.of("Resources"),
      incoming.context.obj({ XObject: { Self: looped } }),
    );
    page.node.set(PDFName.of("Resources"), incoming.context.obj({ XObject: { Outer: outer, Loop: looped, Img: image } }));
    const appearance = form({ StructParent: 1 });
    const note = incoming.context.obj({
      Type: "Annot", Subtype: "Square", Rect: [10, 10, 50, 50],
      AP: { N: appearance, D: { On: form({ StructParents: 0 }) } },
    });
    page.node.set(PDFName.of("Annots"), incoming.context.obj([incoming.context.register(note)]));

    const result = await insertPdfPages(await base.save(), await incoming.save(), 1);
    const loaded = await PDFDocument.load(result.bytes);
    const inserted = loaded.getPage(1).node;
    const xobjects = inserted.lookup(PDFName.of("Resources"), PDFDict).lookup(PDFName.of("XObject"), PDFDict);
    const outerCopy = xobjects.lookup(PDFName.of("Outer"), PDFStream).dict;
    const innerCopy = outerCopy.lookup(PDFName.of("Resources"), PDFDict)
      .lookup(PDFName.of("XObject"), PDFDict).lookup(PDFName.of("Inner"), PDFStream).dict;
    const loopCopy = xobjects.lookup(PDFName.of("Loop"), PDFStream).dict;
    const imageCopy = xobjects.lookup(PDFName.of("Img"), PDFStream).dict;
    const nestedImageCopy = innerCopy.lookup(PDFName.of("Resources"), PDFDict)
      .lookup(PDFName.of("XObject"), PDFDict).lookup(PDFName.of("Img"), PDFStream).dict;
    const noteCopy = inserted.lookup(PDFName.of("Annots"), PDFArray).lookup(0, PDFDict);
    const appearances = noteCopy.lookup(PDFName.of("AP"), PDFDict);
    const normalCopy = appearances.lookup(PDFName.of("N"), PDFStream).dict;
    const downCopy = appearances.lookup(PDFName.of("D"), PDFDict).lookup(PDFName.of("On"), PDFStream).dict;

    for (const dict of [outerCopy, innerCopy, loopCopy, normalCopy, downCopy, imageCopy, nestedImageCopy]) {
      expect(dict.get(PDFName.of("StructParents"))).toBeUndefined();
      expect(dict.get(PDFName.of("StructParent"))).toBeUndefined();
    }
  });
});
