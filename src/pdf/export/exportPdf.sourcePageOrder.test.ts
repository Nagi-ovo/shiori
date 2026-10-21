import { describe, expect, test } from "bun:test";
import { PDFDict, PDFDocument, PDFName, type PDFPage, type PDFRef } from "pdf-lib";
import { exportPdf } from "./exportPdf";
import type { DocumentModel } from "../model/types";

// Every page's sourceIndex is PDFium's page number. PDFium takes any /Kids
// entry without /Kids of its own for a page, and any entry with /Kids for a
// node, whatever /Type says; pdf-lib's getPages() keeps only leaves typed
// /Type /Page under nodes typed /Type /Pages. On a file PDFium tolerates and
// pdf-lib does not, export copied the wrong pages, or threw on the last one.

const SIZES = [100, 200, 300];

async function threePages(): Promise<{ doc: PDFDocument; pages: PDFPage[] }> {
  const doc = await PDFDocument.create();
  const pages = SIZES.map((size) => doc.addPage([size, size]));
  return { doc, pages };
}

function modelFor(sourceIndices: number[]): DocumentModel {
  const pages = sourceIndices.map((sourceIndex) => ({
    id: `p${sourceIndex}`,
    sourceIndex,
    rotation: 0 as const,
    widthPt: SIZES[sourceIndex]!,
    heightPt: SIZES[sourceIndex]!,
  }));
  return {
    pages,
    overlays: [
      {
        id: "hl",
        type: "highlight",
        pageId: pages[0]!.id,
        rects: [{ x: 10, y: 10, w: 50, h: 10 }],
        color: "#f4d674",
        opacity: 1,
      },
    ],
  } as unknown as DocumentModel;
}

async function exportedWidths(bytes: Uint8Array): Promise<number[]> {
  const out = await PDFDocument.load(bytes);
  return out.getPages().map((page) => Math.round(page.getWidth()));
}

describe("export numbers source pages the way PDFium does", () => {
  test("a page without /Type keeps its place", async () => {
    const { doc, pages } = await threePages();
    pages[0]!.node.delete(PDFName.of("Type"));
    const source = await doc.save({ useObjectStreams: false });

    const all = await exportPdf(source, modelFor([0, 1, 2]));
    // Read back by pdf-lib, which drops an untyped page: the export writes it
    // as a real page.
    expect(await exportedWidths(all.bytes)).toEqual([100, 200, 300]);

    const last = await exportPdf(source, modelFor([2]));
    expect(await exportedWidths(last.bytes)).toEqual([300]);
  });

  test("the pages under a /Pages node without /Type keep their place", async () => {
    const { doc, pages } = await threePages();
    const root = doc.catalog.Pages();
    const rootRef = doc.catalog.get(PDFName.of("Pages"));
    const group = doc.context.register(
      doc.context.obj({ Kids: [pages[0]!.ref, pages[1]!.ref], Count: 2, Parent: rootRef } as never),
    );
    pages[0]!.node.set(PDFName.of("Parent"), group);
    pages[1]!.node.set(PDFName.of("Parent"), group);
    root.set(PDFName.of("Kids"), doc.context.obj([group, pages[2]!.ref]));
    const source = await doc.save({ useObjectStreams: false });

    const all = await exportPdf(source, modelFor([0, 1, 2]));
    expect(await exportedWidths(all.bytes)).toEqual([100, 200, 300]);

    const middle = await exportPdf(source, modelFor([1]));
    expect(await exportedWidths(middle.bytes)).toEqual([200]);
  });

  test("a page tree root without /Type still exports its pages", async () => {
    const { doc } = await threePages();
    doc.catalog.Pages().delete(PDFName.of("Type"));
    const source = await doc.save({ useObjectStreams: false });

    const last = await exportPdf(source, modelFor([2]));
    expect(await exportedWidths(last.bytes)).toEqual([300]);
  });

  // A subtree named twice in /Kids is walked twice by pdf-lib; nested k deep
  // that lists 2^k pages, and a cyclic tree never ends. PDFium trusts the
  // root's /Count and opens either file as three pages.
  async function repeatedSubtree(depth: number, cyclic = false): Promise<Uint8Array> {
    const { doc, pages } = await threePages();
    const rootRef = doc.catalog.get(PDFName.of("Pages"));
    let child: PDFRef = pages[0]!.ref;
    for (let level = 0; level < depth; level += 1) {
      child = doc.context.register(
        doc.context.obj({ Kids: [child, child], Count: 1, Parent: rootRef } as never),
      );
    }
    if (cyclic) {
      doc.context.lookup(child, PDFDict).set(PDFName.of("Kids"), doc.context.obj([pages[0]!.ref, child]));
    }
    doc.catalog.Pages().set(PDFName.of("Kids"), doc.context.obj([child, pages[1]!.ref, pages[2]!.ref]));
    doc.catalog.Pages().set(PDFName.of("Count"), doc.context.obj(3));
    return doc.save({ useObjectStreams: false });
  }

  test("a page tree that repeats a subtree past the page limit is refused, not walked", async () => {
    for (const source of [await repeatedSubtree(12), await repeatedSubtree(1, true)]) {
      await expect(exportPdf(source, modelFor([0, 1, 2]))).rejects.toMatchObject({
        name: "PdfOpenError",
        kind: "tooManyPages",
      });
    }
  });
});
