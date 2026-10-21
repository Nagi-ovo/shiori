import { describe, expect, test } from "bun:test";
import type { PageModel } from "../../pdf/model/types";
import { createPdfEditorStore } from "./store";

// What can go wrong with the record of the document's own fonts, which edit
// boxes read for their face and for the missing-glyph warning:
// - a page merge swaps in a new document. Its rebuilt fonts start empty and
//   gain glyphs only as its pages are read again, while the old document's
//   faces are destroyed. Kept across the swap, the old character coverage
//   tells the warning a character is covered when the new face lacks it, so
//   the edit box draws it in a fallback font with no warning.

const page = (id: string, sourceIndex: number): PageModel => ({
  id,
  sourceIndex,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
});

describe("PDF font registry", () => {
  test("a merge that swaps the document forgets the old document's fonts", () => {
    const store = createPdfEditorStore();
    const pages = [page("a", 0)];
    store.getState().setOpened(
      { fileName: "paper.pdf", fileSize: 1, doc: {} as never, bytes: new Uint8Array([1]) },
      pages,
    );
    store.getState().registerPdfFontFaces([
      { baseFontName: "CMR10", faceFamily: "shiori-pdf-1-0", chars: "ab" },
    ]);

    store.getState().setOpened(
      { fileName: "paper.pdf", fileSize: 2, doc: {} as never, bytes: new Uint8Array([1, 2]) },
      [...pages, page("b", 1)],
      store.getState().model,
      { preserveHistory: true },
    );
    store.getState().registerPdfFontFaces([
      { baseFontName: "CMR10", faceFamily: "shiori-pdf-2-0", chars: "a" },
    ]);

    expect(store.getState().pdfFontFaces).toEqual({ CMR10: "shiori-pdf-2-0" });
    expect([...store.getState().pdfFontChars.CMR10!]).toEqual(["a"]);
  });
});
