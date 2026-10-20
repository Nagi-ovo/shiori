import { describe, expect, test } from "bun:test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { exportPdf } from "./exportPdf";
import type { DocumentModel } from "../model/types";

describe("review provenance survives a round trip", () => {
  function note(id: string, extra: Record<string, unknown> = {}) {
    return {
      type: "note" as const,
      id,
      pageId: "p1",
      rect: { x: 72, y: 700, w: 24, h: 24 },
      text: `body of ${id}`,
      color: "#f4d674",
      ...extra,
    };
  }

  async function annotationsOnFirstPage(bytes: Uint8Array) {
    const loaded = await PDFDocument.load(bytes);
    const annots = loaded
      .getPage(0)
      .node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    const out: PDFDict[] = [];
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const dict = loaded.context.lookupMaybe(annots!.get(i), PDFDict);
      if (dict) out.push(dict);
    }
    return { loaded, annots: out };
  }

  test("author and dates from the source file are written back", async () => {
    const original = await PDFDocument.create().then(async (doc) => {
      doc.addPage([612, 792]);
      return doc.save();
    });

    const created = Date.UTC(2026, 2, 14, 9, 30, 0);
    const model = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        note("n1", {
          sourceAuthor: "Jane Chen",
          sourceCreatedAt: created,
          sourceModifiedAt: created + 3_600_000,
        }),
      ],
    } as unknown as DocumentModel;

    const { bytes } = await exportPdf(original, model);
    const { annots } = await annotationsOnFirstPage(bytes);
    const target = annots.find((d) => d.get(PDFName.of("T")));
    if (!target) throw new Error("expected an annotation carrying /T");

    expect(String(target.get(PDFName.of("T")))).toContain("Jane Chen");
    expect(String(target.get(PDFName.of("CreationDate")))).toContain(
      "D:20260314093000Z",
    );
    expect(String(target.get(PDFName.of("M")))).toContain("D:20260314103000Z");
  });

  test("an overlay the user authored gets no invented author or date", async () => {
    const original = await PDFDocument.create().then(async (doc) => {
      doc.addPage([612, 792]);
      return doc.save();
    });
    const model = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [note("mine")],
    } as unknown as DocumentModel;

    const { bytes } = await exportPdf(original, model);
    const { annots } = await annotationsOnFirstPage(bytes);
    for (const dict of annots) {
      expect(dict.get(PDFName.of("T"))).toBeUndefined();
    }
  });

  test("reply threads are rebuilt as /IRT rather than flattened", async () => {
    const original = await PDFDocument.create().then(async (doc) => {
      doc.addPage([612, 792]);
      return doc.save();
    });

    const model = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        note("parent", { sourceAuthor: "Jane Chen" }),
        note("child", {
          sourceAuthor: "Wei Liu",
          sourceInReplyToId: "parent",
          sourceReplyType: "R",
        }),
      ],
    } as unknown as DocumentModel;

    const { bytes } = await exportPdf(original, model);
    const { loaded, annots } = await annotationsOnFirstPage(bytes);

    const child = annots.find((d) => d.get(PDFName.of("IRT")));
    if (!child) throw new Error("expected the reply to carry /IRT");
    expect(String(child.get(PDFName.of("RT")))).toContain("R");

    // /IRT must resolve to the OTHER annotation on this page, not dangle.
    const irt = child.get(PDFName.of("IRT"));
    const parentDict = loaded.context.lookupMaybe(irt, PDFDict);
    expect(parentDict).toBeDefined();
    expect(String(parentDict!.get(PDFName.of("T")))).toContain("Jane Chen");
  });

  test("a popup is removed with the annotation it belonged to", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);

    const parent = PDFDict.withContext(doc.context);
    parent.set(PDFName.of("Type"), PDFName.of("Annot"));
    parent.set(PDFName.of("Subtype"), PDFName.of("Text"));
    parent.set(PDFName.of("Rect"), doc.context.obj([72, 700, 92, 720]));
    const parentRef = doc.context.register(parent);

    const popup = PDFDict.withContext(doc.context);
    popup.set(PDFName.of("Type"), PDFName.of("Annot"));
    popup.set(PDFName.of("Subtype"), PDFName.of("Popup"));
    popup.set(PDFName.of("Rect"), doc.context.obj([100, 640, 300, 720]));
    popup.set(PDFName.of("Parent"), parentRef);

    const annots = PDFArray.withContext(doc.context);
    annots.push(parentRef);
    annots.push(doc.context.register(popup));
    page.node.set(PDFName.of("Annots"), annots);
    const original = await doc.save();

    const model = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [note("n1")],
    } as unknown as DocumentModel;

    const { bytes } = await exportPdf(original, model);
    const { annots: after } = await annotationsOnFirstPage(bytes);
    const subtypes = after.map((d) => d.get(PDFName.of("Subtype"))?.toString());
    // The source Text was replaced by the overlay's own annotation; its popup
    // must not survive pointing at an object that no longer exists.
    expect(subtypes).not.toContain("/Popup");
  });
});
