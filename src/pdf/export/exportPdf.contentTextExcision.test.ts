import { describe, expect, test } from "bun:test";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { exportPdf, type ExportMode } from "./exportPdf";
import type { ExportSourceEncryption } from "./encryptedSource";
import type { ContentTextOverlay, DocumentModel, PdfRect } from "../model/types";

// An original-text edit removes the covered glyphs from the page content
// when it can. When it cannot (a glyph only partly covered, text inside a
// Form XObject, an unsupported font or a parse failure), the export paints
// over the old text instead: the page looks edited, but search and copy in
// any viewer still return the original words. The export result says how
// many edits ended that way, so the user can be told before sharing.

const unicodeFontUrl = new URL(
  "../../assets/fonts/NotoSansSC-Regular.otf",
  import.meta.url,
).href;

// "Hi" at 12pt from x=72 on baseline 700. A cover over x 65..105 takes
// both glyphs; a 1pt sliver at x=72 only grazes the H, which then stays.
const FULL_COVER: PdfRect = { x: 65, y: 690, w: 40, h: 30 };
const SLIVER: PdfRect = { x: 72, y: 690, w: 1, h: 30 };

describe("original-text edits that could not be excised", () => {
  for (const mode of ["annotations", "flatten"] satisfies ExportMode[]) {
    test(`an edit whose text was removed reports none left behind (${mode})`, async () => {
      const result = await exportPdf(await sourceWithHi(), model([edit("a", FULL_COVER)]), {
        mode,
      });
      expect(result.unexcisedEdits).toBe(0);
    });

    test(`an edit that left the original text in the file is counted (${mode})`, async () => {
      const result = await exportPdf(await sourceWithHi(), model([edit("a", SLIVER)]), {
        mode,
      });
      expect(result.unexcisedEdits).toBe(1);
    });
  }

  test("counts edits, not their cover rectangles", async () => {
    const overlays = [
      edit("removed", FULL_COVER),
      { ...edit("kept", SLIVER), coverRects: [SLIVER, SLIVER] },
    ];
    const result = await exportPdf(await sourceWithHi(), model(overlays));
    expect(result.unexcisedEdits).toBe(1);
  });

  test("an encrypted source's export reports it too", async () => {
    const plain = await sourceWithHi();
    const encryption: ExportSourceEncryption = {
      security: null,
      plaintext: async () => plain,
      encrypt: async (bytes) => bytes,
    };
    const result = await exportPdf(plain, model([edit("a", SLIVER)]), {
      sourceEncryption: encryption,
    });
    expect(result.unexcisedEdits).toBe(1);
  });
});

async function sourceWithHi(): Promise<Uint8Array> {
  const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes);
  doc.addPage([612, 792]).drawText("Hi", { x: 72, y: 700, size: 12, font });
  return doc.save();
}

function model(overlays: ContentTextOverlay[]): DocumentModel {
  return {
    pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
    overlays,
  };
}

function edit(id: string, cover: PdfRect): ContentTextOverlay {
  return {
    id,
    type: "contentText",
    pageId: "p1",
    rect: { x: 70, y: 692, w: 60, h: 24 },
    coverRects: [cover],
    originalText: "Hi",
    text: "Bye",
    fontSize: 12,
    color: "#1a1815",
    bold: false,
    align: "left",
    fontFamily: "sans",
    backgroundColor: "#ffffff",
  };
}
