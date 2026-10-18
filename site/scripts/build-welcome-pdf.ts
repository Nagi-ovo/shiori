// Generates site/public/welcome.pdf — a placeholder document used in
// homepage screenshots and (eventually) the in-browser demo. The PDF
// imitates an academic paper: arxiv-style header, big serif "Shiori"
// title, italic subtitle, abstract, three short body sections of Lorem
// Ipsum. Annotation-like decorations (yellow highlights, an ink-underline
// sweep, a sticky note rectangle, a checkmark stamp, a margin rectangle)
// are baked into the page graphics — not real PDF Annot dicts. That keeps
// the renderer simple and guarantees the visual fidelity in any reader,
// while still giving Shiori's annotation tools a clean canvas to draw on
// top of when a user opens the file.
//
// Run from the repo root (uses the main app's pdf-lib install):
//   bun run site/scripts/build-welcome-pdf.ts
//
// Output: site/public/welcome.pdf  (~3 pages, US Letter, ~30 KB)

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  rgb,
  type Color,
} from "pdf-lib";

// Built-in PDF base fonts. Using string literals instead of the
// `StandardFonts` enum because Bun's CJS interop on pdf-lib loses the
// enum at runtime — but the string values are stable across versions.
const FONT_BODY = "Times-Roman";
const FONT_BOLD = "Times-Bold";
const FONT_ITALIC = "Times-Italic";
const FONT_MONO = "Courier";

// ───────── geometry ─────────
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 78;
const COL_W = PAGE_W - MARGIN_X * 2;

// ───────── palette ─────────
const INK = rgb(0.06, 0.08, 0.12);
const INK2 = rgb(0.22, 0.25, 0.32);
const DIM = rgb(0.45, 0.48, 0.55);
const FAINT = rgb(0.62, 0.65, 0.72);
const HIGHLIGHT = rgb(0.957, 0.84, 0.455); // #f4d674 — Shiori's highlight yellow
const NOTE_FILL = rgb(0.992, 0.91, 0.62);
const NOTE_BORDER = rgb(0.78, 0.65, 0.32);
const ACCENT = rgb(0.2, 0.533, 0.733); // #3388bb
const STAMP_GREEN = rgb(0.165, 0.6, 0.353);

// ───────── content ─────────
// Authentic-feeling Lorem Ipsum — first sentences of de Finibus, the
// classical source for "lorem ipsum". Mixed with a few Shiori-themed
// touches in the front matter so the document doesn't read as pure filler.
const ABSTRACT =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do " +
  "eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim " +
  "ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut " +
  "aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit " +
  "in voluptate velit esse cillum dolore eu fugiat nulla pariatur.";

const SECTION_1 =
  "Sed ut perspiciatis unde omnis iste natus error sit voluptatem " +
  "accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae " +
  "ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt " +
  "explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut " +
  "odit aut fugit, sed quia consequuntur magni dolores eos qui ratione " +
  "voluptatem sequi nesciunt.";

const SECTION_1_B =
  "Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, " +
  "consectetur, adipisci velit, sed quia non numquam eius modi tempora " +
  "incidunt ut labore et dolore magnam aliquam quaerat voluptatem.";

const SECTION_2_INTRO =
  "At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis " +
  "praesentium voluptatum deleniti atque corrupti quos dolores et quas " +
  "molestias excepturi sint occaecati cupiditate non provident.";

const SECTION_2 =
  "Temporibus autem quibusdam et aut officiis debitis aut rerum necessitatibus " +
  "saepe eveniet ut et voluptates repudiandae sint et molestiae non recusandae. " +
  "Itaque earum rerum hic tenetur a sapiente delectus, ut aut reiciendis " +
  "voluptatibus maiores alias consequatur aut perferendis doloribus asperiores " +
  "repellat.";

const SECTION_3 =
  "Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam " +
  "nihil molestiae consequatur, vel illum qui dolorem eum fugiat quo voluptas " +
  "nulla pariatur. The reading does not need to phone anyone, and the marks " +
  "you make stay where you put them — bookmarks, slips of paper, tucked into " +
  "a page. That is the entire promise.";

