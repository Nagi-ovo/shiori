// Run by `bun run test:core` after the addon is built.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openCoreDocument } from "../../../cli/src/coreEngine";
import { importFileAnnotations } from "../../../src/pdf/import/annotations";
import type { PageModel } from "../../../src/pdf/model/types";

// encrypted-notes.pdf (crates/shiori-core/tests/fixtures/make-fixtures.ts):
// owner password only; 4 0 obj is a Text note at [40 300 60 320], colour
// [1 0.8 0], /Contents "Encrypted note 加密", /T "Reviewer", /M
// D:20260925120000Z; 5 0 obj a Highlight over [20 20 120 40], colour [1 1 0].
const ENCRYPTED = readFileSync(join(import.meta.dir, "../../shiori-core/tests/fixtures/encrypted-notes.pdf"));
const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 300, heightPt: 400 };

describe("importing an encrypted file's annotations", () => {
  test("reads them from PDFium's decrypted copy, under the file's own object ids", async () => {
    const core = openCoreDocument(new Uint8Array(ENCRYPTED));
    try {
      const overlays = await importFileAnnotations([page], new Uint8Array(ENCRYPTED), 0, {
        decryptedBytes: async () => core.decryptedCopy(),
      });
      expect(overlays).toEqual([
        {
          type: "note",
          id: "pdf-annotation-0-4R",
          pageId: "p1",
          // The note card opens down from the icon's top-left corner.
          rect: { x: 40, y: 226, w: 168, h: 94 },
          text: "Encrypted note 加密",
          color: "#ffcc00",
          createdAt: 0,
          updatedAt: 0,
          sourceAuthor: "Reviewer",
          sourceFlags: 0,
          sourceModifiedAt: Date.UTC(2026, 8, 25, 12),
          origin: "imported",
          importedAt: 0,
        },
        expect.objectContaining({
          type: "highlight",
          id: "pdf-annotation-0-5R",
          rects: [{ x: 20, y: 20, w: 100, h: 20 }],
          color: "#ffff00",
          sourceAuthor: "Reviewer",
        }),
      ]);
    } finally {
      core.close();
    }
  });

  test("imports nothing, rather than undecrypted strings, without a decrypted copy", async () => {
    expect(await importFileAnnotations([page], new Uint8Array(ENCRYPTED), 0)).toEqual([]);
  });
});
