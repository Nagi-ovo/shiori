import { describe, expect, test } from "bun:test";
import fontkit from "@pdf-lib/fontkit";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
} from "pdf-lib";
import { exportPdf, type ExportMode } from "./exportPdf";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  DocumentModel,
  TextOverlay,
} from "../model/types";

// Three ways the text export used to look or lose more than it had to:
//
// 1. Reusing the source font. An edit of an already-bold heading carries
//    bold: true (inferred from that very font), and the source-font path
//    refused every bold/italic edit — so untouched-style heading edits came
//    out in Helvetica-Bold. Only a style the source font does not have may
//    send the edit to the bundled fonts.
//    Fails: bold source + bold edit drawn in a bundled font; italic likewise;
//    a regular source font reused for a bold edit (fake bold); a bold source
//    font reused after the user turned bold off.
// 2. Latin punctuation and accents. One curly quote, dash or "é" sent the
//    line to Noto Sans SC outlines: unselectable, unsearchable, sans-serif.
//    Fails: a WinAnsi-encodable line drawn without a text-show operator; a
//    serif line drawn in a non-serif face; CJK no longer drawn as outlines.
// 3. Overflow. Lines past roughly one line below the box were dropped with
//    no count and no signal, on both the bundled and the source-font path.
//    Fails: an original-text edit loses its later lines; a flattened text
//    box loses lines and the export result says nothing.

const unicodeFontUrl = new URL(
  "../../assets/fonts/NotoSansSC-Regular.otf",
  import.meta.url,
).href;

const PAGE = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 } as const;

// Helvetica / Times WinAnsi bytes of "Bye": what any bundled-font fallback
// shows. The source font shows glyph ids instead.
const BUNDLED_BYE = "<427965> Tj";

describe("source-font reuse with bold and italic", () => {
  test("a bold edit of a bold source run keeps the source font", async () => {
    const source = await sourceWithHi("AAAAAA+NotoSans-Bold");
    const after = await exportedOperators(source, edit({ bold: true }));
    expect(after).toContain(`<${await notoGids("Bye")}> Tj`);
    expect(after).not.toContain(BUNDLED_BYE);
  });

  test("an italic edit of an italic source run keeps the source font", async () => {
    const source = await sourceWithHi("AAAAAA+NotoSans-Italic");
    const after = await exportedOperators(source, edit({ italic: true }));
    expect(after).toContain(`<${await notoGids("Bye")}> Tj`);
    expect(after).not.toContain(BUNDLED_BYE);
  });

  test("turning bold on over a regular source font uses a bundled bold face", async () => {
    const source = await sourceWithHi("AAAAAA+NotoSans-Regular");
    const after = await exportedOperators(source, edit({ bold: true }));
    expect(after).toContain(BUNDLED_BYE);
    expect(after).not.toContain(`<${await notoGids("Bye")}> Tj`);
  });

  // PostScript names glue the styles: BoldOblique, BoldItalic.
  test.each(["Helvetica-BoldOblique", "Arial-BoldItalic", "Times-BoldItalic"])(
    "a bold italic edit of a %s run keeps the source font",
    async (baseFont) => {
      const source = await sourceWithHi(baseFont);
      const after = await exportedOperators(source, edit({ bold: true, italic: true }));
      expect(after).toContain(`<${await notoGids("Bye")}> Tj`);
      expect(after).not.toContain(BUNDLED_BYE);
    },
  );

  test.each(["Helvetica-BoldOblique", "Arial-BoldItalic", "Times-BoldItalic"])(
    "a regular edit of a %s run does not reuse the bold italic font",
    async (baseFont) => {
      const source = await sourceWithHi(baseFont);
      const after = await exportedOperators(source, edit({ bold: false, italic: false }));
      expect(after).toContain(BUNDLED_BYE);
      expect(after).not.toContain(`<${await notoGids("Bye")}> Tj`);
    },
  );

  test("turning bold off over a bold source font does not reuse it", async () => {
    const source = await sourceWithHi("AAAAAA+NotoSans-Bold");
    const after = await exportedOperators(source, edit({ bold: false }));
    expect(after).toContain(BUNDLED_BYE);
    expect(after).not.toContain(`<${await notoGids("Bye")}> Tj`);
  });
});