const ECCL_QUOTE =
  "Of making many books there is no end; and much study is a weariness of the flesh.";
const ECCL_SOURCE = "— Ecclesiastes 12:12";

// ───────── helpers ─────────

type DrawOpts = {
  size: number;
  font: PDFFont;
  color?: Color;
};

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  opts: DrawOpts,
) {
  page.drawText(text, {
    x,
    y,
    size: opts.size,
    font: opts.font,
    color: opts.color ?? INK,
  });
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  cx: number,
  y: number,
  opts: DrawOpts,
) {
  const w = opts.font.widthOfTextAtSize(text, opts.size);
  drawText(page, text, cx - w / 2, y, opts);
}

function drawHRule(
  page: PDFPage,
  x1: number,
  x2: number,
  y: number,
  thickness = 0.5,
  color = INK,
) {
  page.drawLine({
    start: { x: x1, y },
    end: { x: x2, y },
    thickness,
    color,
  });
}

// Greedy word-wrap by measured width. Returns one line per array entry.
function wrap(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

type ParaOpts = DrawOpts & {
  lineHeight: number;
  // Optional first-line indent (em-quad, paragraphs after the first
  // section heading get one to match academic conventions).
  indent?: number;
  // Inclusive 1-based line numbers to render a yellow highlight under.
  highlightLines?: number[];
  // Optional underline ink stroke under specific words (matches by string).
  underlineMatch?: string;
};

// Draws a justified paragraph (last line left-aligned, like LaTeX) and
// returns the new cursor Y. Highlighted lines get a yellow band drawn
// behind the text. Optional `underlineMatch` traces a single ink
// underline below the matched substring on the line that contains it.
function drawParagraph(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  width: number,
  opts: ParaOpts,
): number {
  const { font, size, color, lineHeight, indent = 0, highlightLines = [], underlineMatch } = opts;
  const indentPx = indent ? font.widthOfTextAtSize("M", size) * 2 : 0;
  const firstLineWidth = width - indentPx;

  // Wrap once at full width, then re-wrap the first line if indent is
  // requested. Cheaper than a two-pass justify but accurate enough for
  // the placeholder.
  const lines: string[] = (() => {
    if (!indent) return wrap(text, font, size, width);
    const head = wrap(text, font, size, firstLineWidth);
    if (head.length <= 1) return head;
    const headLine = head[0]!;
    const remaining = text.slice(headLine.length).trimStart();
    return [headLine, ...wrap(remaining, font, size, width)];
  })();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineX = x + (i === 0 ? indentPx : 0);
    const lineY = y - i * lineHeight;
    const lineW = i === 0 ? firstLineWidth : width;

    if (highlightLines.includes(i + 1)) {
      const measured = font.widthOfTextAtSize(line, size);
      page.drawRectangle({
        x: lineX - 1,
        y: lineY - 2,
        width: Math.min(measured + 2, lineW + 2),
        height: size + 2,
        color: HIGHLIGHT,
        opacity: 0.55,
      });
    }

    if (underlineMatch && line.includes(underlineMatch)) {
      const before = line.slice(0, line.indexOf(underlineMatch));
      const ux = lineX + font.widthOfTextAtSize(before, size);
      const uw = font.widthOfTextAtSize(underlineMatch, size);
      // Hand-drawn-ish ink underline — slight wave via two short segments.
      page.drawLine({
        start: { x: ux, y: lineY - 1.5 },
        end: { x: ux + uw * 0.55, y: lineY - 2.4 },
        thickness: 1.2,
        color: ACCENT,
        opacity: 0.85,
      });
      page.drawLine({
        start: { x: ux + uw * 0.55, y: lineY - 2.4 },
        end: { x: ux + uw, y: lineY - 1.5 },
        thickness: 1.2,
        color: ACCENT,
        opacity: 0.85,
      });
    }

    // Justify all but the last line. Gap is distributed evenly between words.
    const isLast = i === lines.length - 1;
    if (isLast) {
      drawText(page, line, lineX, lineY, { size, font, color });
    } else {
      const words = line.split(" ");
      if (words.length === 1) {
        drawText(page, line, lineX, lineY, { size, font, color });
      } else {
        const wordsW = words.reduce(
          (sum, w) => sum + font.widthOfTextAtSize(w, size),
          0,
        );
        const gap = (lineW - wordsW) / (words.length - 1);
        let cursor = lineX;
        for (let w = 0; w < words.length; w += 1) {
          drawText(page, words[w]!, cursor, lineY, { size, font, color });
          cursor += font.widthOfTextAtSize(words[w]!, size) + gap;
        }
      }
    }
  }

  return y - lines.length * lineHeight;
}

