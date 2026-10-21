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
  PDFArray,
  PDFDict,
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

// font-subsets.pdf: one page, "Liberation" and "Sans" each in its own subset
// of Liberation Sans under one name, as two papers merged into one file embed
// theirs (tests/fonts.rs, audit B108).
const subsets = await PDFDocument.create();
subsets.registerFontkit(fontkit);
const liberationSans = readFileSync(join(root, "node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf"));
const subsetsPage = subsets.addPage([300, 200]);
for (const [text, y] of [["Liberation", 150], ["Sans", 100]] as const) {
  const subset = await subsets.embedFont(liberationSans, { subset: true });
  subsetsPage.drawText(text, { x: 20, y, size: 20, font: subset });
}
// pdf-lib suffixes each subset's name ("LiberationSans-2000"). A word
// processor tags it instead, counting from the same tag in every file it
// exports, so the first font of two merged exports is "AAAAAA+LiberationSans"
// in both.
await subsets.flush();
for (const [, object] of subsets.context.enumerateIndirectObjects()) {
  if (!(object instanceof PDFDict)) continue;
  for (const key of ["BaseFont", "FontName"]) {
    const name = object.lookupMaybe(PDFName.of(key), PDFName)?.decodeText();
    if (name?.startsWith("LiberationSans-")) object.set(PDFName.of(key), PDFName.of("AAAAAA+LiberationSans"));
  }
}
const subsetsOut = join(dirname(fileURLToPath(import.meta.url)), "font-subsets.pdf");
writeFileSync(subsetsOut, await subsets.save({ useObjectStreams: false }));
console.log(subsetsOut);

// shared-program.pdf: one page, three font dictionaries under one name that
// share one embedded program (Foxit Serif, bare CFF, one /FontFile3 stream
// and one descriptor), as pdfTeX shares a Type 1 file across encodings
// (tests/fonts.rs, audit B108). Each sets an "a" (code 97, /ToUnicode
// U+0061) with its own glyph: "plain" draws the program's a (444); "caps"
// draws its A (722), as a small-caps encoding would; "swap" draws its e at
// the same 444, an equal-width swap like old-style figures. "plain" also sets
// "A" and "e", whose outlines the other two must match.
{
  const shared = await PDFDocument.create();
  const program = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fonts/FoxitSerif.pfb"));
  const ctx = shared.context;
  const fontFile = ctx.register(ctx.stream(program, { Subtype: "Type1C" }));
  const times = await shared.embedFont(StandardFonts.TimesRoman);
  const timesWidths = Array.from({ length: 95 }, (_, i) =>
    Math.round(times.widthOfTextAtSize(String.fromCharCode(32 + i), 1000)),
  );
  const descriptor = ctx.register(
    ctx.obj({
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
  const toUnicodeA = ctx.register(
    ctx.stream(
      [
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
        "1 begincodespacerange <00> <FF> endcodespacerange",
        "1 beginbfchar <61> <0061> endbfchar",
        "endcmap CMapName currentdict /CMap defineresource pop end end",
      ].join("\n"),
    ),
  );
  const dict = (glyph: string | undefined, width: number) =>
    ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "Type1",
        BaseFont: "SHIORI+FoxitSerif",
        FirstChar: 32,
        LastChar: 126,
        Widths: timesWidths.map((w, i) => (i === 97 - 32 ? width : w)),
        ...(glyph
          ? {
              Encoding: ctx.obj({
                Type: "Encoding",
                BaseEncoding: "WinAnsiEncoding",
                Differences: [97, PDFName.of(glyph)],
              }),
              ToUnicode: toUnicodeA,
            }
          : { Encoding: "WinAnsiEncoding" }),
        FontDescriptor: descriptor,
      }),
    );
  const page = shared.addPage([300, 200]);
  for (const [key, ref, text, y] of [
    ["Plain", dict(undefined, 444), "aAe", 150],
    ["Caps", dict("A", 722), "a", 100],
    ["Swap", dict("e", 444), "a", 50],
  ] as const) {
    page.node.setFontDictionary(PDFName.of(key), ref);
    page.pushOperators(beginText(), setFontAndSize(key, 20), moveText(20, y), showText(PDFString.of(text)), endText());
  }
  const sharedOut = join(dirname(fileURLToPath(import.meta.url)), "shared-program.pdf");
  writeFileSync(sharedOut, await shared.save({ useObjectStreams: false }));
  console.log(sharedOut);
}