describe("Latin punctuation and accents stay searchable text", () => {
  // WinAnsi codes: “ 93, ” 94, — 97, – 96, é E9, ï EF.
  const QUOTED = "“Café” — naïve";
  const QUOTED_HEX = "<93436166E9942097206E61EF7665> Tj";

  for (const mode of ["flatten", "annotations"] satisfies ExportMode[]) {
    test(`an original-text edit with an en dash is drawn as text (${mode})`, async () => {
      const overlay = edit({ text: "1990–2000", fontFamily: "serif" });
      delete overlay.sourceBaselinesPt;
      const { bytes, lostChars } = await exportPdf(await blankPdf(), model([overlay]), {
        mode,
        unicodeFontUrl,
      });
      expect(lostChars).toBe(0);
      expect(await pageOperators(bytes)).toContain("<313939309632303030> Tj");
      expect(await pageFontNames(bytes)).toContain("Times-Roman");
    });
  }

  test("a flattened serif text box keeps quotes, dashes and accents in Times", async () => {
    const { bytes, lostChars } = await exportPdf(
      await blankPdf(),
      model([textBox({ text: QUOTED, fontFamily: "serif" })]),
      { mode: "flatten", unicodeFontUrl },
    );
    expect(lostChars).toBe(0);
    expect(await pageOperators(bytes)).toContain(QUOTED_HEX);
    expect(await pageFontNames(bytes)).toContain("Times-Roman");
  });

  test("CJK lines still fall back to outlines next to a Latin text line", async () => {
    const { bytes } = await exportPdf(
      await blankPdf(),
      model([textBox({ text: `${QUOTED}\n中文` })]),
      { mode: "flatten", unicodeFontUrl },
    );
    const after = await pageOperators(bytes);
    // The Latin line is one text-show; the CJK line adds none (outlines).
    expect(after).toContain(QUOTED_HEX);
    expect(after.match(/\bTj\b/g)?.length).toBe(1);
  });
});

describe("text that runs past its box", () => {
  test("an original-text edit draws every line on the bundled-font path", async () => {
    // Baseline 700, pitch 12: lines 3–5 sit below the 24pt-tall edit box.
    const overlay = edit({ text: "one\ntwo\nthree\nfour\nfive" });
    const { bytes, clippedChars } = await exportPdf(await blankPdf(), model([overlay]), {
      mode: "flatten",
    });
    const after = await pageOperators(bytes);
    for (const word of ["one", "two", "three", "four", "five"]) {
      expect(after).toContain(`<${asciiHex(word)}> Tj`);
    }
    expect(clippedChars ?? 0).toBe(0);
  });

  test("an original-text edit draws every line on the source-font path", async () => {
    const source = await sourceWithHi("AAAAAA+NotoSans-Regular");
    const after = await exportedOperators(source, edit({ text: "Bye\nBye\nBye\nBye" }));
    expect(after.split(`<${await notoGids("Bye")}> Tj`).length - 1).toBe(4);
    for (const y of [700, 688, 676, 664]) expect(after).toContain(`1 0 0 1 70 ${y} Tm`);
  });

  test("a flattened text box that clips lines reports the characters it left out", async () => {
    // 30pt box at 12pt (14.4pt lines): alpha, bravo, charlie fit (the third
    // partly below the edge, as on screen); delta and echo do not.
    const overlay = textBox({ text: "alpha\nbravo\ncharlie\ndelta\necho" });
    const { bytes, clippedChars } = await exportPdf(await blankPdf(), model([overlay]), {
      mode: "flatten",
    });
    expect(clippedChars).toBe("delta".length + "echo".length);
    const after = await pageOperators(bytes);
    expect(after).toContain(`<${asciiHex("charlie")}> Tj`);
    expect(after).not.toContain(`<${asciiHex("delta")}> Tj`);
  });

  test("a text box that fits reports nothing clipped", async () => {
    const overlay = textBox({ text: "alpha\nbravo" });
    const { clippedChars } = await exportPdf(await blankPdf(), model([overlay]), {
      mode: "flatten",
    });
    expect(clippedChars ?? 0).toBe(0);
  });

  // A flattened callout clips its label to the callout rect. Its text area
  // is inset 7 × 5 pt, so at 12pt (14.4pt lines) in a 30pt-tall callout at
  // y 600: alpha's baseline is 611.8 (shown), bravo's 597.4 (drawn, then cut
  // away below 600), charlie's 583.0 (not drawn). Both bravo and charlie are
  // gone from the page.
  test("a flattened callout counts a drawn line its clip cuts away", async () => {
    const overlay = callout({ text: "alpha\nbravo\ncharlie" });
    const { clippedChars } = await exportPdf(await blankPdf(), model([overlay]), {
      mode: "flatten",
    });
    expect(clippedChars).toBe("bravo".length + "charlie".length);
  });

  test("a flattened callout counts a long word that runs past its right edge", async () => {
    const word = "Supercalifragilisticexpialidocious";
    const overlay = callout({ text: word, rect: { x: 250, y: 600, w: 60, h: 60 } });
    const { clippedChars } = await exportPdf(await blankPdf(), model([overlay]), {
      mode: "flatten",
    });
    // About 190pt of Helvetica in a 60pt-wide clip: the start shows, most
    // of the word does not.
    expect(clippedChars).toBeGreaterThan(word.length / 2);
    expect(clippedChars).toBeLessThan(word.length);
  });

  test("a flattened callout whose label fits reports nothing clipped", async () => {
    const overlay = callout({ text: "alpha", rect: { x: 250, y: 600, w: 144, h: 54 } });
    const { clippedChars } = await exportPdf(await blankPdf(), model([overlay]), {
      mode: "flatten",
    });
    expect(clippedChars ?? 0).toBe(0);
  });

  test("an editable export keeps the whole text in the annotation", async () => {
    const overlay = textBox({ text: "alpha\nbravo\ncharlie\ndelta\necho" });
    const { clippedChars } = await exportPdf(await blankPdf(), model([overlay]), {
      mode: "annotations",
    });
    expect(clippedChars ?? 0).toBe(0);
  });
});

