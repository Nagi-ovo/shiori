/**
 * Stage 4.3c of docs/PLAN-RUST-PDF-CORE-2026-09.md: is the page text the
 * desktop builds from PDFium's glyphs as good for the reading layer as
 * pdf.js's? For each page of the highlight samples
 * (test-artifacts/highlight-cases/, local, not in git) it builds both and
 * compares what users meet:
 *
 * - mapped runs: text items whose every glyph the selection geometry places
 *   (mapTextContentGlyphs); an unmapped run falls back to DOM rects;
 * - semantic copy text: what a select-all copy puts on the clipboard;
 * - text layer spans.
 *
 * Needs the addon: `bun run test:core` builds it.
 * Run: bun scripts/pdfium/compare-page-text.ts [file.pdf ...]
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { openCoreDocument } from "../../cli/src/coreEngine";
import { mapTextContentGlyphs } from "../../src/editor/textSelection/glyphGeometry";
import { semanticTextContentToString } from "../../src/editor/textSelection/semanticText";
import { pdfjsPageText } from "./pdfjs-reference/pdfjsText";
import { pageTextFromPdfiumGlyphs } from "../../src/pdf/engine/pdfiumText";
import type { PdfTextItem } from "../../src/pdf/engine/text";
import type { PdfDocument, PdfPageText } from "../../src/pdf/engine/types";

const REPO_ROOT = resolve(import.meta.dir, "../..");
// Importing the app's pdf.js module points the worker at a Vite URL; in Bun
// pdf.js runs its worker in-process from the package.
pdfjsLib.GlobalWorkerOptions.workerSrc = join(
  REPO_ROOT,
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
);
const CASES = join(REPO_ROOT, "test-artifacts", "highlight-cases");
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["fable.pdf", "vocabulary.pdf"].map((name) => join(CASES, name));

type Tally = { runs: number; mapped: number; spans: number };

function tally(text: PdfPageText, into: Tally): void {
  const items = text.content.items.filter((item): item is PdfTextItem => "str" in item);
  into.spans += items.length;
  const mapped = text.glyphs ? mapTextContentGlyphs(text.content, text.glyphs) : [];
  items.forEach((item, i) => {
    if (!item.str.trim()) return;
    into.runs += 1;
    if (mapped[i]) into.mapped += 1;
  });
}

/** Characters one string has that the other lacks, whitespace ignored. */
function charDifference(a: string, b: string): number {
  const counts = new Map<string, number>();
  for (const ch of a.replace(/\s/gu, "")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  for (const ch of b.replace(/\s/gu, "")) counts.set(ch, (counts.get(ch) ?? 0) - 1);
  let diff = 0;
  for (const n of counts.values()) diff += Math.abs(n);
  return diff;
}

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const pdfjsDoc = (await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false })
    .promise) as unknown as PdfDocument;
  const core = openCoreDocument(bytes);
  const pdfjs: Tally = { runs: 0, mapped: 0, spans: 0 };
  const pdfium: Tally = { runs: 0, mapped: 0, spans: 0 };
  let samePages = 0;
  let sameIgnoringSpace = 0;
  let charDiff = 0;
  let chars = 0;
  const differing: string[] = [];
  const pages = core.pageCount();
  for (let index = 0; index < pages; index += 1) {
    const reference = await pdfjsPageText(pdfjsDoc, index);
    const glyphs = core.glyphs(index);
    const built = pageTextFromPdfiumGlyphs(glyphs, reference.content.lang);
    tally(reference, pdfjs);
    tally(built, pdfium);
    const a = semanticTextContentToString(reference.content);
    const b = semanticTextContentToString(built.content);
    chars += a.replace(/\s/gu, "").length;
    if (a === b) samePages += 1;
    if (a.replace(/\s/gu, "") === b.replace(/\s/gu, "")) sameIgnoringSpace += 1;
    else if (differing.length < 3) differing.push(`p${index + 1}: pdf.js ${JSON.stringify(a.slice(0, 120))}\n       pdfium ${JSON.stringify(b.slice(0, 120))}`);
    charDiff += charDifference(a, b);
  }
  core.close();
  await (pdfjsDoc as unknown as { destroy: () => Promise<void> }).destroy();
  console.log(`${basename(file)}: ${pages} pages`);
  console.log(`  mapped runs   pdf.js ${pdfjs.mapped}/${pdfjs.runs}   PDFium ${pdfium.mapped}/${pdfium.runs}`);
  console.log(`  spans         pdf.js ${pdfjs.spans}   PDFium ${pdfium.spans}`);
  console.log(
    `  copy text     identical ${samePages}/${pages} pages, ignoring spaces ${sameIgnoringSpace}/${pages}; ` +
      `${charDiff} of ${chars} characters differ`,
  );
  for (const line of differing) console.log(`  ${line}`);
}
