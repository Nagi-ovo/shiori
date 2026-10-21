import { describe, expect, test } from "bun:test";
import { PDFDocument, PDFName } from "pdf-lib";
import { insertPdfPages } from "./insertPdf";

// The inserted pages pass through export, which reads every sourceIndex as
// PDFium's page number. The incoming file has to be numbered the same way:
// PDFium takes a /Kids entry with no /Type for a page, pdf-lib does not.
describe("insertPdfPages numbers the incoming PDF as PDFium does", () => {
  test("an incoming page without /Type is inserted, and none is lost", async () => {
    const base = await PDFDocument.create();
    base.addPage([400, 400]);
    const incoming = await PDFDocument.create();
    const pages = [100, 200, 300].map((size) => incoming.addPage([size, size]));
    pages[0]!.node.delete(PDFName.of("Type"));

    const result = await insertPdfPages(
      await base.save(),
      await incoming.save({ useObjectStreams: false }),
      1,
    );
    const loaded = await PDFDocument.load(result.bytes);

    expect(result.insertedPageCount).toBe(3);
    expect(loaded.getPages().map((page) => Math.round(page.getWidth()))).toEqual([400, 100, 200, 300]);
  });
});
