import { describe, expect, test } from "bun:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { exportPdf } from "./exportPdf";
import type { DocumentModel } from "../model/types";

// /AcroForm /CO lists the fields a viewer recalculates, in order, whenever
// a value changes. It has to name the same field objects the form's /Fields
// tree and the page widgets use; a copy of a field there is a phantom that
// gets recalculated while the total the reader sees never updates. And a
// calculated field need not have a widget at all: such a hidden field is
// still part of the form.

describe("form calculation order", () => {
  test("the calculation order names the fields the form really has", async () => {
    const source = await calculatedForm({ totalOnPage: 0, hiddenField: false });

    const out = await PDFDocument.load(
      (await exportPdf(source, rotated(modelForPages([0, 1])))).bytes,
    );

    const total = out.getForm().getTextField("total").ref;
    expect(calculationOrder(out)).toEqual([total]);
  });

  test("a hidden calculated field without a widget survives a whole-document export", async () => {
    const source = await calculatedForm({ totalOnPage: 0, hiddenField: true });

    const out = await PDFDocument.load(
      (await exportPdf(source, rotated(modelForPages([0, 1])))).bytes,
    );

    const names = out.getForm().getFields().map((field) => field.getName());
    expect(names).toContain("hiddenTotal");
    const hidden = out.getForm().getTextField("hiddenTotal").ref;
    const total = out.getForm().getTextField("total").ref;
    expect(calculationOrder(out)).toEqual([total, hidden]);
  });

  test("a widgetless calculated field inside a group keeps its calculation", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    form
      .createTextField("group.visible")
      .addToPage(page, { x: 20, y: 200, width: 100, height: 20 });
    const visible = form.getTextField("group.visible").acroField.dict;
    const groupRef = visible.get(PDFName.of("Parent")) as PDFRef;
    const hidden = doc.context.register(
      doc.context.obj({ FT: "Tx", T: PDFString.of("hidden"), Parent: groupRef }),
    );
    doc.context
      .lookup(groupRef, PDFDict)
      .lookup(PDFName.of("Kids"), PDFArray)
      .push(hidden);
    form.acroForm.dict.set(PDFName.of("CO"), doc.context.obj([hidden]));
    const source = await doc.save({ updateFieldAppearances: false });

    const out = await PDFDocument.load(
      (await exportPdf(source, rotated(modelForPages([0])))).bytes,
    );

    expect(calculationOrder(out)).toEqual([
      out.getForm().getTextField("group.hidden").ref,
    ]);
  });

  test("a calculated field inside a group with no widget at all keeps its calculation", async () => {
    const source = await calculatedForm({ totalOnPage: 0, hiddenField: false });
    const doc = await PDFDocument.load(source);
    const group = doc.context.register(
      doc.context.obj({ T: PDFString.of("calc"), Kids: [] }),
    );
    const total = doc.context.register(
      doc.context.obj({ FT: "Tx", T: PDFString.of("total"), Parent: group }),
    );
    doc.context.lookup(group, PDFDict).lookup(PDFName.of("Kids"), PDFArray).push(total);
    doc.getForm().acroForm.addField(group);
    doc.getForm().acroForm.dict.set(PDFName.of("CO"), doc.context.obj([total]));

    const out = await PDFDocument.load(
      (await exportPdf(
        await doc.save({ updateFieldAppearances: false }),
        rotated(modelForPages([0, 1])),
      )).bytes,
    );

    expect(calculationOrder(out)).toEqual([
      out.getForm().getTextField("calc.total").ref,
    ]);
  });

  test("a field left out with its page leaves the calculation order too", async () => {
    const source = await calculatedForm({ totalOnPage: 1, hiddenField: false });

    const out = await PDFDocument.load(
      (await exportPdf(source, modelForPages([0]), { documentFiles: "omit" })).bytes,
    );

    expect(out.getForm().getFields().map((field) => field.getName())).toEqual([
      "a",
    ]);
    expect(calculationOrder(out)).toEqual([]);
  });
});

// Field "a" on page 1 and "total" on page `totalOnPage`, with "total" (and
// optionally a widgetless "hiddenTotal") in the calculation order.
async function calculatedForm(options: {
  totalOnPage: number;
  hiddenField: boolean;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pages = [doc.addPage([300, 300]), doc.addPage([300, 300])];
  const form = doc.getForm();
  const a = form.createTextField("a");
  a.addToPage(pages[0]!, { x: 20, y: 200, width: 100, height: 20 });
  const total = form.createTextField("total");
  total.addToPage(pages[options.totalOnPage]!, { x: 20, y: 100, width: 100, height: 20 });
  const calculate = doc.context.obj({
    C: { S: "JavaScript", JS: PDFString.of("event.value = 1;") },
  });
  total.acroField.dict.set(PDFName.of("AA"), calculate);
  const order: PDFRef[] = [total.ref];
  if (options.hiddenField) {
    const hidden = doc.context.register(
      doc.context.obj({ FT: "Tx", T: PDFString.of("hiddenTotal"), AA: calculate }),
    );
    form.acroForm.addField(hidden);
    order.push(hidden);
  }
  form.acroForm.dict.set(PDFName.of("CO"), doc.context.obj(order));
  // pdf-lib would try to draw the widgetless field's appearance and fail.
  return doc.save({ updateFieldAppearances: false });
}

function calculationOrder(doc: PDFDocument): PDFRef[] {
  const form = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
  const order = form.lookupMaybe(PDFName.of("CO"), PDFArray);
  return (order?.asArray() ?? []).map((entry) => {
    if (!(entry instanceof PDFRef)) throw new Error("/CO entry is not a reference");
    return entry;
  });
}

function modelForPages(sourceIndices: number[]): DocumentModel {
  return {
    pages: sourceIndices.map((sourceIndex) => ({
      id: `p${sourceIndex}`,
      sourceIndex,
      rotation: 0,
      widthPt: 300,
      heightPt: 300,
    })),
    overlays: [],
  };
}

// Turning a page forces a rebuild without changing which pages are kept.
function rotated(model: DocumentModel): DocumentModel {
  return {
    ...model,
    pages: model.pages.map((page, index) =>
      index === 0 ? { ...page, rotation: 90 } : page,
    ),
  };
}
