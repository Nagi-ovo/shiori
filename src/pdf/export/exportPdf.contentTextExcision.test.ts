import { describe, expect, test } from "bun:test";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { exportPdf, type ExportMode } from "./exportPdf";
import type { ExportSourceEncryption } from "./encryptedSource";
import type { ContentTextOverlay, DocumentModel, PdfRect } from "../model/types";

// Original-text edits rewrite source operators; unsupported edits draw nothing.
import {inspectRunPage} from './contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from './contentStreamEdit/tokenizer';
const loadFont=(name:string)=>Bun.file(name.startsWith('Noto')?`src/assets/fonts/${name}`:`node_modules/@docx-editor.dev/fonts/assets/${name}`).bytes();
async function assertRetypeset(bytes:Uint8Array){
 const pdf=await PDFDocument.load(bytes),s=inspectRunPage(pdf.getPage(0));if(!s.ok)throw Error(s.reason);
 expect(tokenizeContentStream(s.bytes).filter(o=>o.operator==='re')).toHaveLength(0);
}

const unicodeFontUrl = new URL(
  "../../assets/fonts/NotoSansSC-Regular.otf",
  import.meta.url,
).href;

// "Hi" at 12pt from x=72 on baseline 700. Even a grazing selection
// must resolve the user's original span and rewrite it without covering ink.
const FULL_COVER: PdfRect = { x: 65, y: 690, w: 40, h: 30 };
const SLIVER: PdfRect = { x: 72, y: 690, w: 1, h: 30 };

describe("original-text stream rewrites", () => {
  for (const mode of ["annotations", "flatten"] satisfies ExportMode[]) {
    test(`an edit whose text was removed reports none left behind (${mode})`, async () => {
      const result = await exportPdf(await sourceWithHi(), model([edit("a", FULL_COVER)]), {
        mode,inPlaceFallback:{loadFont},
      });
      expect(result.unexcisedEdits).toBe(0);
      expect(result.contentTextOutcomes?.[0]).toMatchObject({mode:"retypeset",fidelity:"approximate"});await assertRetypeset(result.bytes);
    });

    test(`a grazing selection still rewrites the addressed word without a cover (${mode})`, async () => {
      const result = await exportPdf(await sourceWithHi(), model([edit("a", SLIVER)]), {
        mode,inPlaceFallback:{loadFont},
      });
      expect(result.unexcisedEdits).toBe(0);await assertRetypeset(result.bytes);
    });
  }

  // Duplicate geometry still identifies one original source span.
  test("duplicate cover rectangles identify one source edit", async () => {
    const overlays = [{ ...edit("kept", SLIVER), coverRects: [SLIVER, SLIVER] }];
    const result = await exportPdf(await sourceWithHi(), model(overlays),{inPlaceFallback:{loadFont}});
    expect(result.unexcisedEdits).toBe(0);await assertRetypeset(result.bytes);
  });

  test("an encrypted source also retypesets without a cover", async () => {
    const plain = await sourceWithHi();
    const encryption: ExportSourceEncryption = {
      security: null,
      plaintext: async () => plain,
      encrypt: async (bytes) => bytes,
    };
    const result = await exportPdf(plain, model([edit("a", SLIVER)]), {
      sourceEncryption: encryption,inPlaceFallback:{loadFont},
    });
    expect(result.unexcisedEdits).toBe(0);await assertRetypeset(result.bytes);
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