// Sticky-note rendering — small folded square with one short line of
// "handwritten" text. Rendered as a yellow rectangle with a triangular
// fold indicator and a dim italic body. Sits in the right margin.
function drawStickyNote(
  page: PDFPage,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  italicFont: PDFFont,
) {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: NOTE_FILL,
    borderColor: NOTE_BORDER,
    borderWidth: 0.6,
    opacity: 0.95,
  });
  // Folded-corner triangle in the bottom-right.
  const fold = 8;
  page.drawLine({
    start: { x: x + width - fold, y },
    end: { x: x + width, y: y + fold },
    thickness: 0.6,
    color: NOTE_BORDER,
  });

  const lines = wrap(text, italicFont, 7.5, width - 12);
  let cursor = y + height - 12;
  for (const line of lines.slice(0, 4)) {
    drawText(page, line, x + 6, cursor, {
      font: italicFont,
      size: 7.5,
      color: rgb(0.32, 0.27, 0.18),
    });
    cursor -= 10;
  }
}

// Checkmark stamp ✓ — drawn as two short ink strokes in Shiori green.
function drawCheckmark(page: PDFPage, x: number, y: number, size = 16) {
  page.drawLine({
    start: { x, y: y + size * 0.4 },
    end: { x: x + size * 0.35, y },
    thickness: 2.2,
    color: STAMP_GREEN,
  });
  page.drawLine({
    start: { x: x + size * 0.35, y },
    end: { x: x + size, y: y + size },
    thickness: 2.2,
    color: STAMP_GREEN,
  });
}

// Page footer — small mono "Shiori · page N / total" centered at bottom.
function drawFooter(
  page: PDFPage,
  pageNum: number,
  total: number,
  font: PDFFont,
) {
  const txt = `SHIORI  ·  ${pageNum} / ${total}`;
  drawCenteredText(page, txt, PAGE_W / 2, 36, {
    font,
    size: 8,
    color: FAINT,
  });
}

// ───────── pages ─────────

