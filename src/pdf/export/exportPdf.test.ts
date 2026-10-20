import { describe, expect, test } from "bun:test";
import fontkit from "@pdf-lib/fontkit";
import {
  AFRelationship,
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
} from "pdf-lib";
import {
  assertExportIntegrity,
  ExportEncryptedSourceError,
  ExportIntegrityError,
  ExportSignedSourceError,
  exportMergeBase,
  exportPdf,
  preserveDocumentFilesInPdf,
  type ExportMode,
  type ExportOptions,
  type MergeBaseOptions,
} from "./exportPdf";
import { ExportPermissionError, type ExportSourceEncryption } from "./encryptedSource";
import type { DocumentModel } from "../model/types";

const unicodeFontUrl = new URL(
  "../../assets/fonts/NotoSansSC-Regular.otf",
  import.meta.url,
).href;
const unicodeJpFontUrl = new URL(
  "../../assets/fonts/NotoSansJP-Regular.otf",
  import.meta.url,
).href;

describe("PDF export", () => {
  test("exports Chinese text overlays in editable and flattened modes offline", async () => {
    const original = await makeOnePagePdf();
    for (const mode of ["annotations", "flatten"] satisfies ExportMode[]) {
      const { bytes } = await exportPdf(original, sampleModel(), {
        mode,
        unicodeFontUrl,
        requireUnicodeFont: true,
      });
      expect(bytes.byteLength).toBeGreaterThan(original.byteLength);
      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1);
    }
  });

  test("exports bundled Noto font family selections", async () => {
    const original = await makeOnePagePdf();
    const model = sampleModel();
    const overlay = model.overlays[0];
    if (!overlay || overlay.type !== "text") throw new Error("missing text overlay");
    overlay.text = "Noto font";
    overlay.fontFamily = "notoSansSc";
    for (const mode of ["annotations", "flatten"] satisfies ExportMode[]) {
      const { bytes, lostChars } = await exportPdf(original, model, {
        mode,
        unicodeFontUrl,
        requireUnicodeFont: true,
      });
      expect(lostChars).toBe(0);
      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1);
    }
  });

  test("routes explicit Noto Sans JP kanji without requiring SC font", async () => {
    const original = await makeOnePagePdf();
    const model = sampleModel();
    const overlay = model.overlays[0];
    if (!overlay || overlay.type !== "text") throw new Error("missing text overlay");
    overlay.text = "日本語";
    overlay.fontFamily = "notoSansJp";
    for (const mode of ["annotations", "flatten"] satisfies ExportMode[]) {
      const { bytes, lostChars } = await exportPdf(original, model, {
        mode,
        unicodeJpFontUrl,
        requireUnicodeFont: true,
      });
      expect(lostChars).toBe(0);
      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1);
    }
  });

  test("exports reordered page ranges without leaking filtered overlays", async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    source.addPage([612, 792]);
    const original = await source.save();
    const model: DocumentModel = {
      pages: [
        { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "kept",
          type: "rect",
          pageId: "p2",
          rect: { x: 20, y: 20, w: 100, h: 80 },
          color: "#b13a2e",
          strokeWidth: 2,
          fill: null,
        },
        {
          id: "filtered",
          type: "text",
          pageId: "p1",
          rect: { x: 20, y: 20, w: 100, h: 40 },
          text: "filtered out",
          fontSize: 12,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
        },
      ],
    };
    const { bytes } = await exportPdf(original, {
      pages: [model.pages[0]!],
      overlays: model.overlays,
    });
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  test("exports stamp overlays in editable and flattened modes", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "stamp",
          type: "stamp",
          pageId: "p1",
          kind: "check",
          rect: { x: 72, y: 650, w: 14, h: 14 },
          color: "#1a1815",
          strokeWidth: 1.8,
        },
      ],
    };

    for (const mode of ["annotations", "flatten"] satisfies ExportMode[]) {
      const { bytes } = await exportPdf(original, model, { mode });
      expect(bytes.byteLength).toBeGreaterThan(original.byteLength);
      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1);
      if (mode === "annotations") {
        expect(await firstAnnotationHasAppearance(bytes)).toBe(true);
      }
    }
  });

  test("exports content text edits as page content, not annotations", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "content-text",
          type: "contentText",
          pageId: "p1",
          rect: { x: 70, y: 646, w: 124, h: 26 },
          coverRects: [{ x: 72, y: 650, w: 120, h: 18 }],
          originalText: "Original",
          text: "Replacement",
          fontSize: 14,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
          backgroundColor: "#ff00ff",
        },
      ],
    };

    for (const mode of ["annotations", "flatten"] satisfies ExportMode[]) {
      const { bytes, lostChars } = await exportPdf(original, model, {
        mode,
        quality: "standard",
      });
      expect(lostChars).toBe(0);
      expect(bytes.byteLength).toBeGreaterThan(original.byteLength);
      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1);
      expect(await annotationCount(bytes)).toBe(0);
    }
  });

  test("content text edits excise the covered source glyphs from page content", async () => {
    // Source PDF with real embedded-font text ("Hi" at 12pt from x=72,
    // baseline 700) — the glyphs a contentText edit will cover.
    const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
    const src = await PDFDocument.create();
    src.registerFontkit(fontkit);
    const noto = await src.embedFont(fontBytes);
    const page = src.addPage([612, 792]);
    page.drawText("Hi", { x: 72, y: 700, size: 12, font: noto });
    const original = await src.save();

    const before = await pageContentOperators(original);
    const showHex = /<([0-9A-Fa-f]+)>\s*Tj/.exec(before)?.[1];
    if (!showHex) throw new Error("source PDF did not draw hex show text");

    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "edit",
          type: "contentText",
          pageId: "p1",
          rect: { x: 70, y: 692, w: 60, h: 24 },
          coverRects: [{ x: 65, y: 690, w: 40, h: 30 }],
          originalText: "Hi",
          text: "Bye",
          fontSize: 12,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
          backgroundColor: "#ff00ff",
        },
      ],
    };
    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "original",
    });
    const after = await pageContentOperators(bytes);
    // The covered glyphs' show op is gone, replaced by a pure-adjustment TJ
    // that preserves the advance; the replacement text is drawn separately.
    expect(after).not.toContain(`<${showHex}>`);
    expect(after).not.toContain("1 0 1 rg");
    expect(after).toMatch(/\[[-0-9. ]+\] TJ/);
    // Replacement text "Bye" is drawn separately (hex-encoded show string).
    expect(after).toContain("<427965> Tj");
  });

  test("content text keeps the cover fill when glyph redaction is dirty", async () => {
    const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
    const src = await PDFDocument.create();
    src.registerFontkit(fontkit);
    const noto = await src.embedFont(fontBytes);
    const page = src.addPage([612, 792]);
    page.drawText("Hi", { x: 72, y: 700, size: 12, font: noto });
    const original = await src.save();

    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "edit",
          type: "contentText",
          pageId: "p1",
          rect: { x: 70, y: 692, w: 60, h: 24 },
          coverRects: [{ x: 72, y: 690, w: 1, h: 30 }],
          originalText: "Hi",
          text: "Bye",
          fontSize: 12,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
          backgroundColor: "#ff00ff",
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "original",
    });

    expect(await pageContentOperators(bytes)).toContain("1 0 1 rg");
  });

  test("content text redraws with the source font when its glyphs suffice", async () => {
    const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
    const src = await PDFDocument.create();
    src.registerFontkit(fontkit);
    const noto = await src.embedFont(fontBytes); // full embed: all glyphs available
    const page = src.addPage([612, 792]);
    page.drawText("Hi", { x: 72, y: 700, size: 12, font: noto });
    const original = await src.save();

    const before = await pageContentOperators(original);
    const showHex = /<([0-9A-Fa-f]+)>\s*Tj/.exec(before)?.[1];
    if (!showHex) throw new Error("source PDF did not draw hex show text");

    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "edit",
          type: "contentText",
          pageId: "p1",
          rect: { x: 70, y: 692, w: 60, h: 24 },
          coverRects: [{ x: 65, y: 690, w: 40, h: 30 }],
          sourceBaselinesPt: [700],
          originalText: "Hi",
          text: "Bye",
          fontSize: 12,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
          backgroundColor: "#ff00ff",
        },
      ],
    };
    const { bytes, lostChars } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "original",
    });
    expect(lostChars).toBe(0);
    const after = await pageContentOperators(bytes);

    // The replacement is shown as the SOURCE font's glyph ids, at the exact
    // captured baseline — not via a bundled font (whose Helvetica encoding
    // of "Bye" would be <427965>).
    const kit = fontkit.create(new Uint8Array(fontBytes));
    const gidHex = Array.from("Bye")
      .map((ch) =>
        kit
          .glyphForCodePoint(ch.codePointAt(0)!)
          .id.toString(16)
          .padStart(4, "0"),
      )
      .join("")
      .toUpperCase();
    expect(after).toContain(`<${gidHex}> Tj`);
    expect(after).toContain("1 0 0 1 70 700 Tm");
    expect(after).not.toContain("<427965> Tj");
    expect(after).not.toContain(`<${showHex}>`);
    expect(after).not.toContain("1 0 1 rg");
  });

  test("content text uses the DOMINANT source font when the edit spans fonts", async () => {
    const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
    const src = await PDFDocument.create();
    src.registerFontkit(fontkit);
    // Two distinct font resources: a full embed (majority, can encode
    // anything) and a subset embed (minority — if dominance wrongly picked
    // it, encoding "Bye" would fail and the assertion below would catch the
    // bundled-font fallback instead).
    const main = await src.embedFont(fontBytes);
    const minor = await src.embedFont(fontBytes, { subset: true });
    const page = src.addPage([612, 792]);
    // One drawText call for both majority lines: pdf-lib registers a fresh
    // page resource name per drawText call, and dominance is counted by
    // resource name (as in real PDFs, where a writer reuses one resource
    // for a font across the page).
    page.drawText("Hi\nHi", { x: 72, y: 700, size: 12, font: main, lineHeight: 40 });
    page.drawText("Hi", { x: 72, y: 620, size: 12, font: minor });
    const original = await src.save();

    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "edit",
          type: "contentText",
          pageId: "p1",
          rect: { x: 70, y: 610, w: 60, h: 106 },
          coverRects: [
            { x: 65, y: 690, w: 40, h: 30 },
            { x: 65, y: 650, w: 40, h: 30 },
            { x: 65, y: 610, w: 40, h: 30 },
          ],
          sourceBaselinesPt: [700, 660, 620],
          originalText: "Hi\nHi\nHi",
          text: "Bye\nBye\nBye",
          fontSize: 12,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
          backgroundColor: "#ff00ff",
        },
      ],
    };
    const { bytes, lostChars } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "original",
    });
    expect(lostChars).toBe(0);
    const after = await pageContentOperators(bytes);

    // All three replacement lines drawn as the majority font's glyph ids.
    const kit = fontkit.create(new Uint8Array(fontBytes));
    const gidHex = Array.from("Bye")
      .map((ch) =>
        kit
          .glyphForCodePoint(ch.codePointAt(0)!)
          .id.toString(16)
          .padStart(4, "0"),
      )
      .join("")
      .toUpperCase();
    expect(after.split(`<${gidHex}> Tj`).length - 1).toBe(3);
    expect(after).toContain("1 0 0 1 70 700 Tm");
    expect(after).toContain("1 0 0 1 70 620 Tm");
    // Neither the bundled-font fallback nor a cover fill ran.
    expect(after).not.toContain("<427965> Tj");
  });

  test("paragraph edit: extra replacement lines continue at the source pitch", async () => {
    const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
    const src = await PDFDocument.create();
    src.registerFontkit(fontkit);
    const noto = await src.embedFont(fontBytes);
    const page = src.addPage([612, 792]);
    // A 3-line source paragraph at 40pt pitch, one font resource.
    page.drawText("Hi\nHi\nHi", { x: 72, y: 700, size: 12, font: noto, lineHeight: 40 });
    const original = await src.save();

    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "edit",
          type: "contentText",
          pageId: "p1",
          // The paragraph path's shape: one cover rect per source line,
          // exact per-line baselines, a rect tall enough for reflow, and a
          // replacement with MORE lines than the source — the 4th line must
          // extrapolate downward at the MEASURED pitch (40pt), not at the
          // fontSize-derived line height (12pt).
          rect: { x: 70, y: 560, w: 60, h: 156 },
          coverRects: [
            { x: 65, y: 690, w: 40, h: 30 },
            { x: 65, y: 650, w: 40, h: 30 },
            { x: 65, y: 610, w: 40, h: 30 },
          ],
          sourceBaselinesPt: [700, 660, 620],
          originalText: "Hi\nHi\nHi",
          text: "Bye\nBye\nBye\nBye",
          fontSize: 12,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
          backgroundColor: "#ff00ff",
        },
      ],
    };
    const { bytes, lostChars } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "original",
    });
    expect(lostChars).toBe(0);
    const after = await pageContentOperators(bytes);

    const kit = fontkit.create(new Uint8Array(fontBytes));
    const gid = (text: string) =>
      Array.from(text)
        .map((ch) =>
          kit
            .glyphForCodePoint(ch.codePointAt(0)!)
            .id.toString(16)
            .padStart(4, "0"),
        )
        .join("")
        .toUpperCase();
    // All four replacement lines in the source font, the fourth at the
    // extrapolated baseline 620 − 40 = 580.
    expect(after.split(`<${gid("Bye")}> Tj`).length - 1).toBe(4);
    for (const y of [700, 660, 620, 580]) {
      expect(after).toContain(`1 0 0 1 70 ${y} Tm`);
    }
    // The source glyphs are gone (true removal, not just covered).
    expect(after).not.toContain(gid("Hi"));
  });

  test("content text falls back to bundled fonts when the subset lacks glyphs", async () => {
    const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
    const src = await PDFDocument.create();
    src.registerFontkit(fontkit);
    // Subset embed: only the glyphs actually drawn ("Hi") survive, so the
    // replacement "Bye" cannot be encoded with the source font.
    const noto = await src.embedFont(fontBytes, { subset: true });
    const page = src.addPage([612, 792]);
    page.drawText("Hi", { x: 72, y: 700, size: 12, font: noto });
    const original = await src.save();

    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "edit",
          type: "contentText",
          pageId: "p1",
          rect: { x: 70, y: 692, w: 60, h: 24 },
          coverRects: [{ x: 65, y: 690, w: 40, h: 30 }],
          sourceBaselinesPt: [700],
          originalText: "Hi",
          text: "Bye",
          fontSize: 12,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
          backgroundColor: "#ff00ff",
        },
      ],
    };
    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "original",
    });

    // Bundled-font fallback: Helvetica-encoded "Bye".
    expect(await pageContentOperators(bytes)).toContain("<427965> Tj");
  });

  test("content text draws at the captured source baseline, not a rect-derived one", async () => {
    const original = await makeOnePagePdf();
    const baseline = 655.25;
    const overlayBase = {
      id: "content-text-baseline",
      type: "contentText",
      pageId: "p1",
      rect: { x: 70, y: 646, w: 124, h: 26 },
      coverRects: [{ x: 72, y: 650, w: 120, h: 18 }],
      originalText: "Original",
      text: "Replacement",
      fontSize: 14,
      color: "#1a1815",
      bold: false,
      align: "left" as const,
      fontFamily: "sans" as const,
      backgroundColor: "#ffffff",
    };
    const pages: DocumentModel["pages"] = [
      { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
    ];

    const { bytes: withBaseline } = await exportPdf(
      original,
      {
        pages,
        overlays: [{ ...overlayBase, sourceBaselinesPt: [baseline] }],
      },
      { mode: "annotations", quality: "original" },
    );
    // The text-matrix operator carries the stored baseline verbatim —
    // the replacement font's ascent must not shift it.
    expect(await pageContentOperators(withBaseline)).toContain(`${baseline} Tm`);

    // Legacy overlays (no captured baseline) keep the old rect-edge math.
    const { bytes: legacy } = await exportPdf(
      original,
      { pages, overlays: [{ ...overlayBase }] },
      { mode: "annotations", quality: "original" },
    );
    expect(await pageContentOperators(legacy)).not.toContain(`${baseline} Tm`);
  });

  test("exports inserted blank pages", async () => {
    const original = await makeOnePagePdf();
    const { bytes } = await exportPdf(original, {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        {
          id: "blank",
          sourceIndex: -1,
          rotation: 0,
          widthPt: 300,
          heightPt: 400,
          blank: true,
        },
      ],
      overlays: [],
    });

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(2);
    const blank = loaded.getPage(1);
    expect(blank.getWidth()).toBe(300);
    expect(blank.getHeight()).toBe(400);
  });

  test("uses object streams for smaller quality presets", async () => {
    const original = await makeOnePagePdf();
    const { bytes: full } = await exportPdf(original, sampleModel(), {
      mode: "annotations",
      quality: "original",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });
    for (const quality of ["standard", "compact"] as const) {
      const { bytes: subset } = await exportPdf(original, sampleModel(), {
        mode: "annotations",
        quality,
        unicodeFontUrl,
        requireUnicodeFont: true,
      });

      expect(subset.byteLength).toBeLessThan(full.byteLength);
    }
  });

  test("keeps editable Chinese text compact with an appearance stream", async () => {
    const original = await makeOnePagePdf();
    const { bytes } = await exportPdf(original, sampleModel(), {
      mode: "annotations",
      quality: "standard",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });

    expect(bytes.byteLength).toBeLessThan(100 * 1024);
    expect(await annotationCount(bytes)).toBe(1);
    expect(await firstAnnotationHasAppearance(bytes)).toBe(true);
  });

  test("exports highlights with editable quad points and appearance", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "hl",
          type: "highlight",
          pageId: "p1",
          rects: [{ x: 72, y: 650, w: 120, h: 20 }],
          color: "#f4d674",
          opacity: 0.45,
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "standard",
    });
    const annot = await firstAnnotation(bytes);
    expect(annot?.lookupMaybe(PDFName.of("AP"), PDFDict)).toBeTruthy();
    expect(quadPoints(annot!)).toEqual([72, 670, 192, 670, 72, 650, 192, 650]);
  });

  test("exports annotation geometry in source space for non-zero page origins", async () => {
    const original = await makeOffsetCropBoxPdf();
    const model: DocumentModel = {
      pages: [
        {
          id: "p1",
          sourceIndex: 0,
          rotation: 0,
          originXPt: 50,
          originYPt: 100,
          widthPt: 300,
          heightPt: 400,
        },
      ],
      overlays: [
        {
          id: "hl",
          type: "highlight",
          pageId: "p1",
          rects: [{ x: 10, y: 20, w: 100, h: 20 }],
          color: "#f4d674",
          opacity: 0.45,
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "standard",
    });
    const annot = await firstAnnotation(bytes);
    expect(rectArray(annot!)).toEqual([60, 120, 160, 140]);
    expect(quadPoints(annot!)).toEqual([60, 140, 160, 140, 60, 120, 160, 120]);
  });

  test("exports underlines with editable quad points and appearance", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "ul",
          type: "underline",
          pageId: "p1",
          rects: [{ x: 72, y: 650, w: 120, h: 20 }],
          color: "#b13a2e",
          opacity: 1,
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "standard",
    });
    const annot = await firstAnnotation(bytes);
    expect(annot?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText()).toBe(
      "Underline",
    );
    expect(annot?.lookupMaybe(PDFName.of("AP"), PDFDict)).toBeTruthy();
    expect(quadPoints(annot!)).toEqual([72, 670, 192, 670, 72, 650, 192, 650]);
  });

  test("exports strikethroughs with editable quad points and appearance", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "st",
          type: "strikethrough",
          pageId: "p1",
          rects: [{ x: 72, y: 650, w: 120, h: 20 }],
          color: "#b13a2e",
          opacity: 1,
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "standard",
    });
    const annot = await firstAnnotation(bytes);
    expect(annot?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText()).toBe(
      "StrikeOut",
    );
    expect(annot?.lookupMaybe(PDFName.of("AP"), PDFDict)).toBeTruthy();
    expect(quadPoints(annot!)).toEqual([72, 670, 192, 670, 72, 650, 192, 650]);
  });

  test("exports callouts as editable FreeTextCallout plus a static appearance", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "callout",
          type: "callout",
          pageId: "p1",
          targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
          rect: { x: 250, y: 620, w: 144, h: 54 },
          leader: [
            { x: 192, y: 660 },
            { x: 220, y: 647 },
            { x: 250, y: 647 },
          ],
          leaderKind: "quadratic",
          text: "Why this matters",
          fontSize: 12,
          color: "#b13a2e",
          bold: false,
          align: "left",
          fontFamily: "sans",
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, { mode: "annotations" });
    const annot = await firstAnnotation(bytes);
    expect(annot?.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText()).toBe(
      "FreeText",
    );
    expect(annot?.lookupMaybe(PDFName.of("IT"), PDFName)?.decodeText()).toBe(
      "FreeTextCallout",
    );
    expect(annot?.lookupMaybe(PDFName.of("LE"), PDFName)?.decodeText()).toBe(
      "OpenArrow",
    );
    expect(numberArray(annot!, "CL")).toEqual([192, 660, 220, 647, 250, 647]);
    expect(numberArray(annot!, "RD")).toHaveLength(4);
    const appearance = annot?.lookupMaybe(PDFName.of("AP"), PDFDict);
    expect(appearance?.get(PDFName.of("N"))).toBeTruthy();
    const shio = annot?.lookupMaybe(PDFName.of("Shio"), PDFDict);
    expect(shio?.lookupMaybe(PDFName.of("V"), PDFNumber)?.asNumber()).toBe(1);
    expect(
      shio?.lookupMaybe(PDFName.of("LeaderKind"), PDFName)?.decodeText(),
    ).toBe("Quadratic");
  });

  test("persists anchor provenance in the Shio dictionary", async () => {
    const original = await makeOnePagePdf();
    const anchor = { quote: "the variance term σ²", page: 1, occurrence: 2 };
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "hl-anchored",
          type: "highlight",
          pageId: "p1",
          rects: [{ x: 72, y: 650, w: 120, h: 20 }],
          color: "#f6c744",
          opacity: 0.35,
          anchor,
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "standard",
    });
    const annot = await firstAnnotation(bytes);
    const shio = annot?.lookupMaybe(PDFName.of("Shio"), PDFDict);
    expect(shio?.lookupMaybe(PDFName.of("V"), PDFNumber)?.asNumber()).toBe(1);
    const stored = shio?.lookupMaybe(PDFName.of("Anchor"), PDFDict);
    expect(
      stored
        ?.lookupMaybe(PDFName.of("Q"), PDFString, PDFHexString)
        ?.decodeText(),
    ).toBe(anchor.quote);
    expect(stored?.lookupMaybe(PDFName.of("Pg"), PDFNumber)?.asNumber()).toBe(1);
    expect(stored?.lookupMaybe(PDFName.of("Occ"), PDFNumber)?.asNumber()).toBe(2);
  });

  test("anchor provenance joins the callout Shio dictionary without displacing it", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "callout-anchored",
          type: "callout",
          pageId: "p1",
          targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
          rect: { x: 250, y: 620, w: 144, h: 54 },
          text: "Points at a quote",
          fontSize: 12,
          color: "#b13a2e",
          bold: false,
          align: "left",
          fontFamily: "sans",
          anchor: { quote: "brown fox", page: 1, occurrence: 1 },
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, { mode: "annotations" });
    const annot = await firstAnnotation(bytes);
    const shio = annot?.lookupMaybe(PDFName.of("Shio"), PDFDict);
    // The callout metadata must survive alongside the new Anchor entry.
    expect(shio?.lookupMaybe(PDFName.of("Kind"), PDFName)?.decodeText()).toBe(
      "Callout",
    );
    const stored = shio?.lookupMaybe(PDFName.of("Anchor"), PDFDict);
    expect(
      stored
        ?.lookupMaybe(PDFName.of("Q"), PDFString, PDFHexString)
        ?.decodeText(),
    ).toBe("brown fox");
    expect(stored?.lookupMaybe(PDFName.of("Occ"), PDFNumber)?.asNumber()).toBe(1);
  });

  test("exports callout threads as native /IRT Text replies in turn order", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "callout-thread",
          type: "callout",
          pageId: "p1",
          targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
          rect: { x: 250, y: 620, w: 144, h: 54 },
          text: "这两个方差是怎么来的？",
          fontSize: 12,
          color: "#b13a2e",
          bold: false,
          align: "left",
          fontFamily: "sans",
          thread: [
            {
              id: "turn-1",
              role: "agent",
              author: "Claude Code",
              text: "它们是方差的上下界。",
              at: Date.UTC(2026, 6, 28, 3, 0, 0),
            },
            { id: "turn-2", role: "user", text: "推导在哪？" },
          ],
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });
    const loaded = await PDFDocument.load(bytes);
    const annots = loaded.getPage(0).node.Annots();
    expect(annots?.size()).toBe(3);
    const parent = annots!.lookupMaybe(0, PDFDict)!;
    const first = annots!.lookupMaybe(1, PDFDict)!;
    const second = annots!.lookupMaybe(2, PDFDict)!;

    // Both replies are standard Text comments chained to the callout.
    for (const reply of [first, second]) {
      expect(
        reply.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText(),
      ).toBe("Text");
      expect(reply.lookupMaybe(PDFName.of("RT"), PDFName)?.decodeText()).toBe(
        "R",
      );
      expect(reply.get(PDFName.of("IRT"))).toEqual(annots!.get(0));
    }
    void parent;

    // Turn order, role, and authorship survive: the agent turn carries /T
    // and its Shio role; the user turn writes NO /T (no invented author).
    expect(
      first
        .lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString)
        ?.decodeText(),
    ).toBe("它们是方差的上下界。");
    expect(
      first.lookupMaybe(PDFName.of("T"), PDFString, PDFHexString)?.decodeText(),
    ).toBe("Claude Code");
    const firstShio = first.lookupMaybe(PDFName.of("Shio"), PDFDict);
    expect(
      firstShio?.lookupMaybe(PDFName.of("Kind"), PDFName)?.decodeText(),
    ).toBe("Reply");
    expect(
      firstShio?.lookupMaybe(PDFName.of("Role"), PDFName)?.decodeText(),
    ).toBe("Agent");
    expect(
      firstShio
        ?.lookupMaybe(PDFName.of("ReplyId"), PDFString, PDFHexString)
        ?.decodeText(),
    ).toBe("turn-1");
    expect(first.lookupMaybe(PDFName.of("CreationDate"), PDFString)).toBeTruthy();

    expect(second.get(PDFName.of("T"))).toBeUndefined();
    const secondShio = second.lookupMaybe(PDFName.of("Shio"), PDFDict);
    expect(
      secondShio?.lookupMaybe(PDFName.of("Role"), PDFName)?.decodeText(),
    ).toBe("User");
  });

  test("reports unsupported callout appearance glyphs without losing semantic text", async () => {
    const original = await makeOnePagePdf();
    const text = "العربية";
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [{
        id: "callout-arabic",
        type: "callout",
        pageId: "p1",
        targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
        rect: { x: 250, y: 620, w: 144, h: 54 },
        text,
        fontSize: 12,
        color: "#b13a2e",
        bold: false,
        align: "right",
        fontFamily: "sans",
      }],
    };

    const { bytes, lostChars } = await exportPdf(original, model, {
      mode: "annotations",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });
    const annot = await firstAnnotation(bytes);
    expect(lostChars).toBeGreaterThan(0);
    expect(
      annot?.lookup(PDFName.of("Contents"))?.decodeText(),
    ).toBe(text);
  });

  test("editable callout appearances fall back across JP and SC path fonts", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "mixed-callout",
          type: "callout",
          pageId: "p1",
          targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
          rect: { x: 250, y: 620, w: 144, h: 54 },
          text: "かな简",
          fontSize: 12,
          color: "#b13a2e",
          bold: false,
          align: "left",
          fontFamily: "notoSansJp",
        },
      ],
    };
    const options = {
      mode: "annotations" as const,
      unicodeFontUrl,
      unicodeJpFontUrl,
      requireUnicodeFont: true,
    };

    const mixed = await exportPdf(original, model, options);
    const mixedAppearance = await firstAnnotationAppearanceOperators(mixed.bytes);
    const callout = model.overlays[0];
    if (!callout || callout.type !== "callout") throw new Error("missing callout");
    callout.text = "かな?";
    const substituted = await exportPdf(original, model, options);

    expect(mixed.lostChars).toBe(0);
    expect(mixedAppearance).not.toBe(
      await firstAnnotationAppearanceOperators(substituted.bytes),
    );
  });

  test("a single rare Han callout can use the JP fallback for an SC primary", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [{
        id: "rare-han-callout",
        type: "callout",
        pageId: "p1",
        targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
        rect: { x: 250, y: 620, w: 144, h: 54 },
        text: "𠮷",
        fontSize: 12,
        color: "#b13a2e",
        bold: false,
        align: "left",
        fontFamily: "sans",
      }],
    };

    const result = await exportPdf(original, model, {
      mode: "annotations",
      unicodeFontUrl,
      unicodeJpFontUrl,
      requireUnicodeFont: true,
    });

    expect(result.lostChars).toBe(0);
  });

  test("re-exporting editable annotations does not duplicate annotations or fonts", async () => {
    const original = await makeOnePagePdf();
    const { bytes: first } = await exportPdf(original, sampleModel(), {
      mode: "annotations",
      quality: "standard",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });
    const { bytes: second } = await exportPdf(first, sampleModel(), {
      mode: "annotations",
      quality: "standard",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });
    const { bytes: third } = await exportPdf(second, sampleModel(), {
      mode: "annotations",
      quality: "standard",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });

    expect(await annotationCount(second)).toBe(1);
    expect(await annotationCount(third)).toBe(1);
    expect(second.byteLength).toBeLessThanOrEqual(first.byteLength + 2048);
    expect(third.byteLength).toBeLessThanOrEqual(first.byteLength + 2048);
  });

  test("none mode removes replaceable source annotations", async () => {
    const original = await makeOnePagePdf();
    const { bytes: annotated } = await exportPdf(original, sampleModel(), {
      mode: "annotations",
      quality: "standard",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });
    const { bytes: stripped } = await exportPdf(
      annotated,
      {
        pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
        overlays: [],
      },
      { mode: "none", quality: "standard" },
    );

    expect(await annotationCount(stripped)).toBe(0);
    expect(stripped.byteLength).toBeLessThan(20 * 1024);
  });

  test("returns original bytes when all annotations are deleted and pages are unchanged", async () => {
    const original = await makeOnePagePdf();
    const { bytes } = await exportPdf(
      original,
      {
        pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
        overlays: [],
      },
      { mode: "annotations", quality: "original" },
    );

    expect(bytes).toEqual(original);
  });

  test("does not skip export when pages changed even if overlays are empty", async () => {
    const source = await PDFDocument.create();
    source.addPage([200, 300]);
    source.addPage([400, 500]);
    const original = await source.save();

    const { bytes } = await exportPdf(
      original,
      {
        pages: [
          { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 400, heightPt: 500 },
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 200, heightPt: 300 },
        ],
        overlays: [],
      },
      { mode: "annotations" },
    );

    expect(bytes).not.toEqual(original);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPage(0).getWidth()).toBe(400);
    expect(loaded.getPage(1).getWidth()).toBe(200);
  });

  test("preserves outlines and named destinations across edited export", async () => {
    const original = await makeNavigationPdf();
    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "hl",
          type: "highlight",
          pageId: "p1",
          rects: [{ x: 72, y: 650, w: 120, h: 20 }],
          color: "#f4d674",
          opacity: 0.45,
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "standard",
    });
    const loaded = await PDFDocument.load(bytes);
    const pageTwoRef = loaded.getPage(1).ref.toString();

    const outlines = loaded.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    const firstOutline = outlines.lookup(PDFName.of("First"), PDFDict);
    const outlineDest = firstOutline.lookup(PDFName.of("Dest"), PDFArray);
    expect(outlineDest.get(0).toString()).toBe(pageTwoRef);

    const pageMode = loaded.catalog.lookupMaybe(PDFName.of("PageMode"), PDFName);
    expect(pageMode?.asString()).toBe("/UseOutlines");

    const namedDest = findNamedDestination(loaded, "sec2");
    expect(namedDest?.get(0).toString()).toBe(pageTwoRef);

    const dests = loaded.catalog.lookup(PDFName.of("Dests"), PDFDict);
    const figDest = dests.lookup(PDFName.of("fig2"), PDFArray);
    expect(figDest.get(0).toString()).toBe(pageTwoRef);

    const annot = await annotationOnPage(bytes, 0);
    const action = annot?.lookupMaybe(PDFName.of("A"), PDFDict);
    const actionDest = action?.lookupMaybe(PDFName.of("D"), PDFString);
    expect(actionDest?.decodeText()).toBe("sec2");
  });

  test("drops navigation targets whose pages were removed", async () => {
    const original = await makeNavigationPdf();
    const source = await PDFDocument.load(original);

    // Positive controls: the fixture really does contain every structure that
    // the partial export below must remove. This keeps the negative assertions
    // from passing forever against a fixture that never had navigation data.
    expect(source.catalog.get(PDFName.of("Outlines"))).toBeDefined();
    expect(findNamedDestination(source, "sec2")).toBeDefined();
    expect(
      source.catalog
        .lookup(PDFName.of("Dests"), PDFDict)
        .get(PDFName.of("fig2")),
    ).toBeDefined();
    expect(source.catalog.get(PDFName.of("PageMode"))).toBeDefined();

    const { bytes } = await exportPdf(
      original,
      {
        pages: [
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      { mode: "annotations", quality: "standard" },
    );
    const loaded = await PDFDocument.load(bytes);

    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.catalog.get(PDFName.of("Outlines"))).toBeUndefined();
    expect(findNamedDestination(loaded, "sec2")).toBeUndefined();
    expect(
      loaded.catalog
        .lookupMaybe(PDFName.of("Dests"), PDFDict)
        ?.get(PDFName.of("fig2")),
    ).toBeUndefined();
    expect(loaded.catalog.get(PDFName.of("PageMode"))).toBeUndefined();
    expect(await annotationOnPage(bytes, 0)).toBeUndefined();

    // A partial export that keeps the target page must still remap every
    // navigation shape to that page rather than dropping the catalog wholesale.
    const kept = await exportPdf(
      original,
      {
        pages: [
          { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      { mode: "annotations", quality: "standard" },
    );
    const keptLoaded = await PDFDocument.load(kept.bytes);
    const keptPageRef = keptLoaded.getPage(0).ref.toString();
    const keptOutlines = keptLoaded.catalog.lookup(
      PDFName.of("Outlines"),
      PDFDict,
    );
    const keptOutline = keptOutlines.lookup(PDFName.of("First"), PDFDict);
    expect(
      keptOutline.lookup(PDFName.of("Dest"), PDFArray).get(0).toString(),
    ).toBe(keptPageRef);
    expect(findNamedDestination(keptLoaded, "sec2")?.get(0).toString()).toBe(
      keptPageRef,
    );
    expect(
      keptLoaded.catalog
        .lookup(PDFName.of("Dests"), PDFDict)
        .lookup(PDFName.of("fig2"), PDFArray)
        .get(0)
        .toString(),
    ).toBe(keptPageRef);
    expect(
      keptLoaded.catalog.lookup(PDFName.of("PageMode"), PDFName).asString(),
    ).toBe("/UseOutlines");
  });

  test("remaps numeric page destinations in partial exports", async () => {
    const source = await PDFDocument.create();
    source.addPage([612, 792]);
    source.addPage([612, 792]);
    source.addPage([612, 792]);
    source.catalog.set(
      PDFName.of("OpenAction"),
      source.context.obj([PDFNumber.of(1), PDFName.of("Fit")]),
    );
    const original = await source.save({ useObjectStreams: false });

    const kept = await exportPdf(
      original,
      {
        pages: [
          { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      { mode: "annotations", quality: "standard" },
    );
    const keptLoaded = await PDFDocument.load(kept.bytes);
    expect(
      keptLoaded.catalog
        .lookup(PDFName.of("OpenAction"), PDFArray)
        .lookup(0, PDFNumber)
        .asNumber(),
    ).toBe(0);

    const removed = await exportPdf(
      original,
      {
        pages: [
          { id: "p3", sourceIndex: 2, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      { mode: "annotations", quality: "standard" },
    );
    const removedLoaded = await PDFDocument.load(removed.bytes);
    expect(removedLoaded.catalog.get(PDFName.of("OpenAction"))).toBeUndefined();
  });

  test("rewires outline siblings after removing a dead destination", async () => {
    const original = await makeMixedOutlinePdf();
    const source = await PDFDocument.load(original);
    const sourceOutlines = source.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    const removedSourceItem = sourceOutlines.lookup(PDFName.of("First"), PDFDict);
    expect(
      removedSourceItem.lookup(PDFName.of("Title"), PDFString).decodeText(),
    ).toBe("Removed section");
    expect(removedSourceItem.get(PDFName.of("Next"))).toBeDefined();

    const { bytes } = await exportPdf(
      original,
      {
        pages: [
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      { mode: "annotations", quality: "standard" },
    );
    const loaded = await PDFDocument.load(bytes);
    const outlines = loaded.catalog.lookup(PDFName.of("Outlines"), PDFDict);
    const firstRef = outlines.get(PDFName.of("First"));
    const lastRef = outlines.get(PDFName.of("Last"));
    const first = outlines.lookup(PDFName.of("First"), PDFDict);

    expect(firstRef?.toString()).toBe(lastRef?.toString());
    expect(first.lookup(PDFName.of("Title"), PDFString).decodeText()).toBe(
      "Retained section",
    );
    expect(first.get(PDFName.of("Prev"))).toBeUndefined();
    expect(first.get(PDFName.of("Next"))).toBeUndefined();
    expect(outlines.lookup(PDFName.of("Count"), PDFNumber).asNumber()).toBe(1);
    expect(
      first.lookup(PDFName.of("Dest"), PDFArray).get(0).toString(),
    ).toBe(loaded.getPage(0).ref.toString());
  });

  test("reports lostChars when flattened text contains unencodable characters", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "txt",
          type: "text",
          pageId: "p1",
          rect: { x: 72, y: 650, w: 220, h: 60 },
          text: "hello ☃ world",
          fontSize: 14,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
        },
      ],
    };
    const { lostChars } = await exportPdf(original, model, {
      mode: "flatten",
      quality: "standard",
    });
    expect(lostChars).toBeGreaterThan(0);
  });

  test("reports lostChars when path fonts miss a CJK glyph", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "txt",
          type: "text",
          pageId: "p1",
          rect: { x: 72, y: 650, w: 220, h: 60 },
          text: "unsupported 𡃁",
          fontSize: 14,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
        },
      ],
    };
    const { lostChars } = await exportPdf(original, model, {
      mode: "flatten",
      quality: "standard",
      unicodeFontUrl,
      unicodeJpFontUrl,
      requireUnicodeFont: true,
    });
    expect(lostChars).toBe(1);
  });

  test("reports zero lostChars when all characters are encodable", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [
        {
          id: "txt",
          type: "text",
          pageId: "p1",
          rect: { x: 72, y: 650, w: 220, h: 60 },
          text: "ASCII only text 123",
          fontSize: 14,
          color: "#1a1815",
          bold: false,
          align: "left",
          fontFamily: "sans",
        },
      ],
    };
    const { lostChars } = await exportPdf(original, model, {
      mode: "flatten",
      quality: "standard",
    });
    expect(lostChars).toBe(0);
  });

  test("loads the Unicode path font for flattened CJK sticky notes", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "note",
          type: "note",
          pageId: "p1",
          rect: { x: 72, y: 650, w: 180, h: 80 },
          text: "中文便签",
          color: "#f4d674",
        },
      ],
    };

    const { lostChars } = await exportPdf(original, model, {
      mode: "flatten",
      unicodeFontUrl,
      requireUnicodeFont: true,
    });
    expect(lostChars).toBe(0);
  });

  test("embeds identical image data once across repeated overlays", async () => {
    const original = await makeOnePagePdf();
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const image = (id: string, x: number) => ({
      id,
      type: "image" as const,
      pageId: "p1",
      rect: { x, y: 650, w: 40, h: 40 },
      dataUrl,
      mimeType: "image/png" as const,
    });
    const page = {
      id: "p1",
      sourceIndex: 0,
      rotation: 0 as const,
      widthPt: 612,
      heightPt: 792,
    };
    const one = await exportPdf(original, {
      pages: [page],
      overlays: [image("one", 72)],
    });
    const repeated = await exportPdf(original, {
      pages: [page],
      overlays: [image("one", 72), image("two", 132)],
    });

    expect(await imageObjectCount(repeated.bytes)).toBe(
      await imageObjectCount(one.bytes),
    );
  });

  test("none mode removes links, widgets, and unsupported annotations", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    const annots = PDFArray.withContext(source.context);
    for (const subtype of ["Link", "Widget", "Watermark"]) {
      const dict = PDFDict.withContext(source.context);
      dict.set(PDFName.of("Type"), PDFName.of("Annot"));
      dict.set(PDFName.of("Subtype"), PDFName.of(subtype));
      dict.set(PDFName.of("Rect"), source.context.obj([0, 0, 10, 10]));
      annots.push(source.context.register(dict));
    }
    page.node.set(PDFName.of("Annots"), annots);
    const original = await source.save();

    const { bytes } = await exportPdf(
      original,
      {
        pages: [
          {
            id: "p1",
            sourceIndex: 0,
            rotation: 0,
            widthPt: 612,
            heightPt: 792,
          },
        ],
        overlays: [],
      },
      { mode: "none", preserveSourceAnnotations: true },
    );
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPage(0).node.get(PDFName.of("Annots"))).toBeUndefined();
  });

  // Regression guard for appendIncomingPdf (src/App.tsx). It builds a merge
  // base by exporting the open document with no overlays; using mode "none"
  // there deleted /Annots wholesale, so pasting an image silently destroyed
  // every link and every filled form field in the document. Links never
  // enter the overlay model, so nothing in the app could restore them.
  test("the internal merge base keeps links and filled form fields", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    const field = source.getForm().createTextField("applicant.name");
    field.setText("Ada");
    field.addToPage(page, { x: 72, y: 700, width: 200, height: 20 });
    for (const subtype of ["Link", "Highlight"]) {
      const dict = PDFDict.withContext(source.context);
      dict.set(PDFName.of("Type"), PDFName.of("Annot"));
      dict.set(PDFName.of("Subtype"), PDFName.of(subtype));
      dict.set(PDFName.of("Rect"), source.context.obj([0, 0, 10, 10]));
      // Without /QuadPoints the importer is never handed the highlight,
      // so it is not the model's to replace and export keeps it — see
      // isReplaceableAnnotation. Give it one so this is a markup annotation
      // the overlay model really owns.
      if (subtype === "Highlight") {
        dict.set(
          PDFName.of("QuadPoints"),
          source.context.obj([0, 10, 10, 10, 0, 0, 10, 0]),
        );
      }
      page.node.addAnnot(source.context.register(dict));
    }
    const original = await source.save();

    const pages = [
      { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
    ] as unknown as DocumentModel["pages"];

    // A mode smuggled in through the wider ExportOptions must not survive at
    // runtime: types are erased, so the helper has to project its fields
    // rather than forward the object.
    const smuggled: ExportOptions = { mode: "none" };
    const { bytes: pollutedBytes } = await exportMergeBase(
      original,
      pages,
      smuggled as MergeBaseOptions,
    );
    const polluted = await PDFDocument.load(pollutedBytes);
    expect(
      polluted.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray),
    ).toBeDefined();

    const { bytes } = await exportMergeBase(original, pages);

    const loaded = await PDFDocument.load(bytes);
    expect(
      loaded
        .getForm()
        .getFields()
        .map((f) => f.getName()),
    ).toEqual(["applicant.name"]);
    const subtypes = (
      loaded.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray)?.asArray() ??
      []
    ).map((ref) =>
      String(loaded.context.lookup(ref, PDFDict).get(PDFName.of("Subtype"))),
    );
    expect(subtypes).toContain("/Link");
    expect(subtypes).toContain("/Widget");
    // The overlay model owns markup annotations and rewrites them, so the
    // source copy must still be stripped — otherwise they would double up.
    expect(subtypes).not.toContain("/Highlight");
  });

  test("flattened ink uses one continuous round-cap, round-join path", async () => {
    const original = await makeOnePagePdf();
    const { bytes } = await exportPdf(
      original,
      {
        pages: [
          {
            id: "p1",
            sourceIndex: 0,
            rotation: 0,
            widthPt: 612,
            heightPt: 792,
          },
        ],
        overlays: [
          {
            id: "ink",
            type: "ink",
            pageId: "p1",
            color: "#1a1815",
            width: 4,
            paths: [
              [
                { x: 10, y: 10 },
                { x: 20, y: 20 },
                { x: 30, y: 10 },
              ],
            ],
          },
        ],
      },
      { mode: "flatten" },
    );
    const operators = await pageContentOperators(bytes);
    expect(operators).toContain("1 J");
    expect(operators).toContain("1 j");
    expect((operators.match(/\nS\n/g) ?? []).length).toBe(1);
  });
});

