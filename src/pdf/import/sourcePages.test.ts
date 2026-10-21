import { expect, test } from "bun:test";
import { PDFDocument, PDFName, type PDFRef } from "pdf-lib";
import { sourcePageDicts } from "./sourcePages";

// A node walked once per listing makes a tree of 40 nodes that each list the
// next one twice hold 2^40 pages; PDFium numbers only as many as the root's
// /Count, so the walk stops there.
test("a page tree that shares a subtree at every level ends at the root's /Count", async () => {
  const pdf = await PDFDocument.create();
  const leaf = pdf.addPage([300, 400]);
  let node: PDFRef = leaf.ref;
  for (let depth = 0; depth < 40; depth += 1) {
    node = pdf.context.register(pdf.context.obj({ Type: "Pages", Kids: [node, node] } as never));
  }
  const root = pdf.catalog.Pages();
  root.set(PDFName.of("Kids"), pdf.context.obj([node]));
  root.set(PDFName.of("Count"), pdf.context.obj(3));
  const pages = sourcePageDicts(pdf);
  expect(pages).toHaveLength(3);
  expect(pages.every((page) => page === leaf.node)).toBe(true);
});
