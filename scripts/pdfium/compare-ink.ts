/**
 * Stage 3.5 check for fonts a PDF does not embed: pdf.js draws them with its
 * own substitutes, PDFium with its own, so the text layer (placed by glyph
 * geometry) could drift from PDFium's ink. Draws one page of unembedded
 * standard-14 text with both engines and compares each glyph's ink centre.
 * Run after `bun run test:core` has built the addon:
 *   bun scripts/pdfium/compare-ink.ts [file.pdf page]
 */
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openCoreDocument } from "../../cli/src/coreEngine";

const PPP = 4;
const REPO_ROOT = resolve(import.meta.dir, "../..");

async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const lines: Array<[StandardFonts, string]> = [
    [StandardFonts.Helvetica, "Helvetica: The quick brown fox jumps over the lazy dog 0123"],
    [StandardFonts.TimesRoman, "Times: Sphinx of black quartz, judge my vow — fi fl ff"],
    [StandardFonts.Courier, "Courier: Pack my box with five dozen liquor jugs."],
    [StandardFonts.HelveticaBold, "Helvetica Bold: WAVE AV To Ty Yo kerning pairs"],
  ];
  let y = 720;
  for (const [name, text] of lines) {
    page.drawText(text, { x: 48, y, size: 14, font: await doc.embedFont(name) });
    y -= 40;
  }
  return doc.save();
}

const [fileArg, pageArg] = process.argv.slice(2);
const bytes = fileArg ? new Uint8Array(readFileSync(fileArg)) : await sample();
const pageIndex = pageArg ? Number(pageArg) - 1 : 0;

const core = openCoreDocument(bytes);
const geometry = core.pageGeometry(pageIndex);
const width = Math.floor(geometry.width * PPP);
const height = Math.floor(geometry.height * PPP);
const pdfium = core.render(pageIndex, 0, PPP, 0, 0, width, height);
const glyphs = core.glyphs(pageIndex).filter((g) => !g.generated && g.text.trim());
core.close();

const task = pdfjs.getDocument({
  data: new Uint8Array(bytes),
  standardFontDataUrl: join(REPO_ROOT, "node_modules/pdfjs-dist/standard_fonts/"),
  cMapUrl: join(REPO_ROOT, "node_modules/pdfjs-dist/cmaps/"),
  cMapPacked: true,
});
const doc = await task.promise;
const page = await doc.getPage(pageIndex + 1);
const viewport = page.getViewport({ scale: PPP });
const canvas = createCanvas(width, height);
const context = canvas.getContext("2d");
context.fillStyle = "white";
context.fillRect(0, 0, width, height);
await page.render({ canvasContext: context, viewport } as never).promise;
const pdfjsPixels = context.getImageData(0, 0, width, height).data;
await task.destroy();

/** Ink centre inside a glyph's box, device pixels, or null when blank. */
function centre(rgba: Uint8Array | Uint8ClampedArray, box: [number, number, number, number]) {
  const [x0, y0, x1, y1] = box.map((v) => Math.round(v)) as [number, number, number, number];
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
      const i = (y * width + x) * 4;
      const darkness = 765 - (rgba[i]! + rgba[i + 1]! + rgba[i + 2]!);
      if (darkness > 150) {
        n += darkness;
        sx += x * darkness;
        sy += y * darkness;
      }
    }
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

const deltas: Array<{ text: string; dx: number; dy: number }> = [];
for (const glyph of glyphs) {
  const top = geometry.height - (glyph.loose[3] - geometry.originY);
  const bottom = geometry.height - (glyph.loose[1] - geometry.originY);
  const box: [number, number, number, number] = [
    (glyph.origin[0] - geometry.originX) * PPP,
    top * PPP,
    (glyph.end[0] - geometry.originX) * PPP,
    bottom * PPP,
  ];
  const a = centre(pdfium, box);
  const b = centre(pdfjsPixels, box);
  if (a && b) deltas.push({ text: glyph.text, dx: a.x - b.x, dy: a.y - b.y });
}
const sorted = [...deltas].sort((p, q) => Math.hypot(q.dx, q.dy) - Math.hypot(p.dx, p.dy));
const median = sorted[Math.floor(sorted.length / 2)]!;
console.log(
  JSON.stringify({
    pixelsPerPoint: PPP,
    glyphs: deltas.length,
    medianPx: +Math.hypot(median.dx, median.dy).toFixed(2),
    worst: sorted.slice(0, 6).map((d) => `${d.text} Δ(${d.dx.toFixed(2)}, ${d.dy.toFixed(2)})`),
  }),
);