async function makeOnePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

async function makeOffsetCropBoxPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.setCropBox(50, 100, 300, 400);
  return doc.save();
}

async function makeNavigationPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pageOne = doc.addPage([612, 792]);
  const pageTwo = doc.addPage([612, 792]);

  const outlineDest = doc.context.obj([pageTwo.ref, PDFName.of("XYZ"), null, 720, null]);
  const figDest = doc.context.obj([pageTwo.ref, PDFName.of("FitH"), 700]);

  const namesLeaf = PDFDict.withContext(doc.context);
  const namesArray = PDFArray.withContext(doc.context);
  namesArray.push(PDFString.of("sec2"));
  namesArray.push(outlineDest);
  namesLeaf.set(PDFName.of("Names"), namesArray);
  const namesRoot = PDFDict.withContext(doc.context);
  namesRoot.set(PDFName.of("Dests"), namesLeaf);
  doc.catalog.set(PDFName.of("Names"), namesRoot);

  const dests = PDFDict.withContext(doc.context);
  dests.set(PDFName.of("fig2"), figDest);
  doc.catalog.set(PDFName.of("Dests"), dests);

  const outlineRoot = PDFDict.withContext(doc.context);
  const outlineItem = PDFDict.withContext(doc.context);
  const outlineRootRef = doc.context.register(outlineRoot);
  const outlineItemRef = doc.context.register(outlineItem);
  outlineRoot.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlineRoot.set(PDFName.of("First"), outlineItemRef);
  outlineRoot.set(PDFName.of("Last"), outlineItemRef);
  outlineRoot.set(PDFName.of("Count"), PDFNumber.of(1));
  outlineItem.set(PDFName.of("Title"), PDFString.of("Methods"));
  outlineItem.set(PDFName.of("Parent"), outlineRootRef);
  outlineItem.set(PDFName.of("Dest"), outlineDest);
  doc.catalog.set(PDFName.of("Outlines"), outlineRootRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  const action = PDFDict.withContext(doc.context);
  action.set(PDFName.of("S"), PDFName.of("GoTo"));
  action.set(PDFName.of("D"), PDFString.of("sec2"));
  const annot = PDFDict.withContext(doc.context);
  annot.set(PDFName.of("Type"), PDFName.of("Annot"));
  annot.set(PDFName.of("Subtype"), PDFName.of("Link"));
  annot.set(PDFName.of("Rect"), doc.context.obj([72, 700, 120, 712]));
  annot.set(PDFName.of("Border"), doc.context.obj([0, 0, 0]));
  annot.set(PDFName.of("A"), action);
  const annots = pageOne.node.Annots() ?? PDFArray.withContext(doc.context);
  if (!pageOne.node.Annots()) pageOne.node.set(PDFName.of("Annots"), annots);
  annots.push(doc.context.register(annot));

  return doc.save();
}

