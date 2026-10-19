import { describe, expect, test } from "bun:test";
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";
import type { PdfjsAnnotationSource as PDFDocumentProxy } from "./annotations";
import type { PageModel } from "../model/types";
import {
  NOTE_DEFAULT_HEIGHT_PT,
  NOTE_DEFAULT_WIDTH_PT,
} from "../model/note";
import {
  annotationToOverlay,
  importFileAnnotations,
  importPdfAnnotations,
  importedAnnotationOverlayId,
  parsePdfDateString,
} from "./annotations";

const page: PageModel = {
  id: "p1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 300,
  heightPt: 400,
};

const offsetPage: PageModel = {
  ...page,
  originXPt: 50,
  originYPt: 100,
};

const IMPORTED_AT = 1_700_000_000_000;

describe("PDF annotation import", () => {
  test("reports encrypted sources from the existing raw annotation scan", async () => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    const encrypt = PDFDict.withContext(source.context);
    encrypt.set(PDFName.of("Filter"), PDFName.of("Standard"));
    encrypt.set(PDFName.of("V"), PDFNumber.of(2));
    source.context.trailerInfo.Encrypt = source.context.register(encrypt);
    const bytes = await source.save();
    const proxy = {
      annotationStorage: { setValue: () => undefined },
      getPage: async () => ({ getAnnotations: async () => [] }),
    } as unknown as PDFDocumentProxy;
    let encrypted: boolean | null = null;

    await importPdfAnnotations(proxy, [page], bytes, IMPORTED_AT, {
      onSourceInfo: (info) => {
        encrypted = info.encrypted;
      },
    });

    expect(encrypted).toBe(true);
  });

  test("derives stable reopen IDs from bounded pdf.js annotation refs", () => {
    expect(importedAnnotationOverlayId({ id: "17R" }, page)).toBe(
      "pdf-annotation-0-17R",
    );
    expect(importedAnnotationOverlayId({ id: "17R" }, { ...page, sourceIndex: 1 }))
      .toBe("pdf-annotation-1-17R");
    expect(importedAnnotationOverlayId({ id: "has spaces" }, page)).toBeNull();
    expect(
      importedAnnotationOverlayId({ id: "17R" }, { ...page, sourceIndex: -1 }),
    ).toBeNull();
  });

  test("imports highlight quad points into overlay rects", () => {
    const overlay = annotationToOverlay(
      {
        annotationType: 9,
        rect: [10, 20, 110, 40],
        quadPoints: { 0: 10, 1: 40, 2: 110, 3: 40, 4: 10, 5: 20, 6: 110, 7: 20 },
        color: { 0: 255, 1: 230, 2: 51 },
        opacity: 0.5,
      },
      page,
      () => "h",
    );

    expect(overlay).toEqual({
      type: "highlight",
      id: "h",
      pageId: "p1",
      rects: [{ x: 10, y: 20, w: 100, h: 20 }],
      color: "#ffe633",
      opacity: 0.45,
    });
  });

  test("imports underline quad points into overlay rects", () => {
    const overlay = annotationToOverlay(
      {
        annotationType: 10,
        rect: [10, 20, 110, 40],
        quadPoints: [10, 40, 110, 40, 10, 20, 110, 20],
        color: [0.7, 0.1, 0.05],
      },
      page,
      () => "u",
    );

    expect(overlay).toEqual({
      type: "underline",
      id: "u",
      pageId: "p1",
      rects: [{ x: 10, y: 20, w: 100, h: 20 }],
      color: "#b31a0d",
      opacity: 1,
    });
  });

  test("imports strikeout quad points into overlay rects", () => {
    const overlay = annotationToOverlay(
      {
        subtype: "StrikeOut",
        rect: [10, 20, 110, 40],
        quadPoints: [10, 40, 110, 40, 10, 20, 110, 20],
        color: [0.7, 0.1, 0.05],
      },
      page,
      () => "s",
    );

    expect(overlay).toEqual({
      type: "strikethrough",
      id: "s",
      pageId: "p1",
      rects: [{ x: 10, y: 20, w: 100, h: 20 }],
      color: "#b31a0d",
      opacity: 1,
    });
  });

  test("preserves the original bands of overlapping Preview-style highlight quads", () => {
    const overlay = annotationToOverlay(
      {
        subtype: "Highlight",
        rect: [10, 20, 150, 42],
        quadPoints: [
          10, 40, 80, 40, 10, 20, 80, 20,
          75, 42, 150, 42, 75, 22, 150, 22,
        ],
        color: [1, 0.9, 0.2],
        opacity: 1,
      },
      page,
      () => "h",
    );

    expect(overlay).toEqual({
      type: "highlight",
      id: "h",
      pageId: "p1",
      rects: [{ x: 75, y: 22, w: 75, h: 20 }, { x: 10, y: 20, w: 70, h: 20 }],
      color: "#ffe633",
      opacity: 0.45,
    });
  });

  test("preserves lower imported highlight opacity below the cap", () => {
    const overlay = annotationToOverlay(
      {
        subtype: "Highlight",
        rect: [10, 20, 110, 40],
        quadPoints: [10, 40, 110, 40, 10, 20, 110, 20],
        opacity: 0.3,
      },
      page,
      () => "h",
    );

    expect(overlay).toMatchObject({
      type: "highlight",
      rects: [{ x: 10, y: 20, w: 100, h: 20 }],
      opacity: 0.3,
    });
  });

  test("imports sticky notes, ink, squares, and free text", () => {
    const ids = ["n", "i", "r", "t"];
    const makeId = () => ids.shift()!;

    expect(
      annotationToOverlay(
        {
          subtype: "Text",
          rect: [20, 298, 42, 320],
          contentsObj: { str: "note" },
          color: [255, 230, 51],
        },
        page,
        makeId,
        1234,
      ),
    ).toMatchObject({
      type: "note",
      id: "n",
      rect: {
        x: 20,
        y: 226,
        w: NOTE_DEFAULT_WIDTH_PT,
        h: NOTE_DEFAULT_HEIGHT_PT,
      },
      text: "note",
      createdAt: 1234,
      updatedAt: 1234,
    });

    expect(
      annotationToOverlay(
        {
          subtype: "Ink",
          inkLists: [{ 0: 100, 1: 100, 2: 150, 3: 120 }],
          borderStyle: { width: 3 },
          color: [0, 0, 255],
        },
        page,
        makeId,
      ),
    ).toMatchObject({
      type: "ink",
      id: "i",
      paths: [[{ x: 100, y: 100 }, { x: 150, y: 120 }]],
      width: 3,
      color: "#0000ff",
    });

    expect(
      annotationToOverlay(
        {
          subtype: "Square",
          rect: [50, 50, 90, 90],
          borderStyle: { width: 2 },
          color: [0, 255, 0],
        },
        page,
        makeId,
      ),
    ).toMatchObject({
      type: "rect",
      id: "r",
      rect: { x: 50, y: 50, w: 40, h: 40 },
      strokeWidth: 2,
      color: "#00ff00",
    });

    expect(
      annotationToOverlay(
        {
          subtype: "FreeText",
          rect: [20, 200, 180, 230],
          contentsObj: { str: "free" },
          defaultAppearanceData: {
            fontSize: 14,
            fontColor: [0, 0, 0],
          },
        },
        page,
        makeId,
      ),
    ).toMatchObject({
      type: "text",
      id: "t",
      text: "free",
      fontSize: 14,
      color: "#000000",
    });
  });

  test("imports Zapf Dingbats free text checks as stamp overlays", () => {
    const overlay = annotationToOverlay(
      {
        subtype: "FreeText",
        rect: [20, 200, 34, 214],
        contentsObj: { str: "✓" },
        defaultAppearanceData: {
          fontName: "SZapf",
          fontSize: 12,
          fontColor: [26, 24, 21],
        },
        color: [46, 125, 50],
        borderStyle: { width: 2.5 },
      },
      page,
      () => "s",
    );

    expect(overlay).toEqual({
      type: "stamp",
      id: "s",
      pageId: "p1",
      kind: "check",
      rect: { x: 20, y: 200, w: 14, h: 14 },
      color: "#2e7d32",
      strokeWidth: 2.5,
    });
  });

  test("recovers Shiori FreeText family, weight, and italic aliases", () => {
    expect(
      annotationToOverlay(
        {
          subtype: "FreeText",
          rect: [20, 200, 180, 230],
          contentsObj: { str: "styled" },
          defaultAppearanceData: {
            fontName: "STimesBI-123456",
            fontSize: 14,
            fontColor: [18, 52, 86],
          },
          textAlignment: 2,
        },
        page,
        () => "t",
      ),
    ).toMatchObject({
      type: "text",
      id: "t",
      bold: true,
      italic: true,
      align: "right",
      fontFamily: "serif",
      color: "#123456",
    });
  });

  test("ignores unknown rich-text CSS and falls back to PDF appearance", () => {
    const overlay = annotationToOverlay(
      {
        subtype: "FreeText",
        rect: [20, 200, 180, 230],
        contentsObj: { str: "untrusted style" },
        defaultAppearanceData: {
          fontName: "STimesBI-123456",
          fontSize: 14,
          fontColor: [18, 52, 86],
        },
        textAlignment: 1,
        richText: {
          html: {
            attributes: {
              style: {
                font: "italic bold 14pt url(javascript:alert(1))",
                fontFamily: "Papyrus, fantasy",
                fontWeight: "bolder",
                fontStyle: "expression(alert(1))",
                textAlign: "justify",
                backgroundImage: "url(javascript:alert(1))",
              },
            },
          },
        },
      },
      page,
      () => "t",
    );

    expect(overlay).toMatchObject({
      type: "text",
      id: "t",
      bold: true,
      italic: true,
      align: "center",
      fontFamily: "serif",
      color: "#123456",
    });
  });

  test("normalizes source annotations from non-zero page origins", () => {
    expect(
      annotationToOverlay(
        {
          subtype: "Highlight",
          quadPoints: [60, 140, 160, 140, 60, 120, 160, 120],
          color: [1, 0.9, 0.2],
        },
        offsetPage,
        () => "h",
      ),
    ).toMatchObject({
      type: "highlight",
      rects: [{ x: 10, y: 20, w: 100, h: 20 }],
    });

    expect(
      annotationToOverlay(
        {
          subtype: "Ink",
          inkLists: [{ 0: 60, 1: 120, 2: 80, 3: 145 }],
        },
        offsetPage,
        () => "i",
      ),
    ).toMatchObject({
      type: "ink",
      paths: [[{ x: 10, y: 20 }, { x: 30, y: 45 }]],
    });

    expect(
      annotationToOverlay(
        {
          subtype: "FreeText",
          rect: [70, 300, 170, 340],
          contentsObj: { str: "offset" },
        },
        offsetPage,
        () => "t",
      ),
    ).toMatchObject({
      type: "text",
      rect: { x: 20, y: 200, w: 100, h: 40 },
    });
  });

  test("uses default appearance font size when pdf.js cannot parse custom font", () => {
    const overlay = annotationToOverlay(
      {
        subtype: "FreeText",
        rect: [20, 200, 180, 230],
        contentsObj: { str: "中文批注" },
        defaultAppearance: "/SUni 7 Tf 0.1 0.1 0.1 rg",
        defaultAppearanceData: {
          fontName: "SUni",
          fontSize: 0,
          fontColor: [26, 24, 21],
        },
      },
      page,
      () => "t",
    );

    expect(overlay).toMatchObject({
      type: "text",
      id: "t",
      fontSize: 7,
    });
  });

  test("round-trips Shiori callout geometry once in offset page space", async () => {
    const fixture = await makeRawCalloutFixture({
      rect: [60, 120, 260, 220],
      differences: [100, 30, 10, 20],
      leader: [90, 145, 130, 165, 160, 165],
      shioLabel: [160, 140, 90, 50],
      shioTargets: [[70, 130, 40, 15]],
      shioLeader: [90, 145, 130, 165, 160, 165],
      shioLeaderKind: "Quadratic",
    });
    const overlays = await importPdfAnnotations(
      fixture.proxy,
      [offsetPage],
      fixture.bytes,
      IMPORTED_AT,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({
      type: "callout",
      id: `pdf-annotation-0-${fixture.pdfjsId}`,
      rect: { x: 110, y: 40, w: 90, h: 50 },
      targetRects: [{ x: 20, y: 30, w: 40, h: 15 }],
      leader: [
        { x: 40, y: 45 },
        { x: 80, y: 65 },
        { x: 110, y: 65 },
      ],
      leaderKind: "quadratic",
      text: "Callout text",
      fontSize: 12,
    });

    // A raw FreeText callout does NOT go through annotationToOverlay — it is
    // built by importRawCallout and pushed directly, from two separate loops.
    // Stamping inside annotationToOverlay therefore missed it entirely, and
    // a callout with no author or dates then read as the reader's own work.
    expect(overlays[0]).toMatchObject({
      origin: "imported",
      importedAt: IMPORTED_AT,
    });
  });

  test("joins Shio anchor provenance back onto imported overlays", async () => {
    const fixture = await makeAnchoredHighlightFixture({
      anchor: { Q: "the variance term σ²", Pg: 2, Occ: 3 },
    });
    const overlays = await importPdfAnnotations(
      fixture.proxy,
      [page],
      fixture.bytes,
    );
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.anchor).toEqual({
      quote: "the variance term σ²",
      page: 2,
      occurrence: 3,
    });
  });

  test("accepts anchors without an occurrence (in-app selection capture)", async () => {
    const fixture = await makeAnchoredHighlightFixture({
      anchor: { Q: "selected words", Pg: 1 },
    });
    const overlays = await importPdfAnnotations(
      fixture.proxy,
      [page],
      fixture.bytes,
    );
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.anchor).toEqual({ quote: "selected words", page: 1 });
    expect(overlays[0]?.anchor?.occurrence).toBeUndefined();
  });

  test("degrades malformed Shio anchors to no anchor instead of failing", async () => {
    const cases: Array<Record<string, unknown>> = [
      { Q: "quote", Pg: 0, Occ: 1 },
      { Q: "quote", Pg: 1, Occ: 0 },
      { Q: "", Pg: 1, Occ: 1 },
      { Q: "x".repeat(9000), Pg: 1, Occ: 1 },
    ];
    for (const anchor of cases) {
      const fixture = await makeAnchoredHighlightFixture({ anchor });
      const overlays = await importPdfAnnotations(
        fixture.proxy,
        [page],
        fixture.bytes,
      );
      expect(overlays).toHaveLength(1);
      expect(overlays[0]?.anchor).toBeUndefined();
    }
  });

  test("folds Shiori-exported /IRT replies back into the callout thread", async () => {
    const fixture = await makeThreadedCalloutFixture();
    const overlays = await importPdfAnnotations(
      fixture.proxy,
      [page],
      fixture.bytes,
    );

    // One callout, zero stray notes: both replies folded into the thread.
    expect(overlays).toHaveLength(1);
    const callout = overlays[0];
    if (callout?.type !== "callout") throw new Error("missing callout");
    expect(callout.thread).toEqual([
      {
        id: "turn-1",
        role: "agent",
        author: "Claude Code",
        text: "Agent turn",
        at: Date.UTC(2026, 6, 28, 3, 0, 0),
      },
      { id: "turn-2", role: "user", text: "User turn" },
    ]);
  });

  test("keeps an orphaned Shiori reply as a note when its callout is gone", async () => {
    const fixture = await makeThreadedCalloutFixture({ dropCallout: true });
    const overlays = await importPdfAnnotations(
      fixture.proxy,
      [page],
      fixture.bytes,
    );
    // No parent to fold into: content survives as standalone notes.
    expect(overlays).toHaveLength(2);
    expect(overlays.every((overlay) => overlay.type === "note")).toBe(true);
  });

  test("bounds imported annotation text and ink payloads", () => {
    const note = annotationToOverlay(
      {
        annotationType: 1,
        rect: [10, 20, 30, 40],
        contentsObj: { str: "x".repeat(100_000) },
      },
      page,
      () => "note",
    );
    expect(note?.type).toBe("note");
    expect(note?.type === "note" ? note.text.length : 0).toBeLessThanOrEqual(
      65_536,
    );

    const ink = annotationToOverlay(
      {
        annotationType: 15,
        rect: [0, 0, 100, 100],
        inkLists: [new Float64Array(200_002)],
      },
      page,
      () => "ink",
    );
    expect(ink).toBeNull();
  });

  test("prefers externally-edited standard geometry over stale Shio metadata", async () => {
    const fixture = await makeRawCalloutFixture({
      rect: [40, 40, 260, 200],
      differences: [140, 40, 20, 60],
      leader: [80, 80, 140, 110, 180, 130],
      shioLabel: [50, 50, 80, 40],
      shioTargets: [[52, 52, 30, 10]],
      shioLeader: [60, 60, 90, 75, 120, 80],
      shioLeaderKind: "Quadratic",
    });
    const overlays = await importPdfAnnotations(
      fixture.proxy,
      [page],
      fixture.bytes,
    );
    expect(overlays).toHaveLength(1);
    const overlay = overlays[0];
    expect(overlay).toMatchObject({
      type: "callout",
      rect: { x: 180, y: 100, w: 60, h: 60 },
      leader: [
        { x: 80, y: 80 },
        { x: 140, y: 110 },
        { x: 180, y: 130 },
      ],
      leaderKind: "polyline",
    });
    if (overlay?.type !== "callout") throw new Error("missing callout");
    expect(overlay.targetRects[0]?.x).toBeGreaterThan(70);
    expect(overlay.targetRects[0]?.x).toBeLessThan(80);
  });
});

