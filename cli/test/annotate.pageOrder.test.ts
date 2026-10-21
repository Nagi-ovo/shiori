import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PDFDocument, PDFName } from "pdf-lib";
import { main } from "../src/main";

// `--page N` counts pages the way PDFium does, like `shiori extract` and the
// app. PDFium takes a page dictionary without /Type for a page; pdf-lib's
// getPages() skips it, so the CLI numbered the pages after it one too low and
// rejected the last page as out of range.
describe("shiori annotate page numbers", () => {
  test("a page without /Type keeps its number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-page-order-"));
    try {
      const doc = await PDFDocument.create();
      const pages = [100, 200, 300].map((size) => doc.addPage([size, size]));
      pages[0]!.node.delete(PDFName.of("Type"));
      const input = join(dir, "untyped.pdf");
      const spec = join(dir, "spec.json");
      const output = join(dir, "annotated.pdf");
      await writeFile(input, await doc.save({ useObjectStreams: false }));
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            { type: "highlight", page: 3, rects: [{ x: 10, y: 10, w: 50, h: 10 }] },
          ],
        }),
      );
      const log = console.log;
      console.log = () => undefined;
      try {
        await main(["annotate", input, "--spec", spec, "-o", output]);
      } finally {
        console.log = log;
      }

      const out = await PDFDocument.load(await readFile(output));
      expect(out.getPages().map((page) => page.getWidth())).toEqual([100, 200, 300]);
      expect(out.getPages().map((page) => page.node.Annots()?.size() ?? 0)).toEqual([0, 0, 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