function buildPage1(
  page: PDFPage,
  fonts: { body: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont },
) {
  // arxiv-style top header.
  drawText(page, "[cs.HC]", MARGIN_X, PAGE_H - 50, {
    font: fonts.mono,
    size: 8,
    color: DIM,
  });
  drawText(
    page,
    "current beta  ·  Shiori",
    MARGIN_X + 50,
    PAGE_H - 50,
    { font: fonts.mono, size: 8, color: DIM },
  );

  // Title block.
  const titleTop = PAGE_H - 130;
  drawHRule(page, MARGIN_X, PAGE_W - MARGIN_X, titleTop + 38, 1.4);
  drawCenteredText(page, "Shiori", PAGE_W / 2, titleTop, {
    font: fonts.bold,
    size: 34,
    color: INK,
  });
  drawCenteredText(
    page,
    "A Local-First Document Reader and PDF Editor",
    PAGE_W / 2,
    titleTop - 24,
    { font: fonts.italic, size: 13, color: INK2 },
  );
  drawHRule(page, MARGIN_X, PAGE_W - MARGIN_X, titleTop - 44, 0.5);

  // Author / affiliation block.
  drawCenteredText(page, "Maintained quietly", PAGE_W / 2, titleTop - 70, {
    font: fonts.body,
    size: 10.5,
    color: INK2,
  });
  drawCenteredText(page, "shiori.nagi.fun  ·  2026", PAGE_W / 2, titleTop - 86, {
    font: fonts.mono,
    size: 8.5,
    color: DIM,
  });

  // Abstract heading + body.
  const absHead = titleTop - 130;
  drawCenteredText(page, "Abstract", PAGE_W / 2, absHead, {
    font: fonts.bold,
    size: 12,
    color: INK,
  });

  const innerX = MARGIN_X + 30;
  const innerW = COL_W - 60;
  let cursor = drawParagraph(
    page,
    ABSTRACT,
    innerX,
    absHead - 22,
    innerW,
    {
      font: fonts.body,
      size: 10,
      color: INK,
      lineHeight: 13,
      // Highlight one phrase line in the middle of the abstract.
      highlightLines: [3],
    },
  );

  // Section 1 heading.
  cursor -= 28;
  drawText(page, "1.  Introduction", MARGIN_X, cursor, {
    font: fonts.bold,
    size: 12,
    color: INK,
  });
  cursor -= 18;

  cursor = drawParagraph(page, SECTION_1, MARGIN_X, cursor, COL_W, {
    font: fonts.body,
    size: 11,
    color: INK,
    lineHeight: 14,
  });

  cursor -= 14;
  cursor = drawParagraph(page, SECTION_1_B, MARGIN_X, cursor, COL_W, {
    font: fonts.body,
    size: 11,
    color: INK,
    lineHeight: 14,
    indent: 1,
  });

  // Side annotation: vertical "Page 01" rotated label, mimics arxiv.
  drawText(page, "[ shiori-paper, p. 01 ]", MARGIN_X, 60, {
    font: fonts.mono,
    size: 7,
    color: FAINT,
  });

  drawFooter(page, 1, 3, fonts.mono);
}

function buildPage2(
  page: PDFPage,
  fonts: { body: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont },
) {
  // Section 2 heading.
  let cursor = PAGE_H - 80;
  drawText(page, "2.  The Quiet Tool", MARGIN_X, cursor, {
    font: fonts.bold,
    size: 12,
    color: INK,
  });
  cursor -= 22;

  // Body paragraph that reserves the right margin for a sticky note.
  // To keep it simple we just narrow the column for the first paragraph.
  const bodyW = COL_W - 110;
  cursor = drawParagraph(page, SECTION_2_INTRO, MARGIN_X, cursor, bodyW, {
    font: fonts.body,
    size: 11,
    color: INK,
    lineHeight: 14,
    underlineMatch: "praesentium voluptatum",
  });

  // Sticky note in the right margin, anchored to the section heading.
  drawStickyNote(
    page,
    PAGE_W - MARGIN_X - 88,
    PAGE_H - 156,
    88,
    62,
    "follow-up: revisit this — the framing matters more than the example",
    fonts.italic,
  );
  // Thin connector line from the note to the underlined phrase.
  page.drawLine({
    start: { x: PAGE_W - MARGIN_X - 88, y: PAGE_H - 130 },
    end: { x: MARGIN_X + bodyW * 0.55, y: PAGE_H - 132 },
    thickness: 0.5,
    color: NOTE_BORDER,
    dashArray: [2, 2],
    opacity: 0.7,
  });

  cursor -= 16;
  cursor = drawParagraph(page, SECTION_2, MARGIN_X, cursor, COL_W, {
    font: fonts.body,
    size: 11,
    color: INK,
    lineHeight: 14,
    indent: 1,
    highlightLines: [2, 3],
  });

  // Block quote — Ecclesiastes 12:12, set in italic with an accent rule.
  cursor -= 24;
  page.drawLine({
    start: { x: MARGIN_X, y: cursor + 12 },
    end: { x: MARGIN_X, y: cursor - 36 },
    thickness: 1.6,
    color: ACCENT,
  });
  drawText(page, ECCL_QUOTE, MARGIN_X + 14, cursor, {
    font: fonts.italic,
    size: 12,
    color: INK2,
  });
  drawText(page, ECCL_SOURCE, MARGIN_X + 14, cursor - 22, {
    font: fonts.mono,
    size: 9,
    color: DIM,
  });

  drawFooter(page, 2, 3, fonts.mono);
}

