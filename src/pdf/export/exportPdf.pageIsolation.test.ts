import { describe, expect, test } from "bun:test";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
  type PDFPage,
} from "pdf-lib";
import { exportPdf } from "./exportPdf";
import type { DocumentModel } from "../model/types";

// A page or range export must carry the selected pages and nothing else. The
// page copier follows every reference it meets, so an annotation that points
// at another page (/P, a field's other widgets, a reply, a GoTo action, an
// article bead) used to drag that whole page, content stream included, into
// the file as an object outside the page tree: invisible in a viewer, but
// readable by anyone who opens the file with a text editor or a PDF library.

describe("page export isolation", () => {
  test("a form field shared with an unexported page does not carry that page", async () => {
    const { doc, pages } = await makeTextPages(3);
    const field = doc.getForm().createTextField("name");
    field.setText("Alice");
    field.addToPage(pages[0]!, { x: 20, y: 20, width: 100, height: 20 });
    field.addToPage(pages[2]!, { x: 20, y: 20, width: 100, height: 20 });
    const source = await doc.save();

    const { bytes } = await exportPdf(source, modelForPages([0]), {
      documentFiles: "omit",
    });
    const out = await PDFDocument.load(bytes);

    expect(out.getPageCount()).toBe(1);
    expect(orphanPageObjects(out)).toEqual([]);
    expect(outputContains(out, "SECRET_PAGE_2")).toBe(false);
    expect(outputContains(out, "SECRET_PAGE_0")).toBe(true);
    // The widget that was exported still names its own page.
    const widget = annotationsOf(out, out.getPage(0))[0]!;
    expect(widget.get(PDFName.of("P"))).toEqual(out.getPage(0).ref);
    expect(out.getForm().getTextField("name").getText()).toBe("Alice");
  });

  test("a sibling field that lives only on an unexported page is left out", async () => {
    const { doc, pages } = await makeTextPages(3);
    const form = doc.getForm();
    const name = form.createTextField("applicant.name");
    name.setText("Alice");
    name.addToPage(pages[0]!, { x: 20, y: 20, width: 100, height: 20 });
    const ssn = form.createTextField("applicant.ssn");
    ssn.setText("123-45-6789");
    ssn.addToPage(pages[2]!, { x: 20, y: 60, width: 100, height: 20 });
    const source = await doc.save();

    const { bytes } = await exportPdf(source, modelForPages([0]), {
      documentFiles: "omit",
    });
    const out = await PDFDocument.load(bytes);

    expect(outputContains(out, "123-45-6789")).toBe(false);
    expect(out.getForm().getFields().map((f) => f.getName())).toEqual([
      "applicant.name",
    ]);
  });

  test("a reply to a comment on an unexported page does not carry that page", async () => {
    const { doc, pages } = await makeTextPages(3);
    const parent = addTextAnnotation(doc, pages[2]!, "comment on the hidden page");
    const reply = addTextAnnotation(doc, pages[0]!, "reply");
    lookup(doc, reply).set(PDFName.of("IRT"), parent);
    const source = await doc.save();

    const { bytes } = await exportPdf(source, modelForPages([0]), {
      documentFiles: "omit",
      preserveSourceAnnotations: true,
    });
    const out = await PDFDocument.load(bytes);

    expect(orphanPageObjects(out)).toEqual([]);
    expect(outputContains(out, "SECRET_PAGE_2")).toBe(false);
    expect(outputContains(out, "comment on the hidden page")).toBe(false);
    expect(outputContains(out, "reply")).toBe(true);
  });

  test("an article thread through an unexported page does not carry that page", async () => {
    const { doc, pages } = await makeTextPages(3);
    const thread = doc.context.register(doc.context.obj({ Type: "Thread" }));
    const last = doc.context.register(
      doc.context.obj({ Type: "Bead", T: thread, P: pages[2]!.ref }),
    );
    const first = doc.context.register(
      doc.context.obj({ Type: "Bead", T: thread, P: pages[0]!.ref, N: last }),
    );
    lookup(doc, thread).set(PDFName.of("F"), first);
    pages[0]!.node.set(PDFName.of("B"), doc.context.obj([first]));
    pages[2]!.node.set(PDFName.of("B"), doc.context.obj([last]));
    const source = await doc.save();

    const { bytes } = await exportPdf(source, modelForPages([0]), {
      documentFiles: "omit",
    });
    const out = await PDFDocument.load(bytes);

    expect(orphanPageObjects(out)).toEqual([]);
    expect(outputContains(out, "SECRET_PAGE_2")).toBe(false);
  });

  test("a button's GoTo keeps pointing at its page when that page is exported", async () => {
    const { doc, pages } = await makeTextPages(3);
    addWidgetWithGoTo(doc, pages[0]!, pages[2]!);
    const source = await doc.save();

    // Partial: the target is gone, and so is its content.
    const partial = await PDFDocument.load(
      (await exportPdf(source, modelForPages([0]), { documentFiles: "omit" }))
        .bytes,
    );
    expect(orphanPageObjects(partial)).toEqual([]);
    expect(outputContains(partial, "SECRET_PAGE_2")).toBe(false);

    // Whole document, rebuilt because a page turned: the target is the page
    // that is really in the file, not a hidden duplicate of it.
    const model = modelForPages([0, 1, 2]);
    model.pages[1]!.rotation = 90;
    const whole = await PDFDocument.load(
      (await exportPdf(source, model)).bytes,
    );
    expect(orphanPageObjects(whole)).toEqual([]);
    const action = lookup(whole, annotationsOf(whole, whole.getPage(0))[0]!.get(PDFName.of("A"))!);
    const destination = action.lookup(PDFName.of("D"), PDFArray);
    expect(destination.get(0)).toEqual(whole.getPage(2).ref);
  });

  test("a whole-document rebuild leaves no duplicate page objects behind", async () => {
    const { doc, pages } = await makeTextPages(2);
    const field = doc.getForm().createTextField("name");
    field.addToPage(pages[0]!, { x: 20, y: 20, width: 100, height: 20 });
    field.addToPage(pages[1]!, { x: 20, y: 20, width: 100, height: 20 });
    const source = await doc.save();
    const model = modelForPages([0, 1]);
    model.pages[0]!.rotation = 90;

    const out = await PDFDocument.load((await exportPdf(source, model)).bytes);

    expect(orphanPageObjects(out)).toEqual([]);
    for (const page of out.getPages()) {
      for (const widget of annotationsOf(out, page)) {
        expect(widget.get(PDFName.of("P"))).toEqual(page.ref);
      }
    }
  });

  test("an annotation pointing at a page outside the page tree drops that object", async () => {
    // Files written by older exports carry exactly this: a widget whose /P
    // names a stray copy of a page that is not in /Pages.
    const { doc, pages } = await makeTextPages(1);
    const stray = doc.context.register(
      doc.context.obj({
        Type: "Page",
        MediaBox: [0, 0, 300, 300],
        Contents: doc.context.register(
          doc.context.flateStream("BT /F1 12 Tf (STRAY_PAGE) Tj ET"),
        ),
      }),
    );
    const annot = addTextAnnotation(doc, pages[0]!, "note");
    lookup(doc, annot).set(PDFName.of("P"), stray);
    const source = await doc.save();
    const model = modelForPages([0]);
    model.pages[0]!.rotation = 90;

    const out = await PDFDocument.load(
      (await exportPdf(source, model, { preserveSourceAnnotations: true })).bytes,
    );

    expect(orphanPageObjects(out)).toEqual([]);
    expect(outputContains(out, "STRAY_PAGE")).toBe(false);
  });
});

