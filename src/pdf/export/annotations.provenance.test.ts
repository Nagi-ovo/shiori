import { describe, expect, test } from "bun:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { exportPdf, type ExportMode } from "./exportPdf";
import { importFileAnnotations } from "../import/annotations";
import type { DocumentModel, Overlay } from "../model/types";

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

  function author(dict: PDFDict): string | undefined {
    return dict.lookupMaybe(PDFName.of("T"), PDFString, PDFHexString)?.decodeText();
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

    expect(author(target)).toBe("Jane Chen");
    expect(String(target.get(PDFName.of("CreationDate")))).toContain(
      "D:20260314093000Z",
    );
    expect(String(target.get(PDFName.of("M")))).toContain("D:20260314103000Z");
  });

  test("an author outside Latin-1, or with PDF string syntax, is written intact", async () => {
    const original = await PDFDocument.create().then(async (doc) => {
      doc.addPage([612, 792]);
      return doc.save();
    });
    const names = ["张三", "Łukasz O\u2019Brien", "Q\\A (draft"];
    const model = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: names.map((name, i) => note(`n${i}`, { sourceAuthor: name })),
    } as unknown as DocumentModel;

    const { bytes } = await exportPdf(original, model);
    const { annots } = await annotationsOnFirstPage(bytes);
    expect(annots.map(author)).toEqual(names);
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
    expect(author(parentDict!)).toBe("Jane Chen");
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

// Shiori rebuilds the annotations it imported and leaves every other one
// (Circle, Line, Stamp, Caret, ...) in the file as it was. A reply link
// between the two kinds has to survive the rebuild in both directions.
describe("reply links between rebuilt and kept annotations", () => {
  const page = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 };

  function annot(doc: PDFDocument, subtype: string, rect: number[], extra: Record<string, unknown> = {}) {
    return doc.context.register(
      doc.context.obj({ Type: "Annot", Subtype: subtype, Rect: rect, F: 4, ...extra }),
    );
  }

  async function sourcePdf(build: (doc: PDFDocument) => PDFRef[]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([612, 792]);
    pdfPage.node.set(PDFName.of("Annots"), doc.context.obj(build(doc)));
    return doc.save();
  }

  async function exportedAnnots(
    bytes: Uint8Array,
    edit: (overlays: Overlay[]) => Overlay[] = (overlays) => overlays,
    mode?: ExportMode,
  ) {
    const overlays = edit(await importFileAnnotations([page], bytes));
    const model = { pages: [page], overlays } as unknown as DocumentModel;
    const out = await exportPdf(bytes, model, mode ? { mode } : {});
    const loaded = await PDFDocument.load(out.bytes);
    const annots = loaded.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    const entries = annots.asArray().map((ref) => ({
      ref: ref as PDFRef,
      dict: loaded.context.lookup(ref, PDFDict),
    }));
    const bySubtype = (subtype: string) =>
      entries.find((e) => e.dict.get(PDFName.of("Subtype"))?.toString() === `/${subtype}`);
    return { loaded, entries, bySubtype };
  }

  test("a reply to a kept Circle still points at the Circle", async () => {
    const bytes = await sourcePdf((doc) => {
      const circle = annot(doc, "Circle", [100, 600, 200, 700]);
      const reply = annot(doc, "Text", [210, 680, 230, 700], {
        Contents: PDFHexString.fromText("Why circle this?"),
        IRT: circle,
        RT: "R",
      });
      return [circle, reply];
    });

    const { bySubtype } = await exportedAnnots(bytes);
    const circle = bySubtype("Circle");
    const reply = bySubtype("Text");
    expect(circle).toBeDefined();
    expect(reply?.dict.get(PDFName.of("IRT"))).toBe(circle!.ref);
    expect(reply?.dict.get(PDFName.of("RT"))?.toString()).toBe("/R");
    expect(circle!.dict.get(PDFName.of("Shio"))).toBeUndefined();
  });

  // Acrobat's Replace Text: a StrikeOut, and a Caret grouped to it by /IRT.
  const replaceText = () =>
    sourcePdf((doc) => {
      const strike = annot(doc, "StrikeOut", [100, 600, 200, 614], {
        QuadPoints: [100, 614, 200, 614, 100, 600, 200, 600],
        C: [1, 0, 0],
      });
      const caret = annot(doc, "Caret", [198, 598, 206, 610], { IRT: strike, RT: "Group" });
      return [strike, caret];
    });

  test("a kept Caret grouped to a StrikeOut follows the rebuilt StrikeOut", async () => {
    const { bySubtype } = await exportedAnnots(await replaceText());
    const strike = bySubtype("StrikeOut");
    const caret = bySubtype("Caret");
    expect(strike).toBeDefined();
    expect(caret?.dict.get(PDFName.of("IRT"))).toBe(strike!.ref);
    expect(caret?.dict.get(PDFName.of("RT"))?.toString()).toBe("/Group");
    expect(caret?.dict.get(PDFName.of("Shio"))).toBeUndefined();
  });

  test("a kept Caret whose StrikeOut was deleted points at nothing", async () => {
    const { bySubtype } = await exportedAnnots(await replaceText(), (overlays) =>
      overlays.filter((o) => o.type !== "strikethrough"),
    );
    const caret = bySubtype("Caret");
    expect(bySubtype("StrikeOut")).toBeUndefined();
    expect(caret?.dict.get(PDFName.of("IRT"))).toBeUndefined();
    expect(caret?.dict.get(PDFName.of("RT"))).toBeUndefined();
  });

  test("a flattened export leaves the kept Caret no dangling /IRT", async () => {
    const { loaded, bySubtype } = await exportedAnnots(await replaceText(), undefined, "flatten");
    const irt = bySubtype("Caret")?.dict.get(PDFName.of("IRT"));
    expect(irt === undefined || loaded.context.lookup(irt) instanceof PDFDict).toBe(true);
  });

  // Duplicate copies of a source page share its kept annotation objects, and
  // a duplicate carries none of the page's overlays. Moved before the
  // original, it is the first page attach sees.
  async function exportedWithDuplicateFirst(bytes: Uint8Array) {
    const overlays = await importFileAnnotations([page], bytes);
    const duplicate = { ...page, id: "dup" };
    const model = { pages: [duplicate, page], overlays } as unknown as DocumentModel;
    const loaded = await PDFDocument.load((await exportPdf(bytes, model)).bytes);
    const annots = loaded.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray);
    const entries = annots.asArray().map((ref) => ({
      ref: ref as PDFRef,
      dict: loaded.context.lookup(ref, PDFDict),
    }));
    return (subtype: string) =>
      entries.find((e) => e.dict.get(PDFName.of("Subtype"))?.toString() === `/${subtype}`);
  }

  test("a duplicate page before the original leaves the original's reply linked", async () => {
    const bytes = await sourcePdf((doc) => {
      const circle = annot(doc, "Circle", [100, 600, 200, 700]);
      const reply = annot(doc, "Text", [210, 680, 230, 700], { IRT: circle, RT: "R" });
      return [circle, reply];
    });
    const bySubtype = await exportedWithDuplicateFirst(bytes);
    expect(bySubtype("Text")?.dict.get(PDFName.of("IRT"))).toBe(bySubtype("Circle")!.ref);
  });

  test("a duplicate page before the original leaves the original's Caret grouped", async () => {
    const bySubtype = await exportedWithDuplicateFirst(await replaceText());
    expect(bySubtype("Caret")?.dict.get(PDFName.of("IRT"))).toBe(bySubtype("StrikeOut")!.ref);
  });

  // Each copy holds its own kept Caret, which points only at a StrikeOut on
  // its own page: here the duplicate after the original carries none.
  test("a duplicate page's kept Caret is its own, not grouped to the original's StrikeOut", async () => {
    const bytes = await replaceText();
    const overlays = await importFileAnnotations([page], bytes);
    const model = { pages: [page, { ...page, id: "dup" }], overlays } as unknown as DocumentModel;
    const loaded = await PDFDocument.load((await exportPdf(bytes, model)).bytes);
    const onPage = (index: number) =>
      loaded.getPage(index).node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((ref) => ({
        ref: ref as PDFRef,
        dict: loaded.context.lookup(ref, PDFDict),
      }));
    const subtype = (e: { dict: PDFDict }) => e.dict.get(PDFName.of("Subtype"))?.toString();
    const [original, duplicate] = [onPage(0), onPage(1)];
    const strike = original.find((e) => subtype(e) === "/StrikeOut")!;
    const caret = original.find((e) => subtype(e) === "/Caret")!;
    const copy = duplicate.find((e) => subtype(e) === "/Caret")!;
    expect(caret.dict.get(PDFName.of("IRT"))).toBe(strike.ref);
    expect(copy.dict.get(PDFName.of("IRT"))).toBeUndefined();
    expect(copy.dict.get(PDFName.of("Shio"))).toBeUndefined();
  });

  test("a kept Circle replying to a callout's thread reply still points at it", async () => {
    // A callout with one turn, exported by Shiori; then another tool adds a
    // Circle that replies to that turn's Text annotation.
    const blank = await PDFDocument.create().then((doc) => (doc.addPage([612, 792]), doc.save()));
    const callout = {
      id: "c1", type: "callout", pageId: "p1", targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
      rect: { x: 250, y: 620, w: 144, h: 54 }, text: "Why?", fontSize: 12, color: "#b13a2e",
      bold: false, align: "left", fontFamily: "sans",
      thread: [{ id: "turn-1", role: "user", text: "Because." }],
    };
    const shiori = { pages: [page], overlays: [callout] } as unknown as DocumentModel;
    const doc = await PDFDocument.load((await exportPdf(blank, shiori)).bytes);
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    const turn = annots.get(1);
    annots.push(annot(doc, "Circle", [100, 600, 200, 700], { IRT: turn, RT: "R" }));

    const { loaded, bySubtype } = await exportedAnnots(await doc.save());
    const irt = bySubtype("Circle")?.dict.get(PDFName.of("IRT"));
    const parent = irt ? loaded.context.lookupMaybe(irt, PDFDict) : undefined;
    const shio = parent?.lookupMaybe(PDFName.of("Shio"), PDFDict);
    expect(shio?.lookupMaybe(PDFName.of("ReplyId"), PDFString)?.decodeText()).toBe("turn-1");
  });

  test("a kept Circle replying to a thread reply that lost its callout still points at it", async () => {
    // A Shiori thread reply whose parent is no callout imports as a note.
    const bytes = await sourcePdf((doc) => {
      const line = annot(doc, "Line", [100, 500, 200, 520], { L: [100, 510, 200, 510] });
      const turn = annot(doc, "Text", [210, 680, 230, 700], {
        IRT: line, RT: "R", Shio: doc.context.obj({ V: 1, Kind: "Reply", ReplyId: PDFString.of("turn-1") }),
      });
      return [line, turn, annot(doc, "Circle", [100, 600, 200, 700], { IRT: turn, RT: "R" })];
    });
    const { bySubtype } = await exportedAnnots(bytes);
    expect(bySubtype("Circle")?.dict.get(PDFName.of("IRT"))).toBe(bySubtype("Text")!.ref);
  });

  test("a mark left by an earlier flattened export links nothing", async () => {
    // The flattened file's Caret still carries its mark, naming an object
    // number from the file it came from; here that number is a Highlight.
    const bytes = await sourcePdf((doc) => {
      const highlight = annot(doc, "Highlight", [100, 600, 200, 614], {
        QuadPoints: [100, 614, 200, 614, 100, 600, 200, 600],
      });
      const stale = doc.context.obj({
        IRT: PDFString.of(`pdf-annotation-0-${highlight.objectNumber}R`),
        RT: PDFName.of("Group"),
      });
      const caret = annot(doc, "Caret", [198, 598, 206, 610], {
        Shio: doc.context.obj({ V: 1, Rebuild: stale }),
      });
      return [highlight, caret];
    });

    const { bySubtype } = await exportedAnnots(bytes);
    const caret = bySubtype("Caret");
    expect(bySubtype("Highlight")).toBeDefined();
    expect(caret?.dict.get(PDFName.of("IRT"))).toBeUndefined();
    expect(caret?.dict.get(PDFName.of("Shio"))).toBeUndefined();
  });
});
