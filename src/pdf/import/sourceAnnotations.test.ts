import { describe, expect, test } from "bun:test";
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  type PDFObject,
  type PDFRef,
} from "pdf-lib";
import type { PageModel } from "../model/types";
import { importFileAnnotations } from "./annotations";

// What the app imports from annotations it did not write: each expected
// overlay follows from the dictionary the test builds. The reader mirrors
// pdf.js 5.6's annotation.js (./sourceAnnotations.ts), so where PDF leaves a
// choice open (CMYK to RGB, a rect rounded to float32, a border too wide
// for its box) the expected value is pdf.js's; these values were checked
// against pdf.js's own import of the same files before pdf.js left the repo.

const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 300, heightPt: 400 };
const NOW = 1_700_000_000_000;
const imported = { origin: "imported", importedAt: NOW } as const;

/** The overlays imported from `bytes`, and each annotation claimed from the page raster. */
async function importFile(bytes: Uint8Array) {
  const reported: Array<{ subtype: string; rect: number[] }> = [];
  const overlays = await importFileAnnotations([page], bytes, NOW, {
    onSuppress: (_index, annotation) => reported.push(annotation),
  });
  return { overlays, reported };
}

async function onePage(build: (pdf: PDFDocument, add: (dict: Record<string, unknown>, direct?: boolean) => PDFRef | null) => void) {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([300, 400]);
  const annots: PDFObject[] = [];
  const add = (entries: Record<string, unknown>, direct = false) => {
    const dict = pdf.context.obj({ Type: "Annot", ...entries } as never);
    if (direct) {
      annots.push(dict);
      return null;
    }
    const ref = pdf.context.register(dict);
    annots.push(ref);
    return ref;
  };
  build(pdf, add);
  pdfPage.node.set(PDFName.of("Annots"), pdf.context.obj(annots as never) as PDFArray);
  return pdf.save({ useObjectStreams: false });
}

const utf16 = (text: string) => PDFHexString.fromText(text);

