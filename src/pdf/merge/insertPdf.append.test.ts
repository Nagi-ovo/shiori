import { describe, expect, test } from "bun:test";
import { PDFDocument, PDFName, PDFNull, PDFRef } from "pdf-lib";
import { insertPdfPages } from "./insertPdf";

// Appending moves no existing page, so navigation the base already had
// (valid or stale) must neither block the insert nor be rewritten.
describe("insertPdfPages appending after the last page", () => {
  const defects: [string, (document: PDFDocument) => void][] = [
    ["a null /Annots entry", (document) => {
      document.getPage(0).node.set(PDFName.of("Annots"), document.context.obj([PDFNull]));
    }],
    ["a dangling /Annots reference", (document) => {
      document.getPage(0).node.set(PDFName.of("Annots"), document.context.obj([PDFRef.of(998)]));
    }],
    ["an outline item pointing at a deleted page", (document) => {
      const item = document.context.obj({ Title: "Ch 9", Dest: [PDFRef.of(999), "Fit"] });
      const itemRef = document.context.register(item);
      const outlines = document.context.obj({ Type: "Outlines", First: itemRef, Last: itemRef, Count: 1 });
      const outlinesRef = document.context.register(outlines);
      item.set(PDFName.of("Parent"), outlinesRef);
      document.catalog.set(PDFName.of("Outlines"), outlinesRef);
    }],
    ["a link action without /S", (document) => {
      const link = document.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [0, 0, 10, 10],
        A: { URI: "https://example.com" },
      });
      document.getPage(0).node.set(
        PDFName.of("Annots"),
        document.context.obj([document.context.register(link)]),
      );
    }],
  ];

  for (const [label, introduce] of defects) {
    test(`accepts a base PDF with ${label}`, async () => {
      const base = await PDFDocument.create();
      base.addPage([200, 200]);
      base.addPage([210, 210]);
      introduce(base);
      const incoming = await PDFDocument.create();
      incoming.addPage([100, 100]);

      const result = await insertPdfPages(await base.save(), await incoming.save(), 2, "pasted-image.pdf");
      const loaded = await PDFDocument.load(result.bytes);

      expect(result.insertedPageCount).toBe(1);
      expect(loaded.getPages().map((page) => page.getWidth())).toEqual([200, 210, 100]);
    });
  }
});