type RawCalloutFixtureOptions = {
  rect: [number, number, number, number];
  differences: [number, number, number, number];
  leader: [number, number, number, number, number, number];
  shioLabel: [number, number, number, number];
  shioTargets: Array<[number, number, number, number]>;
  shioLeader: [number, number, number, number, number, number];
  shioLeaderKind: "Quadratic" | "Polyline";
};

describe("PDF date strings", () => {
  test("parses the full form with a timezone offset", () => {
    // 2026-03-14 09:30:00 at UTC+08:00 is 01:30 UTC.
    expect(parsePdfDateString("D:20260314093000+08'00'")).toBe(
      Date.UTC(2026, 2, 14, 1, 30, 0),
    );
  });

  test("treats Z and a missing offset as UTC", () => {
    const expected = Date.UTC(2026, 2, 14, 9, 30, 0);
    expect(parsePdfDateString("D:20260314093000Z")).toBe(expected);
    expect(parsePdfDateString("D:20260314093000")).toBe(expected);
  });

  test("accepts truncated dates real files actually contain", () => {
    expect(parsePdfDateString("D:2026")).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(parsePdfDateString("20260314")).toBe(Date.UTC(2026, 2, 14, 0, 0, 0));
  });

  test("gives up rather than inventing a date", () => {
    expect(parsePdfDateString(undefined)).toBeUndefined();
    expect(parsePdfDateString("")).toBeUndefined();
    expect(parsePdfDateString("not a date")).toBeUndefined();
    expect(parsePdfDateString("D:99")).toBeUndefined();
  });
});