function buildPage3(
  page: PDFPage,
  fonts: { body: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont },
) {
  let cursor = PAGE_H - 80;
  drawText(page, "3.  Conclusion", MARGIN_X, cursor, {
    font: fonts.bold,
    size: 12,
    color: INK,
  });
  cursor -= 22;

  cursor = drawParagraph(page, SECTION_3, MARGIN_X, cursor, COL_W, {
    font: fonts.body,
    size: 11,
    color: INK,
    lineHeight: 14,
  });

  // Margin checkmark stamp aligned to the start of the paragraph.
  drawCheckmark(page, MARGIN_X - 28, PAGE_H - 116, 14);

  // Concluding paragraph wrapped inside a thin accent rectangle —
  // mimics a real PDF "rectangle" annotation around an important point.
  cursor -= 20;
  const boxX = MARGIN_X - 6;
  const boxW = COL_W + 12;
  const boxTop = cursor + 10;
  const boxBody =
    "Annotation should feel like writing in the margin of a borrowed " +
    "book — careful, considered, yours alone. Try the highlight tool " +
    "(H), drop a sticky note (N), or pick the rectangle (R) to mark " +
    "this passage as your own.";
  const innerCursor = drawParagraph(
    page,
    boxBody,
    MARGIN_X + 6,
    cursor,
    COL_W - 12,
    {
      font: fonts.italic,
      size: 11,
      color: INK2,
      lineHeight: 14,
    },
  );
  page.drawRectangle({
    x: boxX,
    y: innerCursor - 4,
    width: boxW,
    height: boxTop - (innerCursor - 4),
    borderColor: ACCENT,
    borderWidth: 1,
    opacity: 0,
    borderOpacity: 0.85,
  });
  cursor = innerCursor - 24;

  // Closing colophon — short epigraph mirroring the app's footer. Kept
  // ASCII so the standard Times font can render it; the Japanese
  // tagline lives only on the website itself.
  cursor -= 12;
  drawCenteredText(
    page,
    "Even when you lose your way, keep reading.",
    PAGE_W / 2,
    cursor,
    { font: fonts.italic, size: 11, color: ACCENT },
  );
  drawCenteredText(
    page,
    "— shiori, 2026 —",
    PAGE_W / 2,
    cursor - 18,
    { font: fonts.mono, size: 8, color: DIM },
  );

  drawFooter(page, 3, 3, fonts.mono);
}

// ───────── entry ─────────

async function main() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Shiori — Welcome");
  pdf.setAuthor("Shiori");
  pdf.setSubject("A placeholder document for the Shiori homepage demo.");
  pdf.setKeywords(["Shiori", "PDF", "local-first", "demo"]);
  pdf.setProducer("Shiori site placeholder generator");
  pdf.setCreator("Shiori beta");

  const fonts = {
    body: await pdf.embedFont(FONT_BODY),
    bold: await pdf.embedFont(FONT_BOLD),
    italic: await pdf.embedFont(FONT_ITALIC),
    mono: await pdf.embedFont(FONT_MONO),
  };

  const p1 = pdf.addPage([PAGE_W, PAGE_H]);
  const p2 = pdf.addPage([PAGE_W, PAGE_H]);
  const p3 = pdf.addPage([PAGE_W, PAGE_H]);

  buildPage1(p1, fonts);
  buildPage2(p2, fonts);
  buildPage3(p3, fonts);

  const bytes = await pdf.save();

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, "..", "public", "welcome.pdf");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);

  const kb = (bytes.byteLength / 1024).toFixed(1);
  console.log(`✓ wrote ${outPath} (${kb} KB, 3 pages)`);
}

main().catch((err) => {
  console.error("welcome.pdf build failed:", err);
  process.exit(1);
});
