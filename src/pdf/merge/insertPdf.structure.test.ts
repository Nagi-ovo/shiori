import { describe, expect, test } from "bun:test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
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
});