// shared-program-beyond.pdf: one page, three more dictionaries sharing the
// Foxit Serif program (tests/fonts.rs, audit B108). "plain" is WinAnsi and
// sets "<>éè". "greater" draws /greater for code 60, which its /ToUnicode
// still calls "<": the mirror image of "<", same width, same segment count,
// same bounds. "grave" draws /egrave for code 233, which its /ToUnicode
// calls "é": the two agree on all of ASCII and part only beyond it.
{
  const shared = await PDFDocument.create();
  const program = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fonts/FoxitSerif.pfb"));
  const ctx = shared.context;
  const fontFile = ctx.register(ctx.stream(program, { Subtype: "Type1C" }));
  const times = await shared.embedFont(StandardFonts.TimesRoman);
  const timesWidths = Array.from({ length: 224 }, (_, i) => {
    try {
      return Math.round(times.widthOfTextAtSize(String.fromCharCode(32 + i), 1000));
    } catch {
      return 0;
    }
  });
  const descriptor = ctx.register(
    ctx.obj({
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
  const toUnicode = (code: string, unicode: string) =>
    ctx.register(
      ctx.stream(
        [
          "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
          "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
          "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
          "1 begincodespacerange <00> <FF> endcodespacerange",
          `1 beginbfchar <${code}> <${unicode}> endbfchar`,
          "endcmap CMapName currentdict /CMap defineresource pop end end",
        ].join("\n"),
      ),
    );
  const dict = (remap?: { code: number; glyph: string; unicode: string }) =>
    ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "Type1",
        BaseFont: "SHIORI+FoxitSerif",
        FirstChar: 32,
        LastChar: 255,
        Widths: timesWidths,
        ...(remap
          ? {
              Encoding: ctx.obj({
                Type: "Encoding",
                BaseEncoding: "WinAnsiEncoding",
                Differences: [remap.code, PDFName.of(remap.glyph)],
              }),
              ToUnicode: toUnicode(remap.code.toString(16).toUpperCase(), remap.unicode),
            }
          : { Encoding: "WinAnsiEncoding" }),
        FontDescriptor: descriptor,
      }),
    );
  const page = shared.addPage([300, 200]);
  for (const [key, ref, text, y] of [
    ["Plain", dict(), "<>éè", 150],
    ["Greater", dict({ code: 0x3c, glyph: "greater", unicode: "003C" }), "<", 100],
    ["Grave", dict({ code: 0xe9, glyph: "egrave", unicode: "00E9" }), "é", 50],
  ] as const) {
    page.node.setFontDictionary(PDFName.of(key), ref);
    page.pushOperators(beginText(), setFontAndSize(key, 20), moveText(20, y), showText(PDFString.of(text)), endText());
  }
  const beyondOut = join(dirname(fileURLToPath(import.meta.url)), "shared-program-beyond.pdf");
  writeFileSync(beyondOut, await shared.save({ useObjectStreams: false }));
  console.log(beyondOut);
}