describe("the file annotation reader", () => {
  test("reads text markup: colours, quads, opacity, flags", async () => {
    const bytes = await onePage((_pdf, add) => {
      // A skewed quad, an RGB colour, an opacity and PDFDocEncoding text.
      add({
        Subtype: "Highlight", Rect: [18, 18, 122, 42], C: [0.2, 0.6, 1], CA: 0.3,
        QuadPoints: [20, 40, 120, 41, 21, 20, 119, 19], T: utf16("Réviseur 审阅"),
        Contents: PDFString.of("bullet \x80 dash \x85"), M: PDFString.of("D:20260925101500+08'00'"),
        CreationDate: PDFString.of("D:20260924"),
      });
      // CMYK, then gray, and a quad count pdf.js rejects (not shown).
      add({ Subtype: "Underline", Rect: [18, 58, 122, 82], C: [0.1, 0.7, 0.2, 0.05], QuadPoints: [20, 80, 120, 80, 20, 60, 120, 60] });
      add({ Subtype: "StrikeOut", Rect: [18, 98, 122, 122], C: [0.5], QuadPoints: [20, 120, 120, 120, 20, 100, 120, 100] });
      add({ Subtype: "Highlight", Rect: [18, 138, 122, 162], QuadPoints: [20, 160, 120, 160, 20, 140] });
      // Invisible is ignored for a known subtype; NoView hides.
      add({ Subtype: "Highlight", F: 1, Rect: [18, 178, 122, 202], QuadPoints: [20, 200, 120, 200, 20, 180, 120, 180] });
      add({ Subtype: "Highlight", F: 32, Rect: [18, 218, 122, 242], QuadPoints: [20, 240, 120, 240, 20, 220, 120, 220] });
      // A direct dictionary, which pdf.js names by its place on the page.
      add({ Subtype: "StrikeOut", Rect: [18, 258, 122, 282], QuadPoints: [20, 280, 120, 280, 20, 260, 120, 260] }, true);
    });
    const { overlays, reported } = await importFile(bytes);
    expect(overlays).toEqual([
      // The skewed quad's bounds; dates in UTC.
      {
        type: "highlight", id: "pdf-annotation-0-5R", pageId: "p1", rects: [{ x: 20, y: 19, w: 100, h: 22 }],
        color: "#3399ff", opacity: 0.3, comment: "bullet • dash –", sourceAuthor: "Réviseur 审阅",
        sourceCreatedAt: Date.UTC(2026, 8, 24), sourceModifiedAt: Date.UTC(2026, 8, 25, 2, 15), ...imported,
      },
      // pdf.js's CMYK conversion, not the naive (1 - c)(1 - k).
      { type: "underline", id: "pdf-annotation-0-6R", pageId: "p1", rects: [{ x: 20, y: 60, w: 100, h: 20 }], color: "#dd6791", opacity: 1, ...imported },
      { type: "strikethrough", id: "pdf-annotation-0-7R", pageId: "p1", rects: [{ x: 20, y: 100, w: 100, h: 20 }], color: "#808080", opacity: 1, ...imported },
      // 8R has a short quad list and 10R is NoView; 9R's Invisible flag is ignored.
      { type: "highlight", id: "pdf-annotation-0-9R", pageId: "p1", rects: [{ x: 20, y: 180, w: 100, h: 20 }], color: "#f4d674", opacity: 0.45, sourceFlags: 1, ...imported },
      { type: "strikethrough", id: "pdf-annotation-0-annot_p0_1", pageId: "p1", rects: [{ x: 20, y: 260, w: 100, h: 20 }], color: "#b13a2e", opacity: 1, ...imported },
    ]);
    // PDFium hides what Shiori claims by the file's own /Rect.
    expect(reported).toEqual([
      { subtype: "Highlight", rect: [18, 18, 122, 42] },
      { subtype: "Underline", rect: [18, 58, 122, 82] },
      { subtype: "StrikeOut", rect: [18, 98, 122, 122] },
      { subtype: "Highlight", rect: [18, 178, 122, 202] },
      { subtype: "StrikeOut", rect: [18, 258, 122, 282] },
    ]);
  });

  test("reads notes, replies, shapes and ink", async () => {
    const bytes = await onePage((_pdf, add) => {
      const parent = add({
        Subtype: "Text", Rect: [40, 300, 60, 320], C: [1, 0.8, 0], T: PDFString.of("Ann"),
        Contents: utf16("Parent note"), M: PDFString.of("D:20260101"),
      });
      // A group reply takes its parent's author, text, dates and colour.
      add({ Subtype: "Text", Rect: [70, 300, 90, 320], IRT: parent, RT: "Group", Contents: PDFString.of("ignored") });
      add({ Subtype: "Text", Rect: [100, 300, 120, 320], IRT: parent, Contents: PDFString.of("A reply") });
      // No appearance: pdf.js draws the square and rounds its rect to float32.
      add({ Subtype: "Square", Rect: [10.1, 20.3, 90.7, 80.9], C: [0, 0, 1], BS: { W: 3 }, IC: [1, 0, 0] });
      add({ Subtype: "Square", Rect: [110, 20, 190, 80], C: [0, 0, 1], Border: [0, 0, 2, [3, 0]] });
      add({ Subtype: "Square", Rect: [210, 20, 290, 80], Border: [0, 0, 5, [0, 0]] });
      // A border wider than half the rect falls back to 1; CA 0 stays 0, as PDFium draws it.
      add({ Subtype: "Ink", Rect: [10, 100, 60, 150], CA: 0, BS: { W: 50 }, InkList: [[12, 102, 30, 140, 58, 120], [15, 110, 16, 111]] });
      add({ Subtype: "Link", Rect: [200, 300, 250, 320], A: { S: "URI", URI: PDFString.of("https://example.com") } });
      const note = add({ Subtype: "Text", Rect: [150, 300, 170, 320], Contents: PDFString.of("with popup") });
      add({ Subtype: "Popup", Rect: [150, 200, 250, 280], Parent: note });
      add({ Subtype: "Widget", FT: "Tx", Rect: [10, 350, 100, 370] });
    });
    const { overlays, reported } = await importFile(bytes);
    // A note opens its 168 × 94 card down from the icon's top-left corner.
    const note = (id: string, x: number) => ({ id: `pdf-annotation-0-${id}`, pageId: "p1", type: "note", rect: { x, y: 226, w: 168, h: 94 }, createdAt: NOW, updatedAt: NOW });
    const parent = { text: "Parent note", color: "#ffcc00", sourceAuthor: "Ann", sourceModifiedAt: Date.UTC(2026, 0, 1) };
    expect(overlays).toEqual([
      { ...note("5R", 40), ...parent, ...imported },
      { ...note("6R", 70), ...parent, sourceInReplyToId: "pdf-annotation-0-5R", sourceReplyType: "Group", ...imported },
      { ...note("7R", 100), text: "A reply", color: "#f7e9a8", sourceInReplyToId: "pdf-annotation-0-5R", sourceReplyType: "R", ...imported },
      {
        type: "rect", id: "pdf-annotation-0-8R", pageId: "p1",
        rect: { x: Math.fround(10.1), y: Math.fround(20.3), w: Math.fround(90.7) - Math.fround(10.1), h: Math.fround(80.9) - Math.fround(20.3) },
        color: "#0000ff", strokeWidth: 3, fill: "#ff0000", ...imported,
      },
      { type: "rect", id: "pdf-annotation-0-9R", pageId: "p1", rect: { x: 110, y: 20, w: 80, h: 60 }, color: "#0000ff", strokeWidth: 2, fill: null, ...imported },
      // A dash array of zeros draws no border.
      { type: "rect", id: "pdf-annotation-0-10R", pageId: "p1", rect: { x: 210, y: 20, w: 80, h: 60 }, color: "#b13a2e", strokeWidth: 0, fill: null, ...imported },
      {
        type: "ink", id: "pdf-annotation-0-11R", pageId: "p1",
        paths: [[{ x: 12, y: 102 }, { x: 30, y: 140 }, { x: 58, y: 120 }], [{ x: 15, y: 110 }, { x: 16, y: 111 }]],
        color: "#b13a2e", width: 1, opacity: 0, ...imported,
      },
      { ...note("13R", 150), text: "with popup", color: "#f7e9a8", ...imported },
    ]);
    // Links and popups are claimed too (Shiori draws them); the form field is not.
    expect(reported.map((annotation) => annotation.subtype)).toEqual([
      "Text", "Text", "Text", "Square", "Square", "Square", "Ink", "Link", "Text", "Popup",
    ]);
    expect(reported[3]!.rect).toEqual([10.1, 20.3, 90.7, 80.9]);
  });

  test("reads free text size and colour from its appearance, else its /DA", async () => {
    const bytes = await onePage((pdf, add) => {
      const appearance = pdf.context.flateStream("q 0 0 1 rg BT 2 0 0 2 0 0 Tm /F1 9 Tf 5 5 Td (Big) Tj ET Q", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 40],
      });
      add({ Subtype: "FreeText", Rect: [20, 20, 120, 60], DA: PDFString.of("/Helv 11 Tf 1 0 0 rg"), Contents: PDFString.of("From AP"), AP: { N: pdf.context.register(appearance) } });
      add({ Subtype: "FreeText", Rect: [20, 80, 120, 120], DA: PDFString.of("/Helv 11 Tf 0 0.5 0 rg"), Contents: PDFString.of("From DA") });
      add({ Subtype: "FreeText", Rect: [20, 140, 60, 180], DA: PDFString.of("/ZapfDingbats 14 Tf 0 g"), Contents: utf16("✓") }, true);
      add({
        Subtype: "FreeText", Rect: [20, 200, 200, 240], DA: PDFString.of("/Helv 12 Tf 0 g"), Contents: PDFString.of("Styled"),
        RC: PDFString.of(
          '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" style="font:italic bold 12pt serif;font-family:serif;font-size:12pt;font-weight:bold;font-style:italic;text-align:center;direction:ltr;color:rgb(0,0,0)"><p dir="ltr">Styled</p></body>',
        ),
      });
    });
    const { overlays, reported } = await importFile(bytes);
    const text = (id: string, y: number, w: number) => ({ type: "text", id: `pdf-annotation-0-${id}`, pageId: "p1", rect: { x: 20, y, w, h: 40 } });
    expect(overlays).toEqual([
      // 9 pt under a 2× text matrix, blue, from the appearance stream.
      { ...text("6R", 20, 100), text: "From AP", fontSize: 18, color: "#0000ff", bold: false, align: "left", fontFamily: "sans", ...imported },
      { ...text("7R", 80, 100), text: "From DA", fontSize: 11, color: "#008000", bold: false, align: "left", fontFamily: "sans", ...imported },
      // A lone ZapfDingbats check mark is a stamp.
      {
        type: "stamp", id: "pdf-annotation-0-annot_p0_1", pageId: "p1", kind: "check",
        rect: { x: 20, y: 140, w: 40, h: 40 }, color: "#000000", strokeWidth: 0, ...imported,
      },
      { ...text("8R", 200, 180), text: "Styled", fontSize: 12, color: "#000000", bold: true, italic: true, align: "center", fontFamily: "serif", ...imported },
    ]);
    expect(reported.map((annotation) => annotation.subtype)).toEqual(["FreeText", "FreeText", "FreeText", "FreeText"]);
  });
});

