import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { appendPdfBytes } from "./appendPdf";

describe("PDF merge helpers", () => {
  test("appends all pages from another PDF", async () => {
    const base = await PDFDocument.create();
    base.addPage([300, 400]);
    const incoming = await PDFDocument.create();
    incoming.addPage([200, 200]);
    incoming.addPage([210, 210]);

    const merged = await appendPdfBytes(await base.save(), await incoming.save());
    const loaded = await PDFDocument.load(merged);

    expect(loaded.getPageCount()).toBe(3);
    expect(loaded.getPage(2).getWidth()).toBe(210);
  });
});