describe("review provenance capture", () => {
  test("carries author, dates and reply link onto the overlay", () => {
    const overlay = annotationToOverlay(
      {
        id: "12R",
        subtype: "Text",
        rect: [72, 300, 96, 324],
        contentsObj: { str: "Please clarify" },
        titleObj: { str: "Jane Chen" },
        creationDate: "D:20260314093000Z",
        modificationDate: "D:20260315103000Z",
        inReplyTo: "9R",
        replyType: "R",
      },
      page,
      () => "overlay-1",
    );

    if (!overlay) throw new Error("expected an overlay");
    expect(overlay.sourceAuthor).toBe("Jane Chen");
    expect(overlay.sourceCreatedAt).toBe(Date.UTC(2026, 2, 14, 9, 30, 0));
    expect(overlay.sourceModifiedAt).toBe(Date.UTC(2026, 2, 15, 10, 30, 0));
    expect(overlay.sourceInReplyToId).toBe("pdf-annotation-0-9R");
    expect(overlay.sourceReplyType).toBe("R");
  });

  test("leaves provenance unset when the source carries none", () => {
    const overlay = annotationToOverlay(
      {
        id: "12R",
        subtype: "Text",
        rect: [72, 300, 96, 324],
        contentsObj: { str: "note" },
      },
      page,
      () => "overlay-1",
    );

    if (!overlay) throw new Error("expected an overlay");
    expect(overlay.sourceAuthor).toBeUndefined();
    expect(overlay.sourceCreatedAt).toBeUndefined();
    expect(overlay.sourceInReplyToId).toBeUndefined();
  });
});