async function makeMixedOutlinePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const retainedPage = doc.addPage([612, 792]);
  const removedPage = doc.addPage([612, 792]);
  const root = PDFDict.withContext(doc.context);
  const removedItem = PDFDict.withContext(doc.context);
  const retainedItem = PDFDict.withContext(doc.context);
  const rootRef = doc.context.register(root);
  const removedRef = doc.context.register(removedItem);
  const retainedRef = doc.context.register(retainedItem);

  root.set(PDFName.of("Type"), PDFName.of("Outlines"));
  root.set(PDFName.of("First"), removedRef);
  root.set(PDFName.of("Last"), retainedRef);
  root.set(PDFName.of("Count"), PDFNumber.of(2));
  removedItem.set(PDFName.of("Title"), PDFString.of("Removed section"));
  removedItem.set(PDFName.of("Parent"), rootRef);
  removedItem.set(PDFName.of("Next"), retainedRef);
  removedItem.set(
    PDFName.of("Dest"),
    doc.context.obj([removedPage.ref, PDFName.of("Fit")]),
  );
  retainedItem.set(PDFName.of("Title"), PDFString.of("Retained section"));
  retainedItem.set(PDFName.of("Parent"), rootRef);
  retainedItem.set(PDFName.of("Prev"), removedRef);
  retainedItem.set(
    PDFName.of("Dest"),
    doc.context.obj([retainedPage.ref, PDFName.of("Fit")]),
  );
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  return doc.save();
}

