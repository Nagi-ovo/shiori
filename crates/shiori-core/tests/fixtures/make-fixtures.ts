/**
 * Regenerates text.pdf, the fixture whose geometry tests/core.rs asserts by
 * hand: plain Latin text, a rotated crop box, an /ActualText ligature, a
 * quarter-turned glyph, a glyph whose embedded ink overhangs its advance, a
 * hyphenated line break, a /ToUnicode that maps two codes to one character,
 * annotations plus a form field to draw, and a font whose descriptor gives its
 * metrics; the catalog names the language (ja-JP). Built with pdf-lib, a path
 * independent of PDFium.
 * Run: bun crates/shiori-core/tests/fixtures/make-fixtures.ts
 * locked.pdf (one blank Letter page, AES-128, user password "shiori") was made
 * once with pypdf: `uvx --with pypdf --with cryptography python`.
 * encrypted-notes.pdf: a 300 × 400 page with a Text note (4 0 obj: /Contents
 * "Encrypted note 加密" in UTF-16, /T "Reviewer") and a Highlight (5 0 obj),
 * built with pdf-lib and encrypted the same way with no user password and
 * owner password "shiori-owner", as permission-only PDFs are.
 */
import fontkit from "@pdf-lib/fontkit";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFOperator,
  PDFOperatorNames,
  PDFString,
  StandardFonts,
  beginText,
  degrees,
  endMarkedContent,
  endText,
  moveText,
  setFontAndSize,
  setTextMatrix,
  showText,
} from "pdf-lib";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const font = await doc.embedFont(StandardFonts.Helvetica);

// Page 1: plain Letter, "Shiori" in 12 pt Helvetica with its origin at (72, 700).
const plain = doc.addPage([612, 792]);
plain.drawText("Shiori", { x: 72, y: 700, size: 12, font });

// Page 2: a crop box inside the media box, turned 90°.
const cropped = doc.addPage([612, 792]);
cropped.setCropBox(36, 48, 540, 700);
cropped.setRotation(degrees(90));
// A 20 pt black square in the crop box's lower-left corner, to see where a
// rotation puts it.
cropped.drawRectangle({ x: 36, y: 48, width: 20, height: 20 });

// Page 3: an "X" marked as /ActualText (fi), the way a ligature glyph is
// tagged, then an "r" right after it at x = 72 + 8.004 (Helvetica X = 667).
const ligature = doc.addPage([612, 792]);
const f3 = ligature.node.newFontDictionary("F", font.ref);
ligature.pushOperators(
  PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
    PDFName.of("Span"),
    doc.context.obj({ ActualText: PDFString.of("fi") }),
  ]),
  beginText(),
  setFontAndSize(f3, 12),
  moveText(72, 650),
  showText(font.encodeText("X")),
  endText(),
  endMarkedContent(),
  beginText(),
  setFontAndSize(f3, 12),
  moveText(80.004, 650),
  showText(font.encodeText("r")),
  endText(),
);

// Page 4: "S" set a quarter turn counter-clockwise, origin (300, 400), and an
// "f" alone at (100, 100) in an embedded font whose ink overhangs its advance
// (added below, after the other pages, so no other object is renumbered).
const turned = doc.addPage([612, 792]);
const f4 = turned.node.newFontDictionary("F", font.ref);
turned.pushOperators(
  beginText(),
  setFontAndSize(f4, 12),
  setTextMatrix(0, 1, -1, 0, 300, 400),
  showText(font.encodeText("S")),
  endText(),
);

// Page 5: "exam-" ending one line and "ple" starting the next, which PDFium
// reads as a hyphenated word.
const hyphenated = doc.addPage([612, 792]);
hyphenated.drawText("exam-", { x: 72, y: 600, size: 12, font });
hyphenated.drawText("ple and more", { x: 72, y: 585, size: 12, font });