// shared-truetype.pdf: one page, two Type0 dictionaries on one whole
// Liberation Sans program, cmap included (tests/fonts.rs, audit B108).
// "plain" is pdf-lib's own, setting "aA"; "remap" shares its descendant font
// and gives the glyph of "A" the /ToUnicode "a", as a small-caps dictionary
// would, setting "a" with it. A browser loading the program as it is draws
// "a" through the program's cmap, so only "plain" may be loaded that way.
{
  const shared = await PDFDocument.create();
  shared.registerFontkit(fontkit);
  const program = readFileSync(join(root, "node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf"));
  const plain = await shared.embedFont(program, { subset: false });
  const page = shared.addPage([300, 200]);
  page.drawText("aA", { x: 20, y: 150, size: 20, font: plain });
  await shared.flush();
  const ctx = shared.context;
  const plainDict = ctx.lookup(plain.ref) as PDFDict;
  const gid = fontkit.create(program).glyphForCodePoint(0x41).id.toString(16).toUpperCase().padStart(4, "0");
  const toUnicode = ctx.register(
    ctx.stream(
      [
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
        "1 begincodespacerange <0000> <FFFF> endcodespacerange",
        `1 beginbfchar <${gid}> <0061> endbfchar`,
        "endcmap CMapName currentdict /CMap defineresource pop end end",
      ].join("\n"),
    ),
  );
  const remap = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "Type0",
      BaseFont: plainDict.get(PDFName.of("BaseFont")),
      Encoding: "Identity-H",
      DescendantFonts: plainDict.get(PDFName.of("DescendantFonts")),
      ToUnicode: toUnicode,
    }),
  );
  page.node.setFontDictionary(PDFName.of("Remap"), remap);
  page.pushOperators(beginText(), setFontAndSize("Remap", 20), moveText(20, 100), showText(PDFHexString.of(gid)), endText());
  const truetypeOut = join(dirname(fileURLToPath(import.meta.url)), "shared-truetype.pdf");
  writeFileSync(truetypeOut, await shared.save({ useObjectStreams: false }));
  console.log(truetypeOut);
}

// shared-program-unicode.pdf and shared-program-unicode-alone.pdf: font
// dictionaries sharing the Foxit Serif program that part only at a Unicode
// value no fixed probe reaches (tests/fonts.rs, audit B108). "plain" is
// WinAnsi and sets "éè". "acute" draws /eacute and "grave" /egrave for code
// 128, which both their /ToUnicode call U+0400: the same width, the same
// answer for every probe character, two glyphs. The first file holds all
// three, written plainly; the second only "plain" and "grave", in object
// streams with a compressed /ToUnicode, as a merge writes them, so a
// dictionary's id can be checked not to depend on the others in its file.
// shared-program-presentation.pdf is the first with U+FE8E (ARABIC LETTER
// ALEF FINAL FORM) for U+0400, which PDFium's text page reads back as
// U+0627 (review of the audit fixes).
for (const [file, keys, objectStreams, unicode] of [
  ["shared-program-unicode.pdf", ["Plain", "Acute", "Grave"], false, "0400"],
  ["shared-program-unicode-alone.pdf", ["Plain", "Grave"], true, "0400"],
  ["shared-program-presentation.pdf", ["Plain", "Acute", "Grave"], false, "FE8E"],
] as const) {
  const shared = await PDFDocument.create();
  const program = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fonts/FoxitSerif.pfb"));
  const ctx = shared.context;
  const fontFile = ctx.register(ctx.stream(program, { Subtype: "Type1C" }));
  const times = await shared.embedFont(StandardFonts.TimesRoman);
  const timesWidths = Array.from({ length: 224 }, (_, i) => {
    if (i === 128 - 32) return 444;
    try {
      return Math.round(times.widthOfTextAtSize(String.fromCharCode(32 + i), 1000));
    } catch {
      return 0;
    }
  });
  const descriptor = ctx.register(
    ctx.obj({
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
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <00> <FF> endcodespacerange",
    `1 beginbfchar <80> <${unicode}> endbfchar`,
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  const dict = (glyph?: string) =>
    ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "Type1",
        BaseFont: "SHIORI+FoxitSerif",
        FirstChar: 32,
        LastChar: 255,
        Widths: timesWidths,
        ...(glyph
          ? {
              Encoding: ctx.obj({
                Type: "Encoding",
                BaseEncoding: "WinAnsiEncoding",
                Differences: [128, PDFName.of(glyph)],
              }),
              ToUnicode: ctx.register(objectStreams ? ctx.flateStream(cmap) : ctx.stream(cmap)),
            }
          : { Encoding: "WinAnsiEncoding" }),
        FontDescriptor: descriptor,
      }),
    );
  const fonts = {
    Plain: [dict(), PDFString.of("éè")],
    Acute: [dict("eacute"), PDFHexString.of("80")],
    Grave: [dict("egrave"), PDFHexString.of("80")],
  } as const;
  const page = shared.addPage([300, 200]);
  keys.forEach((key, i) => {
    const [ref, text] = fonts[key];
    page.node.setFontDictionary(PDFName.of(key), ref);
    page.pushOperators(beginText(), setFontAndSize(key, 20), moveText(20, 150 - 50 * i), showText(text), endText());
  });
  const out = join(dirname(fileURLToPath(import.meta.url)), file);
  writeFileSync(out, await shared.save({ useObjectStreams: objectStreams }));
  console.log(out);
}

