/**
 * Stage 2.2 of docs/PLAN-RUST-PDF-CORE-2026-09.md: does PDFium put every
 * glyph where the app's pdf.js geometry does? Compares shiori-core's
 * characters with the pdf.js baselines in test-artifacts/highlight-cases/
 * (<name>-glyphs.json, the app's own glyph geometry; local, not in git).
 * Run: bun scripts/pdfium/compare-glyphs.ts [name ...]   (default: fable vocabulary)
 * Exits non-zero when any glyph's origin or end is off by more than 0.01 pt.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchPdfium, hostPdfiumTarget } from "./fetch";

type Point = { x: number; y: number };
type PdfjsPage = {
  page: number;
  glyphs: Array<{ text: string; origin: Point; end: Point }>;
};
type CorePage = {
  page: number;
  chars: Array<{
    text: string;
    origin: [number, number];
    end: [number, number];
    angle: number;
    generated: boolean;
  }>;
};

const TOLERANCE_PT = 0.01;
const REPO_ROOT = resolve(import.meta.dir, "../..");
const CASES = join(REPO_ROOT, "test-artifacts", "highlight-cases");

const target = hostPdfiumTarget();
const lib = join(await fetchPdfium(target), target.startsWith("win") ? "bin" : "lib");

function coreChars(pdf: string): CorePage[] {
  const run = spawnSync(
    "cargo",
    [
      "run", "-q", "--release",
      "--manifest-path", join(REPO_ROOT, "crates/shiori-core/Cargo.toml"),
      "--example", "dump_chars", "--", lib, pdf,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as CorePage[];
}

const normalize = (text: string) => text.normalize("NFKC");
let failed = false;

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["fable", "vocabulary"]) {
  const pdfjs = JSON.parse(
    readFileSync(join(CASES, `${name}-glyphs.json`), "utf8"),
  ) as PdfjsPage[];
  const core = coreChars(join(CASES, `${name}.pdf`));
  let matched = 0;
  let maxOrigin = 0;
  let maxEnd = 0;
  const unmatched: string[] = [];
  const worst: string[] = [];
  for (const page of pdfjs) {
    const chars = core[page.page - 1]?.chars.filter((ch) => !ch.generated) ?? [];
    for (const glyph of page.glyphs) {
      const text = normalize(glyph.text);
      if (!text.trim()) continue;
      let best: (typeof chars)[number] | null = null;
      let bestDistance = Infinity;
      for (const ch of chars) {
        if (normalize(ch.text) !== text) continue;
        const d = Math.hypot(ch.origin[0] - glyph.origin.x, ch.origin[1] - glyph.origin.y);
        if (d < bestDistance) {
          best = ch;
          bestDistance = d;
        }
      }
      if (!best) {
        unmatched.push(`p${page.page} ${JSON.stringify(text)}`);
        continue;
      }
      matched += 1;
      const endError = Math.hypot(best.end[0] - glyph.end.x, best.end[1] - glyph.end.y);
      maxOrigin = Math.max(maxOrigin, bestDistance);
      maxEnd = Math.max(maxEnd, endError);
      if ((bestDistance > TOLERANCE_PT || endError > TOLERANCE_PT) && worst.length < 8) {
        worst.push(
          `p${page.page} ${JSON.stringify(text)} origin Δ${bestDistance.toFixed(4)} end Δ${endError.toFixed(4)}`,
        );
      }
    }
  }
  const ok = unmatched.length === 0 && maxOrigin <= TOLERANCE_PT && maxEnd <= TOLERANCE_PT;
  failed ||= !ok;
  console.log(
    JSON.stringify({
      name,
      ok,
      matched,
      unmatched: unmatched.length,
      maxOriginErrorPt: +maxOrigin.toFixed(5),
      maxEndErrorPt: +maxEnd.toFixed(5),
      unmatchedExamples: unmatched.slice(0, 8),
      over: worst,
    }),
  );
}
process.exit(failed ? 1 : 0);