// Page 6: "Xi" in a Helvetica whose /ToUnicode maps both X and i to ★, so a
// lookup from ★ back to a code finds X's width (667) for the i (222) too.
const ambiguous = doc.addPage([612, 792]);
const cmap = doc.context.stream(
  [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <00> <FF> endcodespacerange",
    "2 beginbfchar <58> <2605> <69> <2605> endbfchar",
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n"),
);
const starFont = doc.context.register(
  doc.context.obj({
    Type: "Font",
    Subtype: "Type1",
    BaseFont: "Helvetica",
    Encoding: "WinAnsiEncoding",
    ToUnicode: doc.context.register(cmap),
  }),
);
const f6 = ambiguous.node.newFontDictionary("F", starFont);
ambiguous.pushOperators(
  beginText(),
  setFontAndSize(f6, 12),
  moveText(72, 500),
  showText(font.encodeText("Xi")),
  endText(),
);

// Page 7: a red Square and a blue Circle with no appearance streams (PDFium
// builds them), and a text field reading "Form value".
const annotated = doc.addPage([612, 792]);
const annot = (subtype: string, rect: number[], color: number[]) =>
  doc.context.register(
    doc.context.obj({ Type: "Annot", Subtype: subtype, Rect: rect, F: 4, C: color, BS: { W: 6 } }),
  );
annotated.node.set(
  PDFName.of("Annots"),
  doc.context.obj([
    annot("Square", [100, 500, 200, 600], [1, 0, 0]),
    annot("Circle", [300, 500, 400, 600], [0, 0, 1]),
  ]),
);
const field = doc.getForm().createTextField("name");
field.setText("Form value");
field.addToPage(annotated, { x: 100, y: 300, width: 200, height: 30 });

// Page 8: two links, one to a URL, one to page 4 fitting a rectangle.
const linked = doc.addPage([612, 792]);

// Page 9: Times-Roman described as ascent 800, descent -200, flags 34
// (serif, nonsymbolic), set at 20 pt as two text objects on one baseline:
// "One" at (72, 400) and "Two" at (150, 400).
const described = doc.addPage([612, 792]);
const times = await doc.embedFont(StandardFonts.TimesRoman);
const describedFont = doc.context.register(
  doc.context.obj({
    Type: "Font",
    Subtype: "Type1",
    BaseFont: "Times-Roman",
    Encoding: "WinAnsiEncoding",
    FontDescriptor: doc.context.obj({
      Type: "FontDescriptor",
      FontName: "Times-Roman",
      Flags: 34,
      FontBBox: [-168, -218, 1000, 898],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 662,
      StemV: 84,
    }),
  }),
);
const f9 = described.node.newFontDictionary("F", describedFont);
for (const [word, x] of [["One", 72], ["Two", 150]] as const) {
  described.pushOperators(
    beginText(),
    setFontAndSize(f9, 20),
    moveText(x, 400),
    showText(times.encodeText(word)),
    endText(),
  );
}
const pages = doc.getPages();
const ctx = doc.context;
linked.node.set(
  PDFName.of("Annots"),
  ctx.obj([
    ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [72, 700, 200, 720],
        A: { S: "URI", URI: PDFString.of("https://shiori.nagi.fun/") },
      }),
    ),
    // The same kind of link written as a UTF-16 text string, as some tools do.
    ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [72, 600, 200, 620],
        A: { S: "URI", URI: PDFHexString.fromText("https://example.com/π") },
      }),
    ),
    ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [72, 650, 200, 670],
        Dest: [pages[3]!.ref, "FitR", 10, 20, 300, 400],
      }),
    ),
  ]),
);

// The outline: "Chapter one" → page 2 at XYZ 50, 600 with a null zoom, and
// its child "第一节 Section" → page 7, FitH 500; then "Start" → page 1 through
// a GoTo action.
const outlines = ctx.nextRef();
const chapter = ctx.nextRef();
const section = ctx.nextRef();
const start = ctx.nextRef();
ctx.assign(
  chapter,
  ctx.obj({
    Title: PDFHexString.fromText("Chapter one"),
    Parent: outlines,
    Next: start,
    First: section,
    Last: section,
    Count: 1,
    Dest: [pages[1]!.ref, "XYZ", 50, 600, PDFNull],
  }),
);
ctx.assign(
  section,
  ctx.obj({
    Title: PDFHexString.fromText("第一节 Section"),
    Parent: chapter,
    Dest: [pages[6]!.ref, "FitH", 500],
  }),
);
ctx.assign(
  start,
  ctx.obj({
    Title: PDFHexString.fromText("Start"),
    Parent: outlines,
    Prev: chapter,
    A: { S: "GoTo", D: [pages[0]!.ref, "Fit"] },
  }),
);
ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: chapter, Last: start, Count: 3 }));
doc.catalog.set(PDFName.of("Outlines"), outlines);
// The document's language, for the text layer's choice of CJK glyphs.
doc.catalog.set(PDFName.of("Lang"), PDFString.of("ja-JP"));

