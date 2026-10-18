// Run by `bun run test:core` after the addon is built.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { openCoreDocument } from "../../../cli/src/coreEngine";
import type { PdfDocument } from "../../../src/pdf/engine/types";
import { importPdfAnnotations } from "../../../src/pdf/import/annotations";
import type { PageModel } from "../../../src/pdf/model/types";

const ENCRYPTED = readFileSync(join(import.meta.dir, "../../shiori-core/tests/fixtures/encrypted-notes.pdf"));
const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 300, heightPt: 400 };

describe("importing an encrypted file's annotations", () => {
  test("reads them from PDFium's decrypted copy exactly as pdf.js reads the file", async () => {
    const doc = (await pdfjsLib.getDocument({ data: new Uint8Array(ENCRYPTED) }).promise) as unknown as PdfDocument;
    const core = openCoreDocument(new Uint8Array(ENCRYPTED));
    try {
      // No pdf.js to fall back on: the file itself, decrypted, is all it reads.
      const noPdfjs = {
        annotationStorage: { setValue: () => undefined },
        getPage: () => {
          throw new Error("pdf.js was read");
        },
      } as unknown as PdfDocument;
      const viaCore = await importPdfAnnotations(noPdfjs, [page], new Uint8Array(ENCRYPTED), 0, {
        decryptedBytes: async () => core.decryptedCopy(),
      });
      const viaPdfjs = await importPdfAnnotations(doc, [page], new Uint8Array(ENCRYPTED), 0, {
        annotationReader: "pdfjs",
      });
      // The note keeps its text and author, and its id is the file's object.
      expect(viaCore.map((o) => [o.type, o.id])).toEqual([
        ["note", "pdf-annotation-0-4R"],
        ["highlight", "pdf-annotation-0-5R"],
      ]);
      expect(viaCore.find((o) => o.type === "note")).toMatchObject({ text: "Encrypted note 加密", sourceAuthor: "Reviewer" });
      expect(viaCore).toEqual(viaPdfjs);
    } finally {
      core.close();
      await (doc as unknown as { destroy: () => Promise<void> }).destroy();
    }
  });
});