describe("square interior colour", () => {
  test("imports /IC as the rectangle's fill", async () => {
    const pdf = await PDFDocument.create();
    const pdfPage = pdf.addPage([300, 400]);
    const context = pdf.context;
    const square = context.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [20, 20, 120, 100],
      C: [0.69, 0.23, 0.18],
      // Solid red interior — the thing pdf.js parses and then discards.
      IC: [1, 0, 0],
    });
    const ref = context.register(square);
    pdfPage.node.addAnnot(ref);
    const bytes = await pdf.save({ useObjectStreams: false });
    const pdfjsId = `${ref.objectNumber}R`;

    const proxy = {
      getPage: async () => ({
        getAnnotations: async () => [
          {
            id: pdfjsId,
            subtype: "Square",
            annotationType: 5,
            rect: [20, 20, 120, 100],
            color: [176, 59, 46],
            borderStyle: { width: 2 },
          },
        ],
      }),
    } as unknown as PDFDocumentProxy;

    const overlays = await importPdfAnnotations(proxy, [page], bytes);
    const rect = overlays.find((o) => o.type === "rect");
    if (!rect || rect.type !== "rect") throw new Error("expected a rect");
    expect(rect.fill).toBe("#ff0000");
  });

  test("a square with no /IC stays unfilled", async () => {
    const pdf = await PDFDocument.create();
    const pdfPage = pdf.addPage([300, 400]);
    const square = pdf.context.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [20, 20, 120, 100],
      C: [0.69, 0.23, 0.18],
    });
    const ref = pdf.context.register(square);
    pdfPage.node.addAnnot(ref);
    const bytes = await pdf.save({ useObjectStreams: false });

    const proxy = {
      getPage: async () => ({
        getAnnotations: async () => [
          {
            id: `${ref.objectNumber}R`,
            subtype: "Square",
            annotationType: 5,
            rect: [20, 20, 120, 100],
            color: [176, 59, 46],
            borderStyle: { width: 2 },
          },
        ],
      }),
    } as unknown as PDFDocumentProxy;

    const overlays = await importPdfAnnotations(proxy, [page], bytes);
    const rect = overlays.find((o) => o.type === "rect");
    if (!rect || rect.type !== "rect") throw new Error("expected a rect");
    expect(rect.fill).toBeNull();
  });
});