describe("what other tools wrote, kept as written", () => {
  test("a direct /Annots square keeps its /IC fill", async () => {
    const bytes = await onePage((_pdf, add) => {
      add({ Subtype: "Square", Rect: [20, 20, 120, 100], C: [1, 0, 0], IC: [0, 0, 1] }, true);
    });
    const { overlays } = await importFile(bytes);
    expect(overlays).toMatchObject([{ type: "rect", id: "pdf-annotation-0-annot_p0_1", fill: "#0000ff" }]);
  });

  // Acrobat, on a /Rotate 90 page, writes a FreeText with /Rotate 90 and a
  // tall /Rect so its text reads upright: one 200 pt line, not a 30 pt column.
  test("a FreeText's own /Rotate turns its text box, not just the page", async () => {
    const bytes = await onePage((_pdf, add) => {
      add({ Subtype: "FreeText", Rect: [100, 100, 130, 300], Rotate: 90, DA: PDFString.of("/Helv 12 Tf 0 g"), Contents: PDFString.of("Upright") });
      add({ Subtype: "FreeText", Rect: [20, 20, 120, 60], Rotate: 180, DA: PDFString.of("/Helv 12 Tf 0 g"), Contents: PDFString.of("Flipped") });
    });
    const { overlays } = await importFile(bytes);
    expect(overlays).toMatchObject([
      { type: "text", text: "Upright", rect: { x: 15, y: 185, w: 200, h: 30 }, angle: 270 },
      { type: "text", text: "Flipped", rect: { x: 20, y: 20, w: 100, h: 40 }, angle: 180 },
    ]);
  });

  // Only a turn is read back as an angle (Shiori writes one); a matrix that
  // skews or scales unevenly leaves the box as its /Rect says.
  test("an appearance that skews is not taken for a turn", async () => {
    const bytes = await onePage((pdf, add) => {
      const skewed = pdf.context.register(pdf.context.flateStream("0 0 100 40 re S", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 40], Matrix: [1, 0.5, 0, 1, 0, 0],
      }));
      add({ Subtype: "Square", Rect: [20, 20, 120, 110], AP: { N: skewed } });
    });
    const { overlays } = await importFile(bytes);
    expect(overlays).toMatchObject([{ type: "rect", rect: { x: 20, y: 20, w: 100, h: 90 } }]);
    expect(overlays[0]).not.toHaveProperty("angle");
  });

  // PDFium counts a page tree leaf without /Type /Page; pdf-lib's getPages()
  // drops it, which shifted every later page's annotations up by one.
  test("a page without /Type keeps its place in the page order", async () => {
    const pdf = await PDFDocument.create();
    const pages = [0, 1, 2].map(() => pdf.addPage([300, 400]));
    pages[0]!.node.delete(PDFName.of("Type"));
    const annotate = (index: number, entries: Record<string, unknown>) =>
      pages[index]!.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(pdf.context.obj({ Type: "Annot", ...entries } as never))]));
    annotate(1, { Subtype: "Highlight", Rect: [20, 20, 120, 40], QuadPoints: [20, 40, 120, 40, 20, 20, 120, 20] });
    annotate(2, { Subtype: "Square", Rect: [20, 20, 120, 100], IC: [0, 0, 1] });
    const models = [0, 1, 2].map((sourceIndex) => ({ ...page, id: `p${sourceIndex}`, sourceIndex }));
    const claimed: number[] = [];
    const overlays = await importFileAnnotations(models, await pdf.save({ useObjectStreams: false }), NOW, {
      onSuppress: (sourceIndex) => claimed.push(sourceIndex),
    });
    expect(overlays).toMatchObject([{ type: "highlight", pageId: "p1" }, { type: "rect", pageId: "p2", fill: "#0000ff" }]);
    expect(claimed).toEqual([1, 2]);
  });

  // PDFium and pdf-lib both walk a /Pages node each time a /Kids lists it.
  test("a page subtree listed twice counts twice", async () => {
    const pdf = await PDFDocument.create();
    const [a, b, c] = [0, 1, 2].map(() => pdf.addPage([300, 400]));
    const root = pdf.catalog.Pages();
    const group = pdf.context.register(pdf.context.obj({ Type: "Pages", Kids: [a!.ref, b!.ref], Count: 2, Parent: pdf.catalog.get(PDFName.of("Pages")) } as never));
    a!.node.set(PDFName.of("Parent"), group);
    b!.node.set(PDFName.of("Parent"), group);
    root.set(PDFName.of("Kids"), pdf.context.obj([group, group, c!.ref]));
    root.set(PDFName.of("Count"), pdf.context.obj(5));
    c!.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Square", Rect: [20, 20, 120, 100], IC: [0, 0, 1] } as never))]));
    const models = [0, 1, 2, 3, 4].map((sourceIndex) => ({ ...page, id: `p${sourceIndex}`, sourceIndex }));
    const claimed: number[] = [];
    const overlays = await importFileAnnotations(models, await pdf.save({ useObjectStreams: false }), NOW, {
      onSuppress: (sourceIndex) => claimed.push(sourceIndex),
    });
    expect(overlays).toMatchObject([{ type: "rect", pageId: "p4", fill: "#0000ff" }]);
    expect(claimed).toEqual([4]);
  });

  test("an underline or strikeout keeps its /CA", async () => {
    const bytes = await onePage((_pdf, add) => {
      add({ Subtype: "Underline", Rect: [18, 18, 122, 42], CA: 0.5, QuadPoints: [20, 40, 120, 40, 20, 20, 120, 20] });
      add({ Subtype: "StrikeOut", Rect: [18, 58, 122, 82], CA: 0.25, QuadPoints: [20, 80, 120, 80, 20, 60, 120, 60] });
      add({ Subtype: "StrikeOut", Rect: [18, 98, 122, 122], CA: 0, QuadPoints: [20, 120, 120, 120, 20, 100, 120, 100] });
    });
    const { overlays } = await importFile(bytes);
    expect(overlays).toMatchObject([
      { type: "underline", opacity: 0.5 },
      { type: "strikethrough", opacity: 0.25 },
      { type: "strikethrough", opacity: 0 },
    ]);
  });

  // The listing hands colours over as bytes, so a channel of 1 is 1/255.
  test("a colour channel that comes to 1 of 255 stays dark", async () => {
    const bytes = await onePage((_pdf, add) => {
      add({ Subtype: "Underline", Rect: [18, 18, 122, 42], C: [1 / 255, 50 / 255, 100 / 255], QuadPoints: [20, 40, 120, 40, 20, 20, 120, 20] });
    });
    const { overlays } = await importFile(bytes);
    expect(overlays).toMatchObject([{ type: "underline", color: "#013264" }]);
  });
});