function sampleModel(): DocumentModel {
  return {
    pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
    overlays: [
      {
        id: "txt",
        type: "text",
        pageId: "p1",
        rect: { x: 72, y: 650, w: 220, h: 60 },
        text: "中文批注",
        fontSize: 18,
        color: "#1a1815",
        bold: false,
        align: "left",
        fontFamily: "sans",
      },
    ],
  };
}

async function annotationCount(bytes: Uint8Array): Promise<number> {
  const loaded = await PDFDocument.load(bytes);
  return loaded.getPage(0).node.Annots()?.size() ?? 0;
}

async function firstAnnotationHasAppearance(bytes: Uint8Array): Promise<boolean> {
  const annot = await firstAnnotation(bytes);
  return Boolean(annot?.lookupMaybe(PDFName.of("AP"), PDFDict));
}

async function firstAnnotation(bytes: Uint8Array): Promise<PDFDict | undefined> {
  const loaded = await PDFDocument.load(bytes);
  const annots = loaded.getPage(0).node.Annots();
  return annots?.lookupMaybe(0, PDFDict);
}

async function firstAnnotationAppearanceOperators(
  bytes: Uint8Array,
): Promise<string> {
  const annot = await firstAnnotation(bytes);
  const appearance = annot?.lookupMaybe(PDFName.of("AP"), PDFDict);
  const stream = appearance?.lookupMaybe(PDFName.of("N"), PDFRawStream);
  if (!stream) throw new Error("missing annotation appearance");
  const data = stream.dict.get(PDFName.of("Filter"))
    ? decodePDFRawStream(stream).decode()
    : stream.getContents();
  return new TextDecoder("latin1").decode(data);
}

async function annotationOnPage(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<PDFDict | undefined> {
  const loaded = await PDFDocument.load(bytes);
  const annots = loaded.getPage(pageIndex).node.Annots();
  return annots?.lookupMaybe(0, PDFDict);
}

// Decoded content-stream text of page 0, for asserting on raw operators.
async function pageContentOperators(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  const push = (candidate: unknown) => {
    if (candidate instanceof PDFRawStream) streams.push(candidate);
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      push(doc.context.lookup(contents.get(i)));
    }
  } else {
    push(contents instanceof PDFRawStream ? contents : doc.context.lookup(contents));
  }
  return streams
    .map((stream) => {
      const data = stream.dict.get(PDFName.of("Filter"))
        ? decodePDFRawStream(stream).decode()
        : stream.getContents();
      return new TextDecoder("latin1").decode(data);
    })
    .join("\n");
}

async function imageObjectCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") {
      count += 1;
    }
  }
  return count;
}

function findNamedDestination(
  doc: PDFDocument,
  name: string,
): PDFArray | undefined {
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const dests = names?.lookupMaybe(PDFName.of("Dests"), PDFDict);
  if (!dests) return undefined;
  return findInNameTree(dests, name);
}

function findInNameTree(tree: PDFDict, name: string): PDFArray | undefined {
  const names = tree.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (names) {
    for (let i = 0; i < names.size() - 1; i += 2) {
      const key = names.lookupMaybe(i, PDFString);
      if (key?.decodeText() === name) {
        return names.lookupMaybe(i + 1, PDFArray);
      }
    }
  }
  const kids = tree.lookupMaybe(PDFName.of("Kids"), PDFArray);
  if (!kids) return undefined;
  for (let i = 0; i < kids.size(); i++) {
    const child = kids.lookupMaybe(i, PDFDict);
    if (!child) continue;
    const found = findInNameTree(child, name);
    if (found) return found;
  }
  return undefined;
}

function quadPoints(annot: PDFDict): number[] {
  const quads = annot.lookup(PDFName.of("QuadPoints"), PDFArray);
  const out: number[] = [];
  for (let i = 0; i < quads.size(); i++) {
    out.push(quads.lookup(i, PDFNumber).asNumber());
  }
  return out;
}

function rectArray(annot: PDFDict): number[] {
  const rect = annot.lookup(PDFName.of("Rect"), PDFArray);
  const out: number[] = [];
  for (let i = 0; i < rect.size(); i++) {
    out.push(rect.lookup(i, PDFNumber).asNumber());
  }
  return out;
}

function numberArray(dict: PDFDict, key: string): number[] {
  const array = dict.lookup(PDFName.of(key), PDFArray);
  const values: number[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    values.push(array.lookup(index, PDFNumber).asNumber());
  }
  return values;
}