// The page canvas renders with AnnotationMode.ENABLE_STORAGE, so anything the
// importer does NOT flag here gets painted by pdf.js. Ownership must therefore
// be exact in both directions: flag too little and an imported annotation is
// drawn twice (flat bitmap + live overlay); flag too much and an annotation
// Shiori cannot edit disappears from the page even though export keeps it.
describe("annotation ownership", () => {
  // What the importer reports as Shiori's to draw, and so for the engine to
  // keep out of the page raster: the subtype and /Rect of each claimed one.
  async function importClaims(
    annotations: Array<Record<string, unknown>>,
  ): Promise<{ overlays: Awaited<ReturnType<typeof importFileAnnotations>>; claimed: string[] }> {
    const pdf = await PDFDocument.create();
    const pdfPage = pdf.addPage([300, 400]);
    pdfPage.node.set(
      PDFName.of("Annots"),
      pdf.context.obj(
        annotations.map((entries) => pdf.context.register(pdf.context.obj({ Type: "Annot", ...entries } as never))),
      ),
    );
    const bytes = await pdf.save({ useObjectStreams: false });
    const claimed: string[] = [];
    const overlays = await importFileAnnotations([page], bytes, undefined, {
      onSuppress: (_index, annotation) => claimed.push(`${annotation.subtype} ${annotation.rect.join(",")}`),
    });
    return { overlays, claimed };
  }

  test("claims what it imported, plus links and popups", async () => {
    const { overlays, claimed } = await importClaims([
      {
        Subtype: "Highlight",
        Rect: [20, 20, 120, 40],
        QuadPoints: [20, 40, 120, 40, 20, 20, 120, 20],
        C: [0.96, 0.84, 0.45],
      },
      { Subtype: "Link", Rect: [0, 0, 10, 10] },
      { Subtype: "Popup", Rect: [0, 0, 10, 10] },
    ]);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.type).toBe("highlight");
    expect(claimed).toEqual(["Highlight 20,20,120,40", "Link 0,0,10,10", "Popup 0,0,10,10"]);
  });

  test("leaves annotations it cannot edit to be drawn from their appearance", async () => {
    const { overlays, claimed } = await importClaims([
      { Subtype: "Circle", Rect: [20, 20, 120, 100] },
      { Subtype: "Line", Rect: [20, 20, 120, 100], L: [20, 20, 120, 100] },
      { Subtype: "Polygon", Rect: [20, 20, 120, 100], Vertices: [20, 20, 120, 20, 70, 100] },
      { Subtype: "Stamp", Rect: [20, 20, 120, 100] },
      { Subtype: "FileAttachment", Rect: [20, 20, 40, 40] },
      { Subtype: "Widget", FT: "Tx", Rect: [20, 20, 120, 40] },
    ]);
    expect(overlays).toEqual([]);
    expect(claimed).toEqual([]);
  });

  // An annotation whose geometry the importer rejects produces no overlay, so
  // it must stay drawn rather than being silently claimed and lost.
  test("does not claim a markup annotation it failed to import", async () => {
    const { overlays, claimed } = await importClaims([
      { Subtype: "Highlight", Rect: [20, 20, 120, 40], QuadPoints: [] },
    ]);
    expect(overlays).toEqual([]);
    expect(claimed).toEqual([]);
  });
});