function edit(patch: Partial<ContentTextOverlay> = {}): ContentTextOverlay {
  return {
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
    ...patch,
  };
}

function textBox(patch: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "box",
    type: "text",
    pageId: "p1",
    rect: { x: 72, y: 600, w: 200, h: 30 },
    text: "",
    fontSize: 12,
    color: "#1a1815",
    bold: false,
    align: "left",
    fontFamily: "sans",
    ...patch,
  };
}

function callout(patch: Partial<CalloutOverlay> = {}): CalloutOverlay {
  return {
    id: "callout",
    type: "callout",
    pageId: "p1",
    targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
    rect: { x: 250, y: 600, w: 144, h: 30 },
    text: "",
    fontSize: 12,
    color: "#b13a2e",
    bold: false,
    align: "left",
    fontFamily: "sans",
    ...patch,
  };
}

function model(overlays: DocumentModel["overlays"]): DocumentModel {
  return { pages: [{ ...PAGE }], overlays };
}

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

// "Hi" at 12pt on baseline 700 in a FULL Noto embed (every glyph available
// to the source-font encoder), renamed to `baseFont` so the run reads as
// that style — the same /BaseFont the text layer's fontName reports.
async function sourceWithHi(baseFont: string): Promise<Uint8Array> {
  const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
  const src = await PDFDocument.create();
  src.registerFontkit(fontkit);
  const noto = await src.embedFont(fontBytes);
  src.addPage([612, 792]).drawText("Hi", { x: 72, y: 700, size: 12, font: noto });
  const doc = await PDFDocument.load(await src.save());
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of("Type"))?.toString() !== "/Font") continue;
    object.set(PDFName.of("BaseFont"), PDFName.of(baseFont));
  }
  return doc.save();
}

async function exportedOperators(
  source: Uint8Array,
  overlay: ContentTextOverlay,
): Promise<string> {
  const { bytes } = await exportPdf(source, model([overlay]), {
    mode: "annotations",
    quality: "original",
  });
  return pageOperators(bytes);
}

async function notoGids(text: string): Promise<string> {
  const fontBytes = await fetch(unicodeFontUrl).then((r) => r.arrayBuffer());
  const kit = fontkit.create(new Uint8Array(fontBytes));
  return Array.from(text)
    .map((ch) => kit.glyphForCodePoint(ch.codePointAt(0)!).id.toString(16).padStart(4, "0"))
    .join("")
    .toUpperCase();
}

function asciiHex(text: string): string {
  return Array.from(text)
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function pageOperators(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs
    .map((ref) => {
      const stream = ref instanceof PDFRawStream ? ref : doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) return "";
      const data = stream.dict.get(PDFName.of("Filter"))
        ? decodePDFRawStream(stream).decode()
        : stream.getContents();
      return new TextDecoder("latin1").decode(data);
    })
    .join("\n");
}

async function pageFontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const fonts = doc.getPage(0).node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!fonts) return [];
  return fonts.values().map((ref) => {
    const font = doc.context.lookup(ref);
    return font instanceof PDFDict
      ? (font.get(PDFName.of("BaseFont"))?.toString().slice(1) ?? "")
      : "";
  });
}
