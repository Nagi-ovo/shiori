import { describe, expect, test } from "bun:test";
import { PDFDocument, PDFName, PDFObject, PDFString } from "pdf-lib";
import { insertPdfPages, PdfPageInsertError } from "./insertPdf";

async function insertWithAcroForm(acroForm: (incoming: PDFDocument) => PDFObject) {
  const base = await PDFDocument.create();
  base.addPage([500, 500]);
  const incoming = await PDFDocument.create();
  incoming.addPage([200, 200]);
  incoming.catalog.set(PDFName.of("AcroForm"), acroForm(incoming));
  return insertPdfPages(await base.save(), await incoming.save(), 1);
}

describe("insertPdfPages with an incoming /AcroForm", () => {
  test("accepts an empty form left behind by flattening or a generator", async () => {
    const result = await insertWithAcroForm((incoming) => incoming.context.obj({ Fields: [] }));
    const loaded = await PDFDocument.load(result.bytes);

    expect(result.insertedPageCount).toBe(1);
    expect(loaded.getPageCount()).toBe(2);
  });

  const forms: [string, (incoming: PDFDocument) => PDFObject][] = [
    ["a field without a widget", (incoming) => incoming.context.obj({
      Fields: [incoming.context.register(incoming.context.obj({ FT: "Tx", T: PDFString.of("name") }))],
    })],
    ["an XFA form", (incoming) => incoming.context.obj({ Fields: [], XFA: PDFString.of("<xdp:xdp/>") })],
    ["signature flags", (incoming) => incoming.context.obj({ Fields: [], SigFlags: 3 })],
    ["a non-array /Fields", (incoming) => incoming.context.obj({ Fields: "broken" })],
    ["a non-dictionary /AcroForm", () => PDFString.of("broken")],
  ];
  for (const [label, acroForm] of forms) {
    test(`fails closed for ${label} instead of copying a broken form`, async () => {
      const error = await insertWithAcroForm(acroForm).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PdfPageInsertError);
      expect((error as PdfPageInsertError).code).toBe("interactive");
    });
  }
});