// A real one-page PDF holding a Highlight annotation whose Shio dictionary
// carries anchor provenance, plus the matching pdf.js view of it. Exercises
// the raw-pass -> pdf.js join in importPdfAnnotations.
async function makeAnchoredHighlightFixture(options: {
  anchor: Record<string, unknown>;
}): Promise<{ bytes: Uint8Array; proxy: PDFDocumentProxy }> {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([300, 400]);
  const context = pdf.context;
  const annotation = context.obj({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [10, 20, 110, 40],
    QuadPoints: [10, 40, 110, 40, 10, 20, 110, 20],
    C: [1, 0.9, 0.2],
    CA: 0.35,
    Shio: context.obj({
      V: 1,
      Anchor: context.obj({
        ...options.anchor,
        ...(typeof options.anchor.Q === "string"
          ? { Q: PDFHexString.fromText(options.anchor.Q) }
          : {}),
      }),
    }),
  });
  const ref = context.register(annotation);
  pdfPage.node.addAnnot(ref);
  const bytes = await pdf.save({ useObjectStreams: false });
  const pdfjsId = `${ref.objectNumber}R`;
  const proxy = {
    getPage: async () => ({
      getAnnotations: async () => [
        {
          id: pdfjsId,
          annotationType: 9,
          rect: [10, 20, 110, 40],
          quadPoints: {
            0: 10, 1: 40, 2: 110, 3: 40, 4: 10, 5: 20, 6: 110, 7: 20,
          },
          color: { 0: 255, 1: 230, 2: 51 },
          opacity: 0.35,
        },
      ],
    }),
  } as unknown as PDFDocumentProxy;
  return { bytes, proxy };
}

