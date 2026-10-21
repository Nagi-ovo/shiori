import { describe, expect, test } from "bun:test";
import type { PageModel } from "../../pdf/model/types";
import { fontKey } from "../../pdf/engine/fontKey";
import { createPdfEditorStore } from "./store";

// What can go wrong with the record of the document's own fonts, which edit
// boxes read for their face and for the missing-glyph warning:
// - a page merge swaps in a new document. Its rebuilt fonts start empty and
//   gain glyphs only as its pages are read again, while the old document's
//   faces are destroyed. Kept across the swap, the old character coverage
//   tells the warning a character is covered when the new face lacks it, so
//   the edit box draws it in a fallback font with no warning.
// - two programs under one font name (two papers merged into one file, each
//   with its own subset): pooled, an edit in one paper's text draws with the
//   other's face, and the warning counts the other's characters (B108).
// - a draft saved before fonts were keyed by their program names the font
//   alone; its edit box must still find the font's face, and count only
//   that face's characters as covered.

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

  test("two programs under one name keep their own face and characters", () => {
    const store = createPdfEditorStore();
    store.getState().registerPdfFontFaces([
      { baseFontName: fontKey("Calibri", "1a"), faceFamily: "shiori-pdf-a", chars: "Hi" },
      { baseFontName: fontKey("Calibri", "2b"), faceFamily: "shiori-pdf-b", chars: "Ho" },
    ]);
    const { pdfFontFaces, pdfFontChars } = store.getState();
    expect(pdfFontFaces[fontKey("Calibri", "2b")]).toBe("shiori-pdf-b");
    expect([...pdfFontChars[fontKey("Calibri", "2b")]!]).toEqual(["H", "o"]);
    // An edit saved by name alone finds the first face under it, as it did,
    // and is warned about the characters that face lacks.
    expect(pdfFontFaces.Calibri).toBe("shiori-pdf-a");
    expect([...pdfFontChars.Calibri!]).toEqual(["H", "i"]);
  });
});
