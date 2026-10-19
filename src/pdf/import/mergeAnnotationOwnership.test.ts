import { describe, expect, test } from "bun:test";
import { PDFDocument, PDFName } from "pdf-lib";
import type { PageModel } from "../model/types";
import { insertPdfPages } from "../merge/insertPdf";
import { importFileAnnotations } from "./annotations";

const IMPORTED_AT = 1_700_000_000_000;

describe("physical append annotation ownership", () => {
  test("keeps edited or deleted base highlights hidden without re-importing them", async () => {
    const baseBytes = await highlightedPdf([1, 0.9, 0.2]);
    const incomingBytes = await highlightedPdf([0.2, 0.7, 1]);
    const merged = await insertPdfPages(baseBytes, incomingBytes, 1);
    const basePage = page("base", 0);
    const insertedPage = page("inserted", 1);
    const claimed: Array<[number, string, number[]]> = [];
    const imported = await importFileAnnotations(
      [basePage, insertedPage],
      merged.bytes,
      IMPORTED_AT,
      {
        overlayPageIds: new Set([insertedPage.id]),
        onSuppress: (sourceIndex, annotation) => claimed.push([sourceIndex, annotation.subtype, annotation.rect]),
      },
    );

    // The base annotation still exists physically after raw append, but the
    // engine must not draw it after the user edited or deleted its
    // already-imported overlay: it is still claimed, so hidden. The appended
    // page's highlight became an overlay: claimed too.
    expect(claimed).toEqual([
      [0, "Highlight", [20, 20, 120, 40]],
      [1, "Highlight", [20, 20, 120, 40]],
    ]);

    // Only the appended page is imported into the replacement model. An
    // edited base overlay stays authoritative and a deleted one stays gone.
    expect(imported.map((overlay) => [overlay.pageId, overlay.type])).toEqual([[insertedPage.id, "highlight"]]);
    // The incoming file's colour [0.2 0.7 1] (0.7 × 255 rounds half to even).
    expect(imported[0]).toMatchObject({ color: "#33b2ff", opacity: 0.35 });
  });
});

async function highlightedPdf(
  color: [number, number, number],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const annotation = pdf.context.obj({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [20, 20, 120, 40],
    QuadPoints: [20, 40, 120, 40, 20, 20, 120, 20],
    C: color,
    CA: 0.35,
  });
  const ref = pdf.context.register(annotation);
  const annotations = page.node.Annots() ?? pdf.context.obj([]);
  if (!page.node.Annots()) page.node.set(PDFName.of("Annots"), annotations);
  annotations.push(ref);
  return pdf.save({ useObjectStreams: false });
}

function page(id: string, sourceIndex: number): PageModel {
  return {
    id,
    sourceIndex,
    rotation: 0,
    widthPt: 300,
    heightPt: 400,
  };
}