// shared-truetype-beyond.pdf: shared-truetype.pdf's two Type0 dictionaries
// on one whole Liberation Sans program, except that "remap" gives the glyph
// of "A" the /ToUnicode U+0400, which no fixed probe asks about
// (tests/fonts.rs, audit B108). The program's own cmap draws U+0400 as its
// Cyrillic Ѐ, so a browser loading it as it is would set the wrong letter.
{
  const shared = await PDFDocument.create();
  shared.registerFontkit(fontkit);
  const program = readFileSync(join(root, "node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf"));
  const plain = await shared.embedFont(program, { subset: false });
  const page = shared.addPage([300, 200]);
  page.drawText("aA", { x: 20, y: 150, size: 20, font: plain });
  await shared.flush();
  const ctx = shared.context;
  const plainDict = ctx.lookup(plain.ref) as PDFDict;
  const gid = fontkit.create(program).glyphForCodePoint(0x41).id.toString(16).toUpperCase().padStart(4, "0");
  const toUnicode = ctx.register(
    ctx.stream(
      [
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
        "1 begincodespacerange <0000> <FFFF> endcodespacerange",
        `1 beginbfchar <${gid}> <0400> endbfchar`,
        "endcmap CMapName currentdict /CMap defineresource pop end end",
      ].join("\n"),
    ),
  );
  const remap = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "Type0",
      BaseFont: plainDict.get(PDFName.of("BaseFont")),
      Encoding: "Identity-H",
      DescendantFonts: plainDict.get(PDFName.of("DescendantFonts")),
      ToUnicode: toUnicode,
    }),
  );
  page.node.setFontDictionary(PDFName.of("Remap"), remap);
  page.pushOperators(beginText(), setFontAndSize("Remap", 20), moveText(20, 100), showText(PDFHexString.of(gid)), endText());
  const beyondOut = join(dirname(fileURLToPath(import.meta.url)), "shared-truetype-beyond.pdf");
  writeFileSync(beyondOut, await shared.save({ useObjectStreams: false }));
  console.log(beyondOut);
}

// shared-truetype-high.pdf: three Type0 dictionaries on one whole Liberation
// Sans program (tests/fonts.rs, review of the audit fixes for B108).
// "plain" is pdf-lib's own, setting "aAŐő"; "upper" and "lower" share its
// descendant font and give U+0400 to the glyph of "Ő" and of "ő", GIDs 274
// and 275, codes past the first 256 under Identity-H. The same width, the
// same answer for every probe character, two glyphs; the program's own cmap
// draws U+0400 as its Cyrillic Ѐ.
{
  const shared = await PDFDocument.create();
  shared.registerFontkit(fontkit);
  const program = readFileSync(join(root, "node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf"));
  const plain = await shared.embedFont(program, { subset: false });
  const page = shared.addPage([300, 200]);
  page.drawText("aA\u0150\u0151", { x: 20, y: 150, size: 20, font: plain });
  await shared.flush();
  const ctx = shared.context;
  const plainDict = ctx.lookup(plain.ref) as PDFDict;
  const face = fontkit.create(program);
  ([
    ["Upper", 0x150, 100],
    ["Lower", 0x151, 50],
  ] as const).forEach(([key, codePoint, y]) => {
    const gid = face.glyphForCodePoint(codePoint).id.toString(16).toUpperCase().padStart(4, "0");
    const toUnicode = ctx.register(
      ctx.stream(
        [
          "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
          "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
          "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
          "1 begincodespacerange <0000> <FFFF> endcodespacerange",
          `1 beginbfchar <${gid}> <0400> endbfchar`,
          "endcmap CMapName currentdict /CMap defineresource pop end end",
        ].join("\n"),
      ),
    );
    const remap = ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "Type0",
        BaseFont: plainDict.get(PDFName.of("BaseFont")),
        Encoding: "Identity-H",
        DescendantFonts: plainDict.get(PDFName.of("DescendantFonts")),
        ToUnicode: toUnicode,
      }),
    );
    page.node.setFontDictionary(PDFName.of(key), remap);
    page.pushOperators(beginText(), setFontAndSize(key, 20), moveText(20, y), showText(PDFHexString.of(gid)), endText());
  });
  const highOut = join(dirname(fileURLToPath(import.meta.url)), "shared-truetype-high.pdf");
  writeFileSync(highOut, await shared.save({ useObjectStreams: false }));
  console.log(highOut);
}