describe("catalog and metadata preservation", () => {
  // A two-page doc whose page 1 carries both destination shapes seen in the
  // wild: a direct /Dest array and a GoTo action's /D array, each naming the
  // target page by object reference rather than by name.
  async function makeDirectLinkPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const pageOne = doc.addPage([612, 792]);
    const pageTwo = doc.addPage([612, 792]);

    const destLink = PDFDict.withContext(doc.context);
    destLink.set(PDFName.of("Type"), PDFName.of("Annot"));
    destLink.set(PDFName.of("Subtype"), PDFName.of("Link"));
    destLink.set(
      PDFName.of("Rect"),
      doc.context.obj([72, 700, 300, 720]),
    );
    destLink.set(
      PDFName.of("Dest"),
      doc.context.obj([pageTwo.ref, PDFName.of("XYZ"), null, 720, null]),
    );

    const action = PDFDict.withContext(doc.context);
    action.set(PDFName.of("S"), PDFName.of("GoTo"));
    action.set(
      PDFName.of("D"),
      doc.context.obj([pageTwo.ref, PDFName.of("Fit")]),
    );
    const actionLink = PDFDict.withContext(doc.context);
    actionLink.set(PDFName.of("Type"), PDFName.of("Annot"));
    actionLink.set(PDFName.of("Subtype"), PDFName.of("Link"));
    actionLink.set(PDFName.of("Rect"), doc.context.obj([72, 660, 300, 680]));
    actionLink.set(PDFName.of("A"), doc.context.register(action));

    const annots = PDFArray.withContext(doc.context);
    annots.push(doc.context.register(destLink));
    annots.push(doc.context.register(actionLink));
    pageOne.node.set(PDFName.of("Annots"), annots);

    return doc.save();
  }

  // A highlight, not the Chinese text overlay from sampleModel(): these tests
  // are about catalog structure, and a text overlay would drag in the external
  // CJK font the other suites configure.
  function highlightOn(pageId: string) {
    return {
      id: `hl-${pageId}`,
      type: "highlight" as const,
      pageId,
      rects: [{ x: 72, y: 500, w: 200, h: 14 }],
      color: "#f4d674",
      opacity: 1,
    };
  }

  function modelForPages(sourceIndices: number[]): DocumentModel {
    const pages = sourceIndices.map((sourceIndex, i) => ({
      id: `p${i + 1}`,
      sourceIndex,
      rotation: 0 as const,
      widthPt: 612,
      heightPt: 792,
    }));
    return {
      pages,
      overlays: [highlightOn(pages[0]!.id)],
    } as unknown as DocumentModel;
  }

  function twoPageModel(): DocumentModel {
    return modelForPages([0, 1]);
  }

  function uneditedModelForPages(sourceIndices: number[]): DocumentModel {
    return { ...modelForPages(sourceIndices), overlays: [] };
  }

  function registerEmbeddedFile(
    doc: PDFDocument,
    payload: string,
    fileName: string,
  ): PDFRef {
    const bytes = new TextEncoder().encode(payload);
    const stream = doc.context.flateStream(bytes, {
      Type: "EmbeddedFile",
      Subtype: "text/plain",
      Params: { Size: bytes.byteLength },
    });
    const streamRef = doc.context.register(stream);
    return doc.context.register(
      doc.context.obj({
        Type: "Filespec",
        F: PDFString.of(fileName),
        UF: PDFHexString.fromText(fileName),
        EF: { F: streamRef },
        AFRelationship: "Data",
      }),
    );
  }

  async function makePageOnlyAttachmentPdf(options: {
    indirectSubtype?: boolean;
    pageAssociation?: boolean;
    twoPages?: boolean;
  } = {}) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    if (options.twoPages) doc.addPage([612, 792]);
    const fileSpec = registerEmbeddedFile(
      doc,
      "PAGE-ONLY-SECRET",
      "page-only.txt",
    );
    const annotation = PDFDict.withContext(doc.context);
    annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
    annotation.set(
      PDFName.of("Subtype"),
      options.indirectSubtype
        ? doc.context.register(PDFName.of("FileAttachment"))
        : PDFName.of("FileAttachment"),
    );
    annotation.set(PDFName.of("Rect"), doc.context.obj([72, 700, 92, 720]));
    annotation.set(PDFName.of("FS"), fileSpec);
    page.node.addAnnot(doc.context.register(annotation));
    if (options.pageAssociation) {
      page.node.set(PDFName.of("AF"), doc.context.obj([fileSpec]));
    }
    return doc.save({ useObjectStreams: false });
  }

  async function makeAttachmentPdf(options: { pageAttachment?: boolean } = {}) {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    await doc.attach(new TextEncoder().encode("account,total\nA-17,42\n"), "data.csv", {
      mimeType: "text/csv",
      description: "Source data",
      creationDate: new Date("2026-01-02T03:04:05Z"),
      modificationDate: new Date("2026-02-03T04:05:06Z"),
      afRelationship: AFRelationship.Data,
    });
    await doc.attach(new TextEncoder().encode('{"version":1}\n'), "schema.json", {
      mimeType: "application/json",
      description: "Validation schema",
      afRelationship: AFRelationship.Schema,
    });
    doc.addJavaScript("must-not-copy", "app.alert('must not run')");

    // Embed first, then reshape pdf-lib's flat EmbeddedFiles array into a
    // two-level name tree. Real portfolio and archival PDFs commonly use
    // /Kids + /Limits; a flat-only test would miss most clone bugs.
    const embedded = await PDFDocument.load(
      await doc.save({ useObjectStreams: false }),
    );
    const namesRoot = embedded.catalog.lookup(PDFName.of("Names"), PDFDict);
    const flatTree = namesRoot.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
    const flatNames = flatTree.lookup(PDFName.of("Names"), PDFArray);
    const kids = PDFArray.withContext(embedded.context);
    for (let i = 0; i < flatNames.size(); i += 2) {
      const key = flatNames.get(i)!;
      const value = flatNames.get(i + 1)!;
      const entries = PDFArray.withContext(embedded.context);
      entries.push(key);
      entries.push(value);
      const limits = PDFArray.withContext(embedded.context);
      limits.push(key);
      limits.push(key);
      const leaf = PDFDict.withContext(embedded.context);
      leaf.set(PDFName.of("Names"), entries);
      leaf.set(PDFName.of("Limits"), limits);
      kids.push(embedded.context.register(leaf));
    }
    const hierarchicalTree = PDFDict.withContext(embedded.context);
    hierarchicalTree.set(PDFName.of("Kids"), kids);
    namesRoot.set(
      PDFName.of("EmbeddedFiles"),
      embedded.context.register(hierarchicalTree),
    );

    const collection = PDFDict.withContext(embedded.context);
    collection.set(PDFName.of("Type"), PDFName.of("Collection"));
    collection.set(PDFName.of("View"), PDFName.of("D"));
    collection.set(PDFName.of("D"), PDFString.of("data.csv"));
    embedded.catalog.set(
      PDFName.of("Collection"),
      embedded.context.register(collection),
    );
    embedded.catalog.set(PDFName.of("PageMode"), PDFName.of("UseAttachments"));

    if (options.pageAttachment) {
      const firstLeaf = embedded.context.lookup(kids.get(0), PDFDict);
      const firstEntry = firstLeaf.lookup(PDFName.of("Names"), PDFArray);
      const fileSpec = firstEntry.get(1);
      if (!(fileSpec instanceof PDFRef)) {
        throw new Error("expected an indirect attachment file specification");
      }
      const annotation = PDFDict.withContext(embedded.context);
      annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
      annotation.set(PDFName.of("Subtype"), PDFName.of("FileAttachment"));
      annotation.set(PDFName.of("Rect"), embedded.context.obj([72, 700, 92, 720]));
      annotation.set(PDFName.of("FS"), fileSpec);
      annotation.set(PDFName.of("Name"), PDFName.of("Paperclip"));
      const page = embedded.getPage(0);
      const pageFiles = PDFArray.withContext(embedded.context);
      pageFiles.push(fileSpec);
      page.node.set(PDFName.of("AF"), pageFiles);
      const annots = page.node.Annots() ?? PDFArray.withContext(embedded.context);
      if (!page.node.Annots()) page.node.set(PDFName.of("Annots"), annots);
      annots.push(embedded.context.register(annotation));
    }

    return embedded.save({ useObjectStreams: false });
  }

  async function inspectAttachments(bytes: Uint8Array) {
    const doc = await PDFDocument.load(bytes);
    const namesRoot = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
    const embeddedFiles = namesRoot?.lookupMaybe(
      PDFName.of("EmbeddedFiles"),
      PDFDict,
    );
    const entries: Array<{
      key: string;
      ref: string;
      fileName: string;
      description: string;
      relationship: string;
      mimeType: string;
      payload: number[];
    }> = [];
    const visit = (node: PDFDict, seen: Set<PDFDict>) => {
      if (seen.has(node)) return;
      seen.add(node);
      const names = node.lookupMaybe(PDFName.of("Names"), PDFArray);
      if (names) {
        for (let i = 0; i + 1 < names.size(); i += 2) {
          const keyObject = names.get(i);
          const specObject = names.get(i + 1);
          if (
            !(keyObject instanceof PDFString || keyObject instanceof PDFHexString) ||
            !(specObject instanceof PDFRef)
          ) {
            continue;
          }
          const spec = doc.context.lookup(specObject, PDFDict);
          const unicodeName = spec.lookupMaybe(PDFName.of("UF"), PDFHexString);
          const fallbackName = spec.lookupMaybe(PDFName.of("F"), PDFString);
          const description = spec.lookupMaybe(PDFName.of("Desc"), PDFHexString);
          const ef = spec.lookup(PDFName.of("EF"), PDFDict);
          const stream = ef.lookup(PDFName.of("F"), PDFRawStream);
          const mime = stream.dict.get(PDFName.of("Subtype"));
          entries.push({
            key: keyObject.decodeText(),
            ref: specObject.toString(),
            fileName: unicodeName?.decodeText() ?? fallbackName?.decodeText() ?? "",
            description: description?.decodeText() ?? "",
            relationship: String(spec.get(PDFName.of("AFRelationship"))),
            mimeType: mime instanceof PDFName ? mime.decodeText() : "",
            payload: Array.from(decodePDFRawStream(stream).decode()),
          });
        }
      }
      const childRefs = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
      for (let i = 0; i < (childRefs?.size() ?? 0); i += 1) {
        const child = childRefs!.lookupMaybe(i, PDFDict);
        if (child) visit(child, seen);
      }
    };
    if (embeddedFiles) visit(embeddedFiles, new Set());

    const associated = doc.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
    const associatedRefs = Array.from(
      { length: associated?.size() ?? 0 },
      (_, index) => String(associated!.get(index)),
    );
    const pageAnnots = doc.getPage(0).node.lookupMaybe(
      PDFName.of("Annots"),
      PDFArray,
    );
    let pageAttachmentRef: string | null = null;
    for (let i = 0; i < (pageAnnots?.size() ?? 0); i += 1) {
      const annotation = pageAnnots!.lookupMaybe(i, PDFDict);
      const subtype = annotation?.lookupMaybe(
        PDFName.of("Subtype"),
        PDFName,
      );
      if (subtype?.decodeText() !== "FileAttachment") {
        continue;
      }
      pageAttachmentRef = String(annotation.get(PDFName.of("FS")));
    }
    const pageFiles = doc.getPage(0).node.lookupMaybe(PDFName.of("AF"), PDFArray);
    const pageFileRefs = Array.from(
      { length: pageFiles?.size() ?? 0 },
      (_, index) => String(pageFiles!.get(index)),
    );
    return {
      doc,
      entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
      associatedRefs: associatedRefs.sort(),
      pageAttachmentRef,
      pageFileRefs,
      hasCollection: Boolean(
        doc.catalog.lookupMaybe(PDFName.of("Collection"), PDFDict),
      ),
      hasJavaScript: Boolean(
        namesRoot?.get(PDFName.of("JavaScript")),
      ),
      pageMode:
        doc.catalog
          .lookupMaybe(PDFName.of("PageMode"), PDFName)
          ?.toString() ?? "",
      embeddedStreamCount: doc.context
        .enumerateIndirectObjects()
        .filter(([, object]) => {
          if (!(object instanceof PDFRawStream)) return false;
          return object.dict.get(PDFName.of("Type"))?.toString() === "/EmbeddedFile";
        }).length,
    };
  }

  test("internal links keep pointing at a page that is actually in the export", async () => {
    const original = await makeDirectLinkPdf();
    const { bytes } = await exportPdf(original, twoPageModel());
    const loaded = await PDFDocument.load(bytes);

    const pageRefs = new Set(
      loaded.getPages().map((page) => page.ref.toString()),
    );
    expect(pageRefs.size).toBe(2);

    const annots = loaded.getPage(0).node.lookupMaybe(
      PDFName.of("Annots"),
      PDFArray,
    );
    if (!annots) throw new Error("expected link annotations on page 1");

    const targets: string[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const annot = loaded.context.lookupMaybe(annots.get(i), PDFDict);
      if (!annot) continue;
      if (annot.get(PDFName.of("Subtype"))?.toString() !== "/Link") continue;

      const direct = loaded.context.lookupMaybe(
        annot.get(PDFName.of("Dest")),
        PDFArray,
      );
      const action = loaded.context.lookupMaybe(
        annot.get(PDFName.of("A")),
        PDFDict,
      );
      const viaAction = action
        ? loaded.context.lookupMaybe(action.get(PDFName.of("D")), PDFArray)
        : undefined;
      const array = direct ?? viaAction;
      if (!array) continue;
      targets.push(String(array.get(0)));
    }

    // Both links survive, and both resolve to the SECOND real page of the
    // exported document rather than an orphaned copy outside /Pages.
    expect(targets.length).toBe(2);
    const secondPageRef = loaded.getPage(1).ref.toString();
    for (const target of targets) {
      expect(pageRefs.has(target)).toBe(true);
      expect(target).toBe(secondPageRef);
    }
  });

  test("a link to a page that was not exported is dropped, not left dangling", async () => {
    const original = await makeDirectLinkPdf();
    // Export page 1 only — the link target is gone.
    const { bytes } = await exportPdf(original, modelForPages([0]));
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);

    const annots = loaded.getPage(0).node.lookupMaybe(
      PDFName.of("Annots"),
      PDFArray,
    );
    const remaining: string[] = [];
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = loaded.context.lookupMaybe(annots!.get(i), PDFDict);
      if (annot?.get(PDFName.of("Subtype"))?.toString() === "/Link") {
        remaining.push(String(i));
      }
    }
    expect(remaining).toEqual([]);
  });

  test("document info survives an annotated export", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.setTitle("On the Electrodynamics of Moving Bodies");
    doc.setAuthor("A. Einstein");
    doc.setSubject("Special relativity");
    doc.setKeywords(["relativity", "electrodynamics"]);
    doc.setCreator("Annalen der Physik");
    const created = new Date("1905-06-30T00:00:00Z");
    doc.setCreationDate(created);
    const original = await doc.save();

    const { bytes } = await exportPdf(original, modelForPages([0]));
    const loaded = await PDFDocument.load(bytes);

    expect(loaded.getTitle()).toBe("On the Electrodynamics of Moving Bodies");
    expect(loaded.getAuthor()).toBe("A. Einstein");
    expect(loaded.getSubject()).toBe("Special relativity");
    expect(loaded.getKeywords()).toContain("relativity");
    expect(loaded.getCreator()).toBe("Annalen der Physik");
    expect(loaded.getCreationDate()?.getUTCFullYear()).toBe(1905);
  });

  test("a fillable form is still fillable after export", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const nameField = form.createTextField("applicant.name");
    nameField.setText("");
    nameField.addToPage(page, { x: 72, y: 700, width: 200, height: 20 });
    const noteField = form.createTextField("applicant.note");
    noteField.addToPage(page, { x: 72, y: 660, width: 200, height: 20 });
    const original = await doc.save();

    const { bytes } = await exportPdf(original, modelForPages([0]));
    const loaded = await PDFDocument.load(bytes);

    // Without /AcroForm the widgets are still painted but no reader treats the
    // file as a form: getFields() comes back empty and nothing is focusable.
    const fieldNames = loaded
      .getForm()
      .getFields()
      .map((field) => field.getName())
      .sort();
    expect(fieldNames).toEqual(["applicant.name", "applicant.note"]);
  });

  test("page labels and language survive a whole-document export", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    doc.catalog.set(PDFName.of("Lang"), PDFString.of("en-GB"));
    const labelRange = PDFDict.withContext(doc.context);
    labelRange.set(PDFName.of("S"), PDFName.of("r"));
    const nums = PDFArray.withContext(doc.context);
    nums.push(PDFNumber.of(0));
    nums.push(doc.context.register(labelRange));
    const pageLabels = PDFDict.withContext(doc.context);
    pageLabels.set(PDFName.of("Nums"), nums);
    doc.catalog.set(PDFName.of("PageLabels"), doc.context.register(pageLabels));
    const original = await doc.save();

    const { bytes } = await exportPdf(original, modelForPages([0, 1]));
    const loaded = await PDFDocument.load(bytes);
    expect(String(loaded.catalog.get(PDFName.of("Lang")))).toContain("en-GB");
    expect(
      loaded.catalog.lookupMaybe(PDFName.of("PageLabels"), PDFDict),
    ).toBeDefined();
  });

  test("page labels are dropped when the page set changed", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    const labelRange = PDFDict.withContext(doc.context);
    labelRange.set(PDFName.of("S"), PDFName.of("r"));
    const nums = PDFArray.withContext(doc.context);
    nums.push(PDFNumber.of(0));
    nums.push(doc.context.register(labelRange));
    const pageLabels = PDFDict.withContext(doc.context);
    pageLabels.set(PDFName.of("Nums"), nums);
    doc.catalog.set(PDFName.of("PageLabels"), doc.context.register(pageLabels));
    const original = await doc.save();

    // Only the second source page is exported, so positional labels would
    // number the wrong pages. Dropping beats mislabelling.
    const { bytes } = await exportPdf(original, modelForPages([1]));
    const loaded = await PDFDocument.load(bytes);
    expect(
      loaded.catalog.lookupMaybe(PDFName.of("PageLabels"), PDFDict),
    ).toBeUndefined();
  });

  test("preserves embedded files, associated-file metadata, and object identity", async () => {
    const original = await makeAttachmentPdf({ pageAttachment: true });

    for (const mode of ["annotations", "flatten", "none"] satisfies ExportMode[]) {
      for (const quality of ["original", "standard"] as const) {
        const { bytes } = await exportPdf(original, twoPageModel(), {
          mode,
          quality,
        });
        const result = await inspectAttachments(bytes);
        expect(
          result.entries.map(({ key, fileName, description, relationship, mimeType, payload }) => ({
            key,
            fileName,
            description,
            relationship,
            mimeType,
            payload: new TextDecoder().decode(new Uint8Array(payload)),
          })),
        ).toEqual([
          {
            key: "data.csv",
            fileName: "data.csv",
            description: "Source data",
            relationship: "/Data",
            mimeType: "text/csv",
            payload: "account,total\nA-17,42\n",
          },
          {
            key: "schema.json",
            fileName: "schema.json",
            description: "Validation schema",
            relationship: "/Schema",
            mimeType: "application/json",
            payload: '{"version":1}\n',
          },
        ]);
        const namedRefs = result.entries.map(({ ref }) => ref).sort();
        expect(result.associatedRefs).toEqual(namedRefs);
        expect(result.pageAttachmentRef).toBe(
          mode === "none"
            ? null
            : (result.entries.find(({ key }) => key === "data.csv")?.ref ?? null),
        );
        expect(result.pageFileRefs).toEqual(
          [result.entries.find(({ key }) => key === "data.csv")?.ref],
        );
        expect(result.embeddedStreamCount).toBe(2);
        expect(result.hasCollection).toBe(true);
        expect(result.pageMode).toBe("/UseAttachments");
        // Attachment preservation is an allowlist, not a clone of /Names:
        // active JavaScript must not hitch a ride with EmbeddedFiles.
        expect(result.hasJavaScript).toBe(false);
      }
    }
  });

  test("omits hidden document attachments from a partial-page export", async () => {
    const original = await makeAttachmentPdf({ pageAttachment: true });
    const { bytes } = await exportPdf(original, modelForPages([0]));
    const result = await inspectAttachments(bytes);
    expect(result.entries).toEqual([]);
    expect(result.associatedRefs).toEqual([]);
    expect(result.hasCollection).toBe(false);
    expect(result.pageMode).toBe("");
    expect(result.pageAttachmentRef).toBeNull();
    expect(result.pageFileRefs).toEqual([]);
    expect(result.embeddedStreamCount).toBe(0);
  });

  test("drops a deleted page's only attachment during an explicit preserve export", async () => {
    const original = await makePageOnlyAttachmentPdf({
      pageAssociation: true,
      twoPages: true,
    });

    const { bytes } = await exportPdf(original, modelForPages([1]), {
      documentFiles: "preserve",
    });
    const result = await inspectAttachments(bytes);

    expect(result.pageAttachmentRef).toBeNull();
    expect(result.pageFileRefs).toEqual([]);
    expect(result.embeddedStreamCount).toBe(0);
  });

  test("drops a cross-page reply that points to a deleted page attachment", async () => {
    const doc = await PDFDocument.load(
      await makePageOnlyAttachmentPdf({ twoPages: true }),
    );
    const sourceAnnots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    const attachmentRef = sourceAnnots.get(0);
    if (!(attachmentRef instanceof PDFRef)) {
      throw new Error("expected an indirect FileAttachment annotation");
    }
    const reply = PDFDict.withContext(doc.context);
    reply.set(PDFName.of("Type"), PDFName.of("Annot"));
    reply.set(PDFName.of("Subtype"), PDFName.of("Stamp"));
    reply.set(PDFName.of("Rect"), doc.context.obj([72, 700, 92, 720]));
    reply.set(PDFName.of("IRT"), attachmentRef);
    doc.getPage(1).node.addAnnot(doc.context.register(reply));
    const original = await doc.save({ useObjectStreams: false });

    const { bytes } = await exportPdf(original, modelForPages([1]), {
      documentFiles: "preserve",
    });
    const result = await inspectAttachments(bytes);

    expect(result.embeddedStreamCount).toBe(0);
    const annots = result.doc.getPage(0).node.lookupMaybe(
      PDFName.of("Annots"),
      PDFArray,
    );
    expect(annots?.size() ?? 0).toBe(1); // The model's new highlight only.
  });

  test("keeps a catalog attachment that is also referenced by a deleted page", async () => {
    const original = await makeAttachmentPdf({ pageAttachment: true });

    const { bytes } = await exportPdf(original, modelForPages([1]), {
      documentFiles: "preserve",
    });
    const result = await inspectAttachments(bytes);

    expect(result.entries.map(({ key }) => key)).toEqual([
      "data.csv",
      "schema.json",
    ]);
    expect(result.pageAttachmentRef).toBeNull();
    expect(result.embeddedStreamCount).toBe(2);
  });

  test("does not let the no-op fast path leak attachments from a one-page selection", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    await doc.attach(new TextEncoder().encode("private"), "private.txt", {
      mimeType: "text/plain",
      afRelationship: AFRelationship.Data,
    });
    const original = await doc.save({ useObjectStreams: false });
    const model: DocumentModel = {
      pages: [
        {
          id: "p1",
          sourceIndex: 0,
          rotation: 0,
          widthPt: 612,
          heightPt: 792,
        },
      ],
      overlays: [],
    };

    const { bytes } = await exportPdf(original, model, {
      documentFiles: "omit",
    });
    const result = await inspectAttachments(bytes);
    expect(result.entries).toEqual([]);
    expect(bytes).not.toEqual(original);
  });

  test("omits a page-only attachment instead of returning the original bytes", async () => {
    const original = await makePageOnlyAttachmentPdf();
    const { bytes } = await exportPdf(original, uneditedModelForPages([0]), {
      documentFiles: "omit",
    });
    const result = await inspectAttachments(bytes);
    expect(bytes).not.toEqual(original);
    expect(result.pageAttachmentRef).toBeNull();
    expect(result.embeddedStreamCount).toBe(0);
  });

  test("removes cross-page replies that would retain an omitted attachment", async () => {
    const doc = await PDFDocument.load(
      await makePageOnlyAttachmentPdf({ twoPages: true }),
    );
    const sourceAnnots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    const attachmentRef = sourceAnnots.get(0);
    if (!(attachmentRef instanceof PDFRef)) {
      throw new Error("expected an indirect FileAttachment annotation");
    }
    const reply = PDFDict.withContext(doc.context);
    reply.set(PDFName.of("Type"), PDFName.of("Annot"));
    reply.set(PDFName.of("Subtype"), PDFName.of("Stamp"));
    reply.set(PDFName.of("Rect"), doc.context.obj([72, 700, 92, 720]));
    reply.set(PDFName.of("IRT"), attachmentRef);
    doc.getPage(1).node.addAnnot(doc.context.register(reply));
    const original = await doc.save({ useObjectStreams: false });

    const { bytes } = await exportPdf(original, modelForPages([1]), {
      documentFiles: "omit",
    });
    const result = await inspectAttachments(bytes);
    expect(result.embeddedStreamCount).toBe(0);
    const annots = result.doc.getPage(0).node.lookupMaybe(
      PDFName.of("Annots"),
      PDFArray,
    );
    const subtypes: string[] = [];
    for (let i = 0; i < (annots?.size() ?? 0); i += 1) {
      const annotation = annots!.lookupMaybe(i, PDFDict);
      const subtype = annotation?.lookupMaybe(PDFName.of("Subtype"), PDFName);
      if (subtype) subtypes.push(subtype.decodeText());
    }
    expect(subtypes).not.toContain("Stamp");
  });

  test("recognizes an indirect FileAttachment subtype when preserving identity", async () => {
    const doc = await PDFDocument.load(await makeAttachmentPdf());
    const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
    const embedded = names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
    const firstLeaf = embedded.lookup(PDFName.of("Kids"), PDFArray).lookup(
      0,
      PDFDict,
    );
    const fileSpec = firstLeaf.lookup(PDFName.of("Names"), PDFArray).get(1);
    if (!(fileSpec instanceof PDFRef)) throw new Error("missing FileSpec ref");
    const annotation = PDFDict.withContext(doc.context);
    annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
    annotation.set(
      PDFName.of("Subtype"),
      doc.context.register(PDFName.of("FileAttachment")),
    );
    annotation.set(PDFName.of("Rect"), doc.context.obj([72, 700, 92, 720]));
    annotation.set(PDFName.of("FS"), fileSpec);
    doc.getPage(0).node.addAnnot(doc.context.register(annotation));
    const original = await doc.save({ useObjectStreams: false });

    const { bytes } = await exportPdf(original, twoPageModel(), {
      documentFiles: "preserve",
    });
    const result = await inspectAttachments(bytes);
    expect(result.pageAttachmentRef).toBe(
      result.entries.find(({ key }) => key === "data.csv")?.ref ?? null,
    );
    expect(result.embeddedStreamCount).toBe(2);
  });

  test("removes associated files reached through a structure element", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const fileSpec = registerEmbeddedFile(
      doc,
      "STRUCTURE-SECRET",
      "structure.txt",
    );
    const element = doc.context.register(
      doc.context.obj({
        Type: "StructElem",
        S: "Document",
        Pg: page.ref,
        AF: [fileSpec],
      }),
    );
    const structureRoot = doc.context.register(
      doc.context.obj({ Type: "StructTreeRoot", K: [element] }),
    );
    doc.catalog.set(PDFName.of("StructTreeRoot"), structureRoot);
    const original = await doc.save({ useObjectStreams: false });

    const { bytes } = await exportPdf(original, uneditedModelForPages([0]), {
      documentFiles: "omit",
    });
    const result = await inspectAttachments(bytes);
    expect(result.embeddedStreamCount).toBe(0);
  });

  test("fails closed when an unhandled file action would survive omission", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const fileSpec = registerEmbeddedFile(doc, "LAUNCH-SECRET", "launch.txt");
    const action = doc.context.register(
      doc.context.obj({ S: "Launch", F: fileSpec }),
    );
    const link = PDFDict.withContext(doc.context);
    link.set(PDFName.of("Type"), PDFName.of("Annot"));
    link.set(PDFName.of("Subtype"), PDFName.of("Link"));
    link.set(PDFName.of("Rect"), doc.context.obj([72, 700, 200, 720]));
    link.set(PDFName.of("A"), action);
    page.node.addAnnot(doc.context.register(link));
    const original = await doc.save({ useObjectStreams: false });

    await expect(
      exportPdf(original, uneditedModelForPages([0]), {
        documentFiles: "omit",
      }),
    ).rejects.toBeInstanceOf(ExportIntegrityError);
  });

  test("recognizes a typeless EF stream and refuses to leak it through a file action", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const payload = new TextEncoder().encode("TYPELESS-EF-SECRET");
    const streamRef = doc.context.register(doc.context.flateStream(payload));
    const fileSpec = doc.context.register(
      doc.context.obj({
        Type: "Filespec",
        F: PDFString.of("typeless.txt"),
        UF: PDFHexString.fromText("typeless.txt"),
        EF: { F: streamRef },
      }),
    );
    const action = doc.context.register(
      doc.context.obj({ S: "Launch", F: fileSpec }),
    );
    const link = PDFDict.withContext(doc.context);
    link.set(PDFName.of("Type"), PDFName.of("Annot"));
    link.set(PDFName.of("Subtype"), PDFName.of("Link"));
    link.set(PDFName.of("Rect"), doc.context.obj([72, 700, 200, 720]));
    link.set(PDFName.of("A"), action);
    page.node.addAnnot(doc.context.register(link));
    const original = await doc.save({ useObjectStreams: false });

    await expect(
      exportPdf(original, uneditedModelForPages([0]), {
        documentFiles: "omit",
      }),
    ).rejects.toBeInstanceOf(ExportIntegrityError);
  });

  test("fails closed when a live Info attachment cannot be copied", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const fileSpec = registerEmbeddedFile(doc, "INFO-SECRET", "info.txt");
    const info = PDFDict.withContext(doc.context);
    info.set(PDFName.of("AF"), doc.context.obj([fileSpec]));
    doc.context.trailerInfo.Info = doc.context.register(info);
    const original = await doc.save({ useObjectStreams: false });

    await expect(
      exportPdf(original, modelForPages([0]), {
        documentFiles: "preserve",
      }),
    ).rejects.toBeInstanceOf(ExportIntegrityError);
    await expect(
      preserveDocumentFilesInPdf(original, await makeOnePagePdf()),
    ).rejects.toBeInstanceOf(ExportIntegrityError);
  });

  test("handles an indirect UseAttachments page mode", async () => {
    const doc = await PDFDocument.load(await makeAttachmentPdf());
    doc.catalog.set(
      PDFName.of("PageMode"),
      doc.context.register(PDFName.of("UseAttachments")),
    );
    const original = await doc.save({ useObjectStreams: false });

    const preserved = await exportPdf(original, twoPageModel(), {
      documentFiles: "preserve",
    });
    expect((await inspectAttachments(preserved.bytes)).pageMode).toBe(
      "/UseAttachments",
    );

    const omitted = await exportPdf(original, modelForPages([0]), {
      documentFiles: "omit",
    });
    expect((await inspectAttachments(omitted.bytes)).pageMode).toBe("");
  });

  test("does not treat an unreachable stale stream as a live attachment", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    registerEmbeddedFile(doc, "STALE-PAYLOAD", "stale.txt");
    const original = await doc.save({ useObjectStreams: false });

    const preserved = await exportPdf(original, modelForPages([0]), {
      documentFiles: "preserve",
    });
    expect((await inspectAttachments(preserved.bytes)).embeddedStreamCount).toBe(0);

    const omitted = await exportPdf(original, uneditedModelForPages([0]), {
      documentFiles: "omit",
    });
    expect(omitted.bytes).not.toEqual(original);
    expect((await inspectAttachments(omitted.bytes)).embeddedStreamCount).toBe(0);
  });

  test("keeps the no-op byte path for one-page selections without document files", async () => {
    const original = await makeOnePagePdf();
    const model: DocumentModel = {
      pages: [
        {
          id: "p1",
          sourceIndex: 0,
          rotation: 0,
          widthPt: 612,
          heightPt: 792,
        },
      ],
      overlays: [],
    };
    const { bytes } = await exportPdf(original, model, {
      documentFiles: "omit",
    });
    expect(bytes).toEqual(original);
  });

  test("keeps document files when a full-document caller explicitly preserves them", async () => {
    const original = await makeAttachmentPdf();
    const { bytes } = await exportPdf(original, modelForPages([0]), {
      documentFiles: "preserve",
    });
    const result = await inspectAttachments(bytes);
    expect(result.entries.map(({ key }) => key)).toEqual([
      "data.csv",
      "schema.json",
    ]);
    expect(result.hasCollection).toBe(true);
  });

  test("keeps FileAttachment mappings stable after an earlier link is pruned", async () => {
    const doc = await PDFDocument.load(await makeAttachmentPdf());
    const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
    const embedded = names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
    const kids = embedded.lookup(PDFName.of("Kids"), PDFArray);
    const fileSpecs: PDFRef[] = [];
    for (let i = 0; i < kids.size(); i += 1) {
      const leaf = kids.lookup(i, PDFDict);
      const entries = leaf.lookup(PDFName.of("Names"), PDFArray);
      const fileSpec = entries.get(1);
      if (!(fileSpec instanceof PDFRef)) throw new Error("missing FileSpec ref");
      fileSpecs.push(fileSpec);
    }

    const page = doc.getPage(0);
    const link = PDFDict.withContext(doc.context);
    link.set(PDFName.of("Type"), PDFName.of("Annot"));
    link.set(PDFName.of("Subtype"), PDFName.of("Link"));
    link.set(PDFName.of("Rect"), doc.context.obj([20, 20, 40, 40]));
    link.set(
      PDFName.of("Dest"),
      doc.context.obj([doc.getPage(1).ref, PDFName.of("Fit")]),
    );
    page.node.addAnnot(doc.context.register(link));
    for (const [index, fileSpec] of fileSpecs.entries()) {
      const attachment = PDFDict.withContext(doc.context);
      attachment.set(PDFName.of("Type"), PDFName.of("Annot"));
      attachment.set(PDFName.of("Subtype"), PDFName.of("FileAttachment"));
      attachment.set(
        PDFName.of("Rect"),
        doc.context.obj([60 + index * 24, 20, 80 + index * 24, 40]),
      );
      attachment.set(PDFName.of("FS"), fileSpec);
      page.node.addAnnot(doc.context.register(attachment));
    }
    const original = await doc.save({ useObjectStreams: false });

    const { bytes } = await exportPdf(original, modelForPages([0]), {
      documentFiles: "preserve",
    });
    const result = await inspectAttachments(bytes);
    expect(
      result.entries.map(({ key, fileName, payload }) => ({
        key,
        fileName,
        payload: new TextDecoder().decode(new Uint8Array(payload)),
      })),
    ).toEqual([
      {
        key: "data.csv",
        fileName: "data.csv",
        payload: "account,total\nA-17,42\n",
      },
      {
        key: "schema.json",
        fileName: "schema.json",
        payload: '{"version":1}\n',
      },
    ]);
    expect(result.embeddedStreamCount).toBe(2);
  });

  test("fails closed when an advertised EmbeddedFiles root is malformed", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const names = PDFDict.withContext(doc.context);
    names.set(PDFName.of("EmbeddedFiles"), PDFString.of("not-a-name-tree"));
    doc.catalog.set(PDFName.of("Names"), names);
    const original = await doc.save({ useObjectStreams: false });

    await expect(
      exportPdf(original, modelForPages([0]), {
        documentFiles: "preserve",
      }),
    ).rejects.toThrow("/Names/EmbeddedFiles is not a dictionary");
  });

  test("preserves attachments while rebuilding the internal merge base", async () => {
    const doc = await PDFDocument.load(await makeAttachmentPdf());
    const highlight = PDFDict.withContext(doc.context);
    highlight.set(PDFName.of("Type"), PDFName.of("Annot"));
    highlight.set(PDFName.of("Subtype"), PDFName.of("Highlight"));
    highlight.set(PDFName.of("Rect"), doc.context.obj([72, 500, 272, 514]));
    highlight.set(
      PDFName.of("QuadPoints"),
      doc.context.obj([72, 514, 272, 514, 72, 500, 272, 500]),
    );
    const annots = doc.getPage(0).node.Annots() ?? PDFArray.withContext(doc.context);
    if (!doc.getPage(0).node.Annots()) {
      doc.getPage(0).node.set(PDFName.of("Annots"), annots);
    }
    annots.push(doc.context.register(highlight));
    const original = await doc.save({ useObjectStreams: false });

    // The source highlight forces exportMergeBase past the unchanged fast
    // path, proving the rebuilt document—not the original byte shortcut.
    const { bytes } = await exportMergeBase(original, twoPageModel().pages);
    const result = await inspectAttachments(bytes);
    expect(result.entries.map(({ key }) => key)).toEqual([
      "data.csv",
      "schema.json",
    ]);
  });

  test("adds document files to compact-style output without changing its pages", async () => {
    const source = await makeAttachmentPdf();
    const compact = await PDFDocument.create();
    compact.addPage([300, 400]);
    compact.addPage([500, 600]);
    const compactBytes = await compact.save({ useObjectStreams: true });

    const bytes = await preserveDocumentFilesInPdf(source, compactBytes);
    const result = await inspectAttachments(bytes);
    expect(result.entries.map(({ key }) => key)).toEqual([
      "data.csv",
      "schema.json",
    ]);
    expect(
      result.doc.getPages().map((page) => [page.getWidth(), page.getHeight()]),
    ).toEqual([
      [300, 400],
      [500, 600],
    ]);
    expect(result.pageMode).toBe("/UseAttachments");
  });

  test("lets compact output rasterize a page-only attachment", async () => {
    const source = await makePageOnlyAttachmentPdf();
    const compact = await makeOnePagePdf();

    const bytes = await preserveDocumentFilesInPdf(source, compact);
    const result = await inspectAttachments(bytes);

    expect(bytes).toBe(compact);
    expect(result.pageAttachmentRef).toBeNull();
    expect(result.embeddedStreamCount).toBe(0);
  });

  test("preserves catalog files while rasterizing page-only attachments", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    await source.attach(new TextEncoder().encode("CATALOG-PAYLOAD"), "catalog.txt", {
      mimeType: "text/plain",
      afRelationship: AFRelationship.Data,
    });
    const pageOnly = registerEmbeddedFile(
      source,
      "PAGE-ONLY-PAYLOAD",
      "page-only.txt",
    );
    const annotation = PDFDict.withContext(source.context);
    annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
    annotation.set(PDFName.of("Subtype"), PDFName.of("FileAttachment"));
    annotation.set(PDFName.of("Rect"), source.context.obj([72, 700, 92, 720]));
    annotation.set(PDFName.of("FS"), pageOnly);
    page.node.addAnnot(source.context.register(annotation));
    const sourceBytes = await source.save({ useObjectStreams: false });
    const compact = await makeOnePagePdf();

    const bytes = await preserveDocumentFilesInPdf(sourceBytes, compact);
    const result = await inspectAttachments(bytes);

    expect(result.entries.map(({ key }) => key)).toEqual(["catalog.txt"]);
    expect(result.pageAttachmentRef).toBeNull();
    expect(result.embeddedStreamCount).toBe(1);
  });

  test("distinguishes two FileSpecs that share one embedded stream", async () => {
    const initial = await PDFDocument.create();
    initial.addPage([612, 792]);
    await initial.attach(
      new TextEncoder().encode("SHARED-PAYLOAD"),
      "catalog.txt",
      {
        description: "Catalog copy",
        afRelationship: AFRelationship.Data,
      },
    );
    const source = await PDFDocument.load(
      await initial.save({ useObjectStreams: false }),
    );
    const names = source.catalog.lookup(PDFName.of("Names"), PDFDict);
    const embedded = names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
    const catalogFileSpec = embedded
      .lookup(PDFName.of("Names"), PDFArray)
      .lookup(1, PDFDict);
    const aliasFileSpec = source.context.register(
      source.context.obj({
        Type: "Filespec",
        F: PDFString.of("page-alias.txt"),
        UF: PDFHexString.fromText("page-alias.txt"),
        EF: catalogFileSpec.get(PDFName.of("EF")),
        Desc: PDFHexString.fromText("Page alias"),
        AFRelationship: "Supplement",
      }),
    );
    const annotation = PDFDict.withContext(source.context);
    annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
    annotation.set(PDFName.of("Subtype"), PDFName.of("FileAttachment"));
    annotation.set(PDFName.of("Rect"), source.context.obj([72, 700, 92, 720]));
    annotation.set(PDFName.of("FS"), aliasFileSpec);
    source.getPage(0).node.addAnnot(source.context.register(annotation));
    const sourceBytes = await source.save({ useObjectStreams: false });

    const preserved = await exportPdf(
      sourceBytes,
      // The highlight forces the rebuilt path where recursive seeding matters;
      // an unedited model would return the original bytes and make this test
      // green even if shared EF identity regressed.
      modelForPages([0]),
      {
        mode: "annotations",
        documentFiles: "preserve",
      },
    );
    expect((await inspectAttachments(preserved.bytes)).embeddedStreamCount).toBe(1);

    const withoutAnnotations = await exportPdf(
      sourceBytes,
      uneditedModelForPages([0]),
      {
        mode: "none",
        documentFiles: "preserve",
      },
    );
    const withoutAnnotationsResult = await inspectAttachments(
      withoutAnnotations.bytes,
    );
    expect(withoutAnnotationsResult.pageAttachmentRef).toBeNull();
    expect(withoutAnnotationsResult.entries.map(({ key }) => key)).toEqual([
      "catalog.txt",
    ]);
    expect(withoutAnnotationsResult.embeddedStreamCount).toBe(1);
    const compact = await preserveDocumentFilesInPdf(
      sourceBytes,
      await makeOnePagePdf(),
    );
    const compactResult = await inspectAttachments(compact);
    expect(compactResult.pageAttachmentRef).toBeNull();
    expect(compactResult.entries.map(({ key }) => key)).toEqual([
      "catalog.txt",
    ]);
    expect(compactResult.embeddedStreamCount).toBe(1);
  });

  test("does not rewrite compact-style output when the source has no document files", async () => {
    const source = await makeOnePagePdf();
    const compact = await makeOnePagePdf();
    expect(await preserveDocumentFilesInPdf(source, compact)).toBe(compact);
  });

  test("refuses to copy encrypted attachment streams into an unencrypted compact PDF", async () => {
    const source = await PDFDocument.load(await makeAttachmentPdf());
    source.context.trailerInfo.Encrypt = source.context.register(
      source.context.obj({ Filter: PDFName.of("Standard"), V: 1 }),
    );
    const encrypted = await source.save({ useObjectStreams: false });
    const compact = await makeOnePagePdf();

    await expect(
      preserveDocumentFilesInPdf(encrypted, compact),
    ).rejects.toBeInstanceOf(ExportEncryptedSourceError);
  });
});