// A callout plus two Shiori-exported /IRT Text replies (agent then user),
// mirroring what export writes. `dropCallout` removes the parent from BOTH
// passes (raw bytes keep the replies) to exercise the orphan fallback.
async function makeThreadedCalloutFixture(options?: {
  dropCallout?: boolean;
}): Promise<{ bytes: Uint8Array; proxy: PDFDocumentProxy }> {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([300, 400]);
  const context = pdf.context;

  const calloutDict = context.obj({
    Type: "Annot",
    Subtype: "FreeText",
    IT: "FreeTextCallout",
    Rect: [60, 120, 260, 220],
    RD: [100, 30, 10, 20],
    CL: [90, 145, 130, 165, 160, 165],
    LE: "OpenArrow",
    Contents: PDFHexString.fromText("Root question"),
    DA: PDFString.of("/Helv 12 Tf 0.69 0.23 0.18 rg"),
    Q: 0,
    C: [0.69, 0.23, 0.18],
    Shio: context.obj({
      V: 1,
      Kind: "Callout",
      LabelRect: [160, 140, 90, 50],
      TargetRects: [[70, 130, 40, 15]],
      Leader: [90, 145, 130, 165, 160, 165],
      LeaderKind: "Quadratic",
    }),
  });
  const calloutRef = context.register(calloutDict);
  const calloutId = `${calloutRef.objectNumber}R`;
  if (!options?.dropCallout) pdfPage.node.addAnnot(calloutRef);

  const reply = (
    replyId: string,
    role: "Agent" | "User",
    text: string,
    author?: string,
    date?: string,
  ) => {
    const dict = context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [160, 170, 180, 190],
      Contents: PDFHexString.fromText(text),
      Name: "Comment",
      F: 4,
      RT: "R",
      ...(author ? { T: PDFHexString.fromText(author) } : {}),
      ...(date ? { CreationDate: PDFString.of(date) } : {}),
      Shio: context.obj({
        V: 1,
        Kind: "Reply",
        Role: role,
        ReplyId: PDFString.of(replyId),
      }),
    });
    dict.set(PDFName.of("IRT"), calloutRef);
    const ref = context.register(dict);
    pdfPage.node.addAnnot(ref);
    return `${ref.objectNumber}R`;
  };
  const firstId = reply(
    "turn-1",
    "Agent",
    "Agent turn",
    "Claude Code",
    "D:20260728030000Z",
  );
  const secondId = reply("turn-2", "User", "User turn");

  const bytes = await pdf.save({ useObjectStreams: false });
  const pdfjsAnnotations: Record<string, unknown>[] = [
    ...(options?.dropCallout
      ? []
      : [
          {
            id: calloutId,
            subtype: "FreeText",
            rect: [60, 120, 260, 220],
            contentsObj: { str: "Root question" },
            defaultAppearanceData: {
              fontName: "SHelv",
              fontSize: 12,
              fontColor: [176, 59, 46],
            },
            textAlignment: 0,
          },
        ]),
    {
      id: firstId,
      annotationType: 1,
      rect: [160, 170, 180, 190],
      contentsObj: { str: "Agent turn" },
      titleObj: { str: "Claude Code" },
      creationDate: "D:20260728030000Z",
      inReplyTo: calloutId,
      replyType: "R",
    },
    {
      id: secondId,
      annotationType: 1,
      rect: [160, 170, 180, 190],
      contentsObj: { str: "User turn" },
      inReplyTo: calloutId,
      replyType: "R",
    },
  ];
  const proxy = {
    getPage: async () => ({
      getAnnotations: async () => pdfjsAnnotations,
    }),
  } as unknown as PDFDocumentProxy;
  return { bytes, proxy };
}