// Page 4's "f", in Liberation Sans Italic, embedded so that no platform's
// substitute for a standard font decides its ink: it advances 569/2048 em
// (Helvetica-Oblique's 278/1000) and its ink reaches 746/2048 em, overhanging
// by 177/2048 em, 1.04 pt at 12 pt.
const italic = await doc.embedFont(
  readFileSync(join(root, "node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Italic.ttf")),
  { subset: true },
);
turned.pushOperators(
  beginText(),
  setFontAndSize(turned.node.newFontDictionary("FI", italic.ref), 12),
  moveText(100, 100),
  showText(italic.encodeText("f")),
  endText(),
);

const out = join(dirname(fileURLToPath(import.meta.url)), "text.pdf");
writeFileSync(out, await doc.save({ useObjectStreams: false }));
console.log(out);

// embedded-fonts.pdf: one page, four runs of text: "Liberation" in Liberation
// Sans embedded as TrueType, "日本" in Noto Sans JP embedded from its
// OpenType (CFF) program — a subset PDFium's FreeType does not load, so it
// draws a substitute — "Helvetica" in the standard font, not embedded, and
// "Top compact" in Foxit Serif embedded as bare CFF the way XeTeX and
// InDesign files embed theirs: /FontFile3 /Type1C, WinAnsiEncoding, no
// /ToUnicode.
const fonts = await PDFDocument.create();
fonts.registerFontkit(fontkit);
const liberation = await fonts.embedFont(
  readFileSync(join(root, "node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf")),
  { subset: true },
);
const noto = await fonts.embedFont(
  readFileSync(join(root, "src/assets/fonts/NotoSansJP-Regular.otf")),
  { subset: true },
);
const helvetica = await fonts.embedFont(StandardFonts.Helvetica);
const fontsPage = fonts.addPage([300, 200]);
fontsPage.drawText("Liberation", { x: 20, y: 150, size: 20, font: liberation });
fontsPage.drawText("日本", { x: 20, y: 100, size: 20, font: noto });
fontsPage.drawText("Helvetica", { x: 20, y: 50, size: 20, font: helvetica });
{
  // PDFium's Foxit Serif, as pdf.js shipped it: bare CFF, whatever the
  // extension says. Vendored in fonts/ with its licence (LICENSE_FOXIT,
  // PDFium's BSD terms) so the fixtures regenerate without pdf.js.
  const program = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fonts/FoxitSerif.pfb"));
  const fontFile = fonts.context.register(fonts.context.stream(program, { Subtype: "Type1C" }));
  // Foxit Serif keeps Times-Roman's metrics.
  const times = await fonts.embedFont(StandardFonts.TimesRoman);
  const widths = Array.from({ length: 95 }, (_, i) => Math.round(times.widthOfTextAtSize(String.fromCharCode(32 + i), 1000)));
  const descriptor = fonts.context.register(
    fonts.context.obj({
      Type: "FontDescriptor",
      FontName: "SHIORI+FoxitSerif",
      Flags: 34,
      FontBBox: [-168, -218, 1000, 898],
      ItalicAngle: 0,
      Ascent: 683,
      Descent: -217,
      CapHeight: 662,
      StemV: 84,
      FontFile3: fontFile,
    }),
  );
  const typeOne = fonts.context.register(
    fonts.context.obj({
      Type: "Font",
      Subtype: "Type1",
      BaseFont: "SHIORI+FoxitSerif",
      FirstChar: 32,
      LastChar: 126,
      Widths: widths,
      Encoding: "WinAnsiEncoding",
      FontDescriptor: descriptor,
    }),
  );
  fontsPage.node.setFontDictionary(PDFName.of("T1"), typeOne);
  fontsPage.pushOperators(beginText(), setFontAndSize("T1", 20), moveText(170, 150), showText(PDFString.of("Top compact")), endText());
}
const fontsOut = join(dirname(fileURLToPath(import.meta.url)), "embedded-fonts.pdf");
writeFileSync(fontsOut, await fonts.save({ useObjectStreams: false }));
console.log(fontsOut);