describe("only annotations the editor could own are replaced", () => {
  function annot(
    doc: PDFDocument,
    subtype: string,
    extra: (dict: PDFDict) => void = () => undefined,
  ) {
    const dict = PDFDict.withContext(doc.context);
    dict.set(PDFName.of("Type"), PDFName.of("Annot"));
    dict.set(PDFName.of("Subtype"), PDFName.of(subtype));
    dict.set(PDFName.of("Rect"), doc.context.obj([72, 700, 300, 720]));
    extra(dict);
    return doc.context.register(dict);
  }

  function quadPoints(doc: PDFDocument) {
    return doc.context.obj([72, 720, 300, 720, 72, 700, 300, 700]);
  }

  async function subtypesAfterExport(original: Uint8Array): Promise<string[]> {
    const model: DocumentModel = {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [
        {
          id: "hl",
          type: "highlight",
          pageId: "p1",
          rects: [{ x: 72, y: 500, w: 200, h: 14 }],
          color: "#f4d674",
          opacity: 1,
        },
      ],
    } as unknown as DocumentModel;

    const { bytes } = await exportPdf(original, model);
    const loaded = await PDFDocument.load(bytes);
    const annots = loaded
      .getPage(0)
      .node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    const out: string[] = [];
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const dict = loaded.context.lookupMaybe(annots!.get(i), PDFDict);
      const subtype = dict?.get(PDFName.of("Subtype"))?.toString();
      if (subtype) out.push(subtype);
    }
    return out;
  }

  test("a highlight the importer never surfaced is kept, not silently deleted", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annots = PDFArray.withContext(doc.context);
    // Malformed: /QuadPoints missing entirely. pdf.js reports quadPoints null,
    // so this annotation is never viewable, never imported, never drawn — and
    // therefore has no overlay to re-create it on export.
    annots.push(annot(doc, "Highlight"));
    page.node.set(PDFName.of("Annots"), annots);
    const original = await doc.save();

    expect(await subtypesAfterExport(original)).toContain("/Highlight");
  });

  test("an ordinary highlight is still replaced by the editor's own", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annots = PDFArray.withContext(doc.context);
    annots.push(
      annot(doc, "Highlight", (dict) => {
        dict.set(PDFName.of("QuadPoints"), quadPoints(doc));
      }),
    );
    page.node.set(PDFName.of("Annots"), annots);
    const original = await doc.save();

    // Exactly one highlight in the output: the overlay's, not the source's.
    const subtypes = await subtypesAfterExport(original);
    expect(subtypes.filter((s) => s === "/Highlight").length).toBe(1);
  });

  test("quad points that are not a multiple of eight count as malformed", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annots = PDFArray.withContext(doc.context);
    annots.push(
      annot(doc, "Underline", (dict) => {
        dict.set(PDFName.of("QuadPoints"), doc.context.obj([1, 2, 3]));
      }),
    );
    page.node.set(PDFName.of("Annots"), annots);
    const original = await doc.save();

    expect(await subtypesAfterExport(original)).toContain("/Underline");
  });

  test("a no-view annotation is left alone", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annots = PDFArray.withContext(doc.context);
    // NOVIEW (0x20): present in the file, never shown, never imported.
    annots.push(
      annot(doc, "Ink", (dict) => {
        dict.set(PDFName.of("F"), PDFNumber.of(0x20));
      }),
    );
    page.node.set(PDFName.of("Annots"), annots);
    const original = await doc.save();

    expect(await subtypesAfterExport(original)).toContain("/Ink");
  });

  test("an invisible square is replaced, since the importer took it", async () => {
    // INVISIBLE (0x01) only hides a subtype the reader does not know; a
    // Square is imported regardless, so keeping the source would draw it
    // twice after the overlay is written back.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annots = PDFArray.withContext(doc.context);
    annots.push(
      annot(doc, "Square", (dict) => {
        dict.set(PDFName.of("F"), PDFNumber.of(0x01));
      }),
    );
    page.node.set(PDFName.of("Annots"), annots);
    const original = await doc.save();

    expect(await subtypesAfterExport(original)).not.toContain("/Square");
  });

  test("a visible ink annotation is still replaced", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const annots = PDFArray.withContext(doc.context);
    annots.push(annot(doc, "Ink"));
    page.node.set(PDFName.of("Annots"), annots);
    const original = await doc.save();

    expect(await subtypesAfterExport(original)).not.toContain("/Ink");
  });
});