// shared-truetype-periodic.pdf: shared-truetype-high.pdf's three
// dictionaries, except that "upper" and "lower" have descendants of their
// own on the same program (second review of the audit fixes for B108).
// Both read codes 0x100-0x1FF exactly as 0x00-0xFF, as a simple font's
// would: their /CIDToGIDMap sends both to GIDs 0-255, their /ToUnicode
// gives both the same characters and their /DW the same width. They part
// at code 0x300, which they send to the glyph of "Ő" and of "ő" and their
// /ToUnicode calls U+0400.
{
  const shared = await PDFDocument.create();
  shared.registerFontkit(fontkit);
  const program = readFileSync(join(root, "node_modules/@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf"));
  const plain = await shared.embedFont(program, { subset: false });
  const page = shared.addPage([300, 200]);
  page.drawText("aA\u0150\u0151", { x: 20, y: 150, size: 20, font: plain });
  await shared.flush();
  const ctx = shared.context;
  const plainDict = ctx.lookup(plain.ref) as PDFDict;
  const plainCid = ctx.lookup((ctx.lookup(plainDict.get(PDFName.of("DescendantFonts"))) as PDFArray).get(0)) as PDFDict;
  const face = fontkit.create(program);
  const toUnicode = ctx.register(
    ctx.stream(
      [
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
        "1 begincodespacerange <0000> <FFFF> endcodespacerange",
        "2 beginbfrange <0000> <00FF> <4E00> <0100> <01FF> <4E00> endbfrange",
        "1 beginbfchar <0300> <0400> endbfchar",
        "endcmap CMapName currentdict /CMap defineresource pop end end",
      ].join("\n"),
    ),
  );
  ([
    ["Upper", 0x150, 100],
    ["Lower", 0x151, 50],
  ] as const).forEach(([key, codePoint, y]) => {
    const map = new Uint8Array(0x301 * 2);
    for (let cid = 0; cid < 0x300; cid++) map[cid * 2 + 1] = cid & 0xff;
    const gid = face.glyphForCodePoint(codePoint).id;
    map[0x600] = gid >> 8;
    map[0x601] = gid & 0xff;
    const cid = ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "CIDFontType2",
        BaseFont: plainCid.get(PDFName.of("BaseFont")),
        CIDSystemInfo: plainCid.get(PDFName.of("CIDSystemInfo")),
        FontDescriptor: plainCid.get(PDFName.of("FontDescriptor")),
        DW: 600,
        CIDToGIDMap: ctx.register(ctx.stream(map)),
      }),
    );
    const dict = ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "Type0",
        BaseFont: plainDict.get(PDFName.of("BaseFont")),
        Encoding: "Identity-H",
        DescendantFonts: [cid],
        ToUnicode: toUnicode,
      }),
    );
    page.node.setFontDictionary(PDFName.of(key), dict);
    page.pushOperators(beginText(), setFontAndSize(key, 20), moveText(20, y), showText(PDFHexString.of("0300")), endText());
  });
  const periodicOut = join(dirname(fileURLToPath(import.meta.url)), "shared-truetype-periodic.pdf");
  writeFileSync(periodicOut, await shared.save({ useObjectStreams: false }));
  console.log(periodicOut);
}
