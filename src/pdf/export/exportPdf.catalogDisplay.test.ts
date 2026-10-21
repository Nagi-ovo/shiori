import { describe, expect, test } from "bun:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { exportPdf, type ExportMode } from "./exportPdf";
import type { DocumentModel } from "../model/types";

// Export builds a fresh catalog, so a document-level setting it does not
// carry over is gone from the user's file. Two that change what a reader
// sees: /OCProperties, which keeps layers such as an answer key hidden by
// default (without it every layer shows, on screen and in print), and
// /ViewerPreferences with /PageLayout, which hold a right-to-left book's
// reading direction and its two-page spreads.

describe("catalog display settings", () => {
  for (const mode of ["annotations", "flatten"] satisfies ExportMode[]) {
    test(`a layer hidden by default stays hidden after an edit (${mode})`, async () => {
      const source = await worksheetWithHiddenAnswers(1);

      const out = await PDFDocument.load(
        (await exportPdf(source, withHighlight(modelForPages([0])), { mode })).bytes,
      );

      const pageLayer = layerUsedByPage(out, 0);
      const properties = out.catalog.lookup(PDFName.of("OCProperties"), PDFDict);
      const off = properties
        .lookup(PDFName.of("D"), PDFDict)
        .lookup(PDFName.of("OFF"), PDFArray);
      // Visibility is by object identity: the OFF list must name the very
      // layer object the page's content is marked with.
      expect(off.asArray()).toContainEqual(pageLayer);
      expect(
        properties.lookup(PDFName.of("OCGs"), PDFArray).asArray(),
      ).toContainEqual(pageLayer);
    });
  }

  test("a page export keeps that page's hidden layer hidden", async () => {
    const source = await worksheetWithHiddenAnswers(2);

    const out = await PDFDocument.load(
      (await exportPdf(source, modelForPages([1]), { documentFiles: "omit" })).bytes,
    );

    const off = out.catalog
      .lookup(PDFName.of("OCProperties"), PDFDict)
      .lookup(PDFName.of("D"), PDFDict)
      .lookup(PDFName.of("OFF"), PDFArray);
    expect(off.asArray()).toContainEqual(layerUsedByPage(out, 0));
  });

  test("a form field on a hidden layer stays hidden after an edit", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    const layer = doc.context.register(
      doc.context.obj({ Type: "OCG", Name: PDFString.of("Answers") }),
    );
    // Marked through the widget's own /OC, which no page resource names.
    page.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: "Annot",
          Subtype: "Widget",
          FT: "Tx",
          T: PDFString.of("answer"),
          Rect: [20, 20, 120, 40],
          OC: layer,
        }),
      ),
    );
    doc.catalog.set(
      PDFName.of("OCProperties"),
      doc.context.obj({ OCGs: [layer], D: { OFF: [layer] } }),
    );
    const source = await doc.save();

    const out = await PDFDocument.load(
      (await exportPdf(source, withHighlight(modelForPages([0])))).bytes,
    );

    const widget = out
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map((ref) => out.context.lookup(ref, PDFDict))
      .find((annot) => annot.get(PDFName.of("Subtype")) === PDFName.of("Widget"));
    const off = out.catalog
      .lookup(PDFName.of("OCProperties"), PDFDict)
      .lookup(PDFName.of("D"), PDFDict)
      .lookup(PDFName.of("OFF"), PDFArray);
    expect(off.asArray()).toContainEqual(widget!.get(PDFName.of("OC"))!);
  });

  test("a right-to-left book keeps its reading direction and spreads", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([300, 400]);
    doc.catalog.set(
      PDFName.of("ViewerPreferences"),
      doc.context.obj({ Direction: "R2L", DisplayDocTitle: true }),
    );
    doc.catalog.set(PDFName.of("PageLayout"), PDFName.of("TwoPageRight"));
    const source = await doc.save();

    const out = await PDFDocument.load(
      (await exportPdf(source, withHighlight(modelForPages([0, 1])))).bytes,
    );

    const preferences = out.catalog.lookup(PDFName.of("ViewerPreferences"), PDFDict);
    expect(preferences.get(PDFName.of("Direction"))).toBe(PDFName.of("R2L"));
    expect(out.catalog.get(PDFName.of("PageLayout"))).toBe(PDFName.of("TwoPageRight"));
  });

  test("a print page range is dropped once the pages it numbers have changed", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([300, 400]);
    doc.catalog.set(
      PDFName.of("ViewerPreferences"),
      doc.context.obj({ Direction: "R2L", PrintPageRange: [2, 2] }),
    );
    const source = await doc.save();

    const out = await PDFDocument.load(
      (await exportPdf(source, modelForPages([1]), { documentFiles: "omit" })).bytes,
    );

    const preferences = out.catalog.lookup(PDFName.of("ViewerPreferences"), PDFDict);
    expect(preferences.get(PDFName.of("Direction"))).toBe(PDFName.of("R2L"));
    expect(preferences.has(PDFName.of("PrintPageRange"))).toBe(false);
  });
});

// Every page draws a box marked as content of one "Answers" layer, which
// the document's default configuration turns off.
async function worksheetWithHiddenAnswers(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const layer = doc.context.register(
    doc.context.obj({ Type: "OCG", Name: PDFString.of("Answers") }),
  );
  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage([300, 400]);
    page.node.Resources()!.set(
      PDFName.of("Properties"),
      doc.context.obj({ Ans: layer }),
    );
    page.node.set(
      PDFName.of("Contents"),
      doc.context.register(
        doc.context.stream("/OC /Ans BDC 20 20 50 50 re f EMC"),
      ),
    );
  }
  doc.catalog.set(
    PDFName.of("OCProperties"),
    doc.context.obj({ OCGs: [layer], D: { Order: [layer], OFF: [layer] } }),
  );
  return doc.save();
}

function layerUsedByPage(doc: PDFDocument, pageIndex: number): PDFRef {
  const properties = doc
    .getPage(pageIndex)
    .node.Resources()!
    .lookup(PDFName.of("Properties"), PDFDict);
  const layer = properties.get(PDFName.of("Ans"));
  if (!(layer instanceof PDFRef)) throw new Error("page lost its layer");
  return layer;
}

function modelForPages(sourceIndices: number[]): DocumentModel {
  return {
    pages: sourceIndices.map((sourceIndex) => ({
      id: `p${sourceIndex}`,
      sourceIndex,
      rotation: 0,
      widthPt: 300,
      heightPt: 400,
    })),
    overlays: [],
  };
}

function withHighlight(model: DocumentModel): DocumentModel {
  return {
    ...model,
    overlays: [
      {
        id: "h",
        type: "highlight",
        pageId: model.pages[0]!.id,
        rects: [{ x: 20, y: 300, w: 100, h: 12 }],
        color: "#ffd84d",
        opacity: 0.4,
      },
    ],
  };
}