describe("encrypted source", () => {
  // What can go wrong exporting an encrypted PDF (the real handler, PDFium
  // and qpdf reading the result: crates/shiori-core-node/test/
  // encryptedExport.test.ts):
  // - without the source's handler, writing ciphertext pdf-lib cannot read
  //   into a "valid" file that renders blank;
  // - an untouched file must come back byte for byte, never re-encrypted;
  // - an edit must be made on the plaintext and only ever leave re-encrypted;
  // - a failed re-encryption must fail the export, never fall back to the
  //   plaintext;
  // - an edit the permissions refuse must stop before anything is encrypted.
  //
  // A real password-encrypted PDF cannot be produced with pdf-lib (it has no
  // encryption writer), but pdf-lib's view of one keys off
  // `!!lookup(trailerInfo.Encrypt)`. Registering an /Encrypt dict in the
  // trailer reproduces exactly the state exportPdf inspects.
  async function makeEncryptedPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const encryptDict = PDFDict.withContext(doc.context);
    encryptDict.set(PDFName.of("Filter"), PDFName.of("Standard"));
    encryptDict.set(PDFName.of("V"), PDFNumber.of(2));
    encryptDict.set(PDFName.of("R"), PDFNumber.of(3));
    encryptDict.set(PDFName.of("P"), PDFNumber.of(-1));
    doc.context.trailerInfo.Encrypt = doc.context.register(encryptDict);
    return doc.save();
  }

  test("a compact raster never takes document files from ciphertext, attachments or not", async () => {
    const raster = await makeOnePagePdf();
    await expect(preserveDocumentFilesInPdf(await makeEncryptedPdf(), raster)).rejects.toBeInstanceOf(
      ExportEncryptedSourceError,
    );
  });

  const ENCRYPTED_OUTPUT = new TextEncoder().encode("%PDF-1.7 encrypted");
  const MODIFY = 1 << 3;
  const ANNOTATE = 1 << 5;
  const ASSEMBLE = 1 << 10;
  const NONE = 0xfffff0c0;

  /** The source's handler as exportPdf sees it, recording what it encrypts. */
  function sourceEncryption(permissions = 0xfffffffc, revision = 4) {
    const encrypted: Uint8Array[] = [];
    let plaintextReads = 0;
    const encryption: ExportSourceEncryption = {
      security: { revision, permissions, userPermissions: permissions },
      plaintext: async () => {
        plaintextReads += 1;
        return makeOnePagePdf();
      },
      encrypt: async (plain) => {
        encrypted.push(plain);
        return ENCRYPTED_OUTPUT;
      },
    };
    return { encryption, encrypted, plaintextReads: () => plaintextReads };
  }

  const page = { id: "p1", sourceIndex: 0, rotation: 0 as const, widthPt: 612, heightPt: 792 };
  const highlighted = (): DocumentModel => ({
    pages: [page],
    overlays: [
      {
        id: "hl",
        type: "highlight",
        pageId: "p1",
        rects: [{ x: 72, y: 650, w: 120, h: 20 }],
        color: "#f4d674",
        opacity: 0.45,
      },
    ],
  });

  test("without the source's handler, refuses to export an encrypted PDF instead of writing a broken file", async () => {
    const original = await makeEncryptedPdf();
    const loaded = await PDFDocument.load(original, { ignoreEncryption: true });
    expect(loaded.isEncrypted).toBe(true);

    await expect(exportPdf(original, highlighted())).rejects.toBeInstanceOf(
      ExportEncryptedSourceError,
    );
  });

  test("returns an untouched encrypted PDF byte for byte, encrypting nothing", async () => {
    const original = await makeEncryptedPdf();
    const model: DocumentModel = { pages: [page], overlays: [] };
    const { bytes } = await exportPdf(original, model);
    expect(Array.from(bytes)).toEqual(Array.from(original));

    const { encryption, encrypted } = sourceEncryption();
    const withHandler = await exportPdf(original, model, { sourceEncryption: encryption });
    expect(Array.from(withHandler.bytes)).toEqual(Array.from(original));
    expect(encrypted).toHaveLength(0);
  });

  test("exports an edit from the plaintext and hands back only the re-encrypted file", async () => {
    const original = await makeEncryptedPdf();
    const { encryption, encrypted } = sourceEncryption();
    const result = await exportPdf(original, highlighted(), {
      sourceEncryption: encryption,
      quality: "standard",
    });
    expect(result.bytes).toEqual(ENCRYPTED_OUTPUT);
    // What went into the handler is the export: a readable file with the highlight.
    expect(encrypted).toHaveLength(1);
    const exported = await PDFDocument.load(encrypted[0]!);
    expect(exported.isEncrypted).toBe(false);
    const annots = exported.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);
    expect(annots?.lookup(0, PDFDict).get(PDFName.of("Subtype"))).toEqual(PDFName.of("Highlight"));
  });

  test("a failed re-encryption fails the export instead of returning the plaintext", async () => {
    const original = await makeEncryptedPdf();
    const { encryption } = sourceEncryption();
    encryption.encrypt = async () => {
      throw new Error("re-encryption unsupported: this crypt filter method");
    };
    await expect(
      exportPdf(original, highlighted(), { sourceEncryption: encryption }),
    ).rejects.toThrow("re-encryption unsupported");
  });

  test("refuses edits the permissions do not allow before encrypting anything", async () => {
    const original = await makeEncryptedPdf();
    const refused = async (permissions: number, model: DocumentModel, options: ExportOptions = {}, revision = 4) => {
      const { encryption, encrypted } = sourceEncryption(permissions, revision);
      const outcome = await exportPdf(original, model, { ...options, sourceEncryption: encryption }).catch((e: unknown) => e);
      if (!(outcome instanceof ExportPermissionError)) {
        expect(encrypted).toHaveLength(1);
        return "exported";
      }
      expect(encrypted).toHaveLength(0);
      return outcome.denied;
    };
    // A highlight is an annotation: bit 6.
    expect(await refused(NONE | MODIFY, highlighted())).toEqual(["annotations"]);
    expect(await refused(NONE | ANNOTATE, highlighted())).toBe("exported");
    // Flattened, it draws into the page: bit 4 as well.
    expect(await refused(NONE | ANNOTATE, highlighted(), { mode: "flatten" })).toEqual(["content"]);
    // Rotating a page needs bit 11 from revision 3 (bit 4 at revision 2),
    // and bit 4 does not stand in for it.
    const rotated: DocumentModel = { pages: [{ ...page, rotation: 90 }], overlays: [] };
    expect(await refused(NONE | ANNOTATE, rotated)).toEqual(["pages"]);
    expect(await refused(NONE | MODIFY, rotated)).toEqual(["pages"]);
    expect(await refused(NONE | ASSEMBLE, rotated)).toBe("exported");
    expect(await refused(NONE | ASSEMBLE, rotated, {}, 2)).toEqual(["pages"]);
  });
});