async function makeRawCalloutFixture(
  options: RawCalloutFixtureOptions,
): Promise<{ bytes: Uint8Array; proxy: PDFDocumentProxy; pdfjsId: string }> {
  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage([300, 400]);
  const context = pdf.context;
  const annotation = context.obj({
    Type: "Annot",
    Subtype: "FreeText",
    IT: "FreeTextCallout",
    Rect: options.rect,
    RD: options.differences,
    CL: options.leader,
    LE: "OpenArrow",
    Contents: PDFHexString.fromText("Callout text"),
    DA: PDFString.of("/Helv 12 Tf 0.69 0.23 0.18 rg"),
    Q: 0,
    C: [0.69, 0.23, 0.18],
    Shio: context.obj({
      V: 1,
      Kind: "Callout",
      LabelRect: options.shioLabel,
      TargetRects: options.shioTargets,
      Leader: options.shioLeader,
      LeaderKind: options.shioLeaderKind,
    }),
  });
  const ref = context.register(annotation);
  pdfPage.node.addAnnot(ref);
  const bytes = await pdf.save({ useObjectStreams: false });
  const pdfjsId = `${ref.objectNumber}R`;
  const proxy = {
    getPage: async () => ({
      getAnnotations: async () => [
        {
          id: pdfjsId,
          subtype: "FreeText",
          rect: options.rect,
          contentsObj: { str: "Callout text" },
          defaultAppearanceData: {
            fontName: "SHelv",
            fontSize: 12,
            fontColor: [176, 59, 46],
          },
          textAlignment: 0,
        },
      ],
    }),
  } as unknown as PDFDocumentProxy;
  return { bytes, proxy, pdfjsId };
}

describe("links with Named actions", () => {
  test("are read from the raw file for engines that cannot see them", async () => {
    const pdf = await PDFDocument.create();
    const pdfPage = pdf.addPage([300, 400]);
    const context = pdf.context;
    for (const annot of [
      { Rect: [10, 380, 60, 395], A: { S: "Named", N: "NextPage" } },
      { Rect: [70, 395, 120, 380], A: { S: "Named", N: "LastPage" } },
      // Not navigation Shiori follows, and not a Named action at all.
      { Rect: [0, 0, 5, 5], A: { S: "Named", N: "Print" } },
      { Rect: [0, 0, 5, 5], A: { S: "URI", URI: PDFString.of("https://x/") } },
    ]) {
      pdfPage.node.addAnnot(context.register(context.obj({ Type: "Annot", Subtype: "Link", ...annot })));
    }
    const bytes = await pdf.save({ useObjectStreams: false });
    const proxy = {
      getPage: async () => ({ getAnnotations: async () => [] }),
    } as unknown as PDFDocumentProxy;
    const reported: Array<[number, unknown]> = [];
    await importPdfAnnotations(proxy, [page], bytes, 0, {
      onNamedLinks: (sourceIndex, links) => reported.push([sourceIndex, links]),
    });
    expect(reported).toEqual([
      [
        0,
        [
          { rect: [10, 380, 60, 395], destination: null, url: null, action: "NextPage" },
          // A /Rect written top-down comes back normalized.
          { rect: [70, 380, 120, 395], destination: null, url: null, action: "LastPage" },
        ],
      ],
    ]);
  });
});