async function makeTextPages(count: number): Promise<{ doc: PDFDocument; pages: PDFPage[] }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: count }, (_, index) => {
    const page = doc.addPage([300, 300]);
    page.drawText(`SECRET_PAGE_${index}`, { x: 20, y: 150, font, size: 12 });
    return page;
  });
  return { doc, pages };
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

function addTextAnnotation(doc: PDFDocument, page: PDFPage, contents: string): PDFRef {
  const ref = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [10, 10, 30, 30],
      Contents: PDFString.of(contents),
      P: page.ref,
    }),
  );
  appendAnnotation(doc, page, ref);
  return ref;
}

function addWidgetWithGoTo(doc: PDFDocument, page: PDFPage, target: PDFPage) {
  const ref = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Btn",
      Ff: 1 << 16,
      T: PDFString.of("jump"),
      Rect: [10, 10, 60, 30],
      P: page.ref,
      A: { S: "GoTo", D: [target.ref, PDFName.of("Fit")] },
    }),
  );
  appendAnnotation(doc, page, ref);
  const form = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict) ??
    doc.context.obj({ Fields: [] });
  form.lookup(PDFName.of("Fields"), PDFArray).push(ref);
  doc.catalog.set(PDFName.of("AcroForm"), form);
}

function appendAnnotation(doc: PDFDocument, page: PDFPage, ref: PDFRef) {
  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (existing) existing.push(ref);
  else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
}

function lookup(doc: PDFDocument, value: PDFRef | PDFDict | object): PDFDict {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!(resolved instanceof PDFDict)) throw new Error("expected a dictionary");
  return resolved;
}

function annotationsOf(doc: PDFDocument, page: PDFPage): PDFDict[] {
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return [];
  return annots.asArray().map((entry) => lookup(doc, entry));
}

function orphanPageObjects(doc: PDFDocument): string[] {
  const inTree = new Set(doc.getPages().map((page) => page.ref.toString()));
  return doc.context
    .enumerateIndirectObjects()
    .filter(
      ([ref, object]) =>
        object instanceof PDFDict &&
        object.get(PDFName.of("Type"))?.toString() === "/Page" &&
        !inTree.has(ref.toString()),
    )
    .map(([ref]) => ref.toString());
}

// True when `text` appears anywhere in the file: in a string object, or in a
// stream, either literally or hex-encoded the way pdf-lib writes shown text.
function outputContains(doc: PDFDocument, text: string): boolean {
  const hex = Buffer.from(text, "latin1").toString("hex").toUpperCase();
  const strings: string[] = [];
  const visit = (object: unknown) => {
    if (object instanceof PDFString || object instanceof PDFHexString) {
      strings.push(object.decodeText());
    }
    else if (object instanceof PDFArray) object.asArray().forEach(visit);
    else if (object instanceof PDFDict) object.values().forEach(visit);
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      visit(object.dict);
      const data = object.dict.get(PDFName.of("Filter"))
        ? decodePDFRawStream(object).decode()
        : object.getContents();
      strings.push(new TextDecoder("latin1").decode(data));
    } else {
      visit(object);
    }
  }
  return strings.some(
    (value) => value.includes(text) || value.toUpperCase().includes(hex),
  );
}