describe("signed source guard", () => {
  test("refuses to rebuild certified PDFs or PDFs with signature fields", async () => {
    const withPerms = await PDFDocument.create();
    withPerms.addPage([612, 792]);
    withPerms.catalog.set(
      PDFName.of("Perms"),
      withPerms.context.obj({
        DocMDP: withPerms.context.obj({ Type: "Sig" }),
      }),
    );

    const withSignatureField = await PDFDocument.create();
    withSignatureField.addPage([612, 792]);
    const signature = withSignatureField.context.register(
      withSignatureField.context.obj({ FT: "Sig" }),
    );
    const parent = withSignatureField.context.register(
      withSignatureField.context.obj({ Kids: [signature] }),
    );
    withSignatureField.catalog.set(
      PDFName.of("AcroForm"),
      withSignatureField.context.obj({ Fields: [parent] }),
    );

    for (const document of [withPerms, withSignatureField]) {
      await expect(
        exportPdf(await document.save(), sampleModel()),
      ).rejects.toBeInstanceOf(ExportSignedSourceError);
    }
  });

  test("returns untouched signed bytes when no rebuild is required", async () => {
    const document = await PDFDocument.create();
    document.addPage([612, 792]);
    document.catalog.set(
      PDFName.of("Perms"),
      document.context.obj({
        DocMDP: document.context.obj({ Type: "Sig" }),
      }),
    );
    const original = await document.save();
    const model: DocumentModel = {
      pages: [
        { id: "p0", sourceIndex: 0, widthPt: 612, heightPt: 792, rotation: 0 },
      ],
      overlays: [],
    };

    const { bytes } = await exportPdf(original, model);
    expect(Array.from(bytes)).toEqual(Array.from(original));
  });
});

describe("export integrity guard", () => {
  test("passes for a well-formed round-tripping PDF", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.addPage([300, 400]);
    const bytes = await doc.save();
    await expect(assertExportIntegrity(bytes, 2)).resolves.toBeUndefined();
  });

  test("rejects when the page count does not match what was built", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save();
    await expect(assertExportIntegrity(bytes, 2)).rejects.toBeInstanceOf(
      ExportIntegrityError,
    );
  });

  test("rejects bytes that cannot be re-parsed", async () => {
    const garbage = new Uint8Array([0x25, 0x21, 0x02, 0x03, 0x04]);
    await expect(assertExportIntegrity(garbage, 1)).rejects.toBeInstanceOf(
      ExportIntegrityError,
    );
  });

  test("resources shared across pages are copied once, not per page", async () => {
    const src = await PDFDocument.create();
    // A large stream shared by every page via its XObject resources — the
    // same shape as an embedded font program referenced from all pages.
    const sharedBytes = new Uint8Array(200_000);
    for (let i = 0; i < sharedBytes.length; i++) sharedBytes[i] = i % 251;
    const sharedRef = src.context.register(src.context.stream(sharedBytes));
    for (let i = 0; i < 6; i++) {
      const page = src.addPage([612, 792]);
      page.node.setXObject(PDFName.of("SharedRes"), sharedRef);
    }
    const original = await src.save({ useObjectStreams: false });

    const model: DocumentModel = {
      pages: Array.from({ length: 6 }, (_, i) => ({
        id: `p${i}`,
        sourceIndex: i,
        rotation: 0,
        widthPt: 612,
        heightPt: 792,
      })),
      overlays: [
        {
          id: "hl",
          type: "highlight",
          pageId: "p0",
          rects: [{ x: 72, y: 650, w: 120, h: 20 }],
          color: "#f4d674",
          opacity: 0.45,
        },
      ],
    };

    const { bytes } = await exportPdf(original, model, {
      mode: "annotations",
      quality: "original",
    });
    // Per-page copyPages used to re-copy the shared stream once per page
    // (~6x size); a single batched copy keeps exactly one instance.
    expect(bytes.byteLength).toBeLessThan(original.byteLength * 1.3);
  });
});

for (const kind of ["highlight", "callout-flatten", "callout-annotations"] as const) {
  test(`${kind} preserves dark source text with a painted Multiply state`, async () => {
    const original = await makeOnePagePdf();
    const target = { x: 72, y: 650, w: 120, h: 20 };
    const model: DocumentModel = {
      pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
      overlays: [kind === "highlight" ? {
        id: "mark", type: "highlight", pageId: "p1", rects: [target],
        color: "#f4d674", opacity: 0.45,
      } : {
        id: "callout", type: "callout", pageId: "p1", targetRects: [target],
        rect: { x: 250, y: 620, w: 144, h: 54 },
        leader: [{ x: 192, y: 660 }, { x: 220, y: 647 }, { x: 250, y: 647 }],
        leaderKind: "quadratic", text: "Note", fontSize: 12,
        color: "#b13a2e", bold: false, align: "left", fontFamily: "sans",
      }],
    };
    const mode = kind === "callout-annotations" ? "annotations" : "flatten";
    const { bytes } = await exportPdf(original, model, { mode });
    const loaded = await PDFDocument.load(bytes);
    const page = loaded.getPage(0);
    let resources = page.node.Resources()!;
    let operators: string;
    if (mode === "annotations") {
      const annot = page.node.Annots()!.lookup(0, PDFDict);
      const appearance = annot.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"), PDFRawStream);
      resources = appearance.dict.lookup(PDFName.of("Resources"), PDFDict);
      operators = await firstAnnotationAppearanceOperators(bytes);
    } else {
      expect(page.node.Annots()?.size() ?? 0).toBe(0);
      operators = await pageContentOperators(bytes);
    }
    const states = resources.lookup(PDFName.of("ExtGState"), PDFDict);
    const multiplyStates = states.keys().filter(name =>
      states.lookup(name, PDFDict).lookupMaybe(PDFName.of("BM"), PDFName)?.decodeText() === "Multiply");
    expect(multiplyStates.length).toBeGreaterThan(0);
    expect(multiplyStates.some(name => operators.includes(`${name.asString()} gs`))).toBe(true);
  });
}
