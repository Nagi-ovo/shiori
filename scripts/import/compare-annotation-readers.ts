/**
 * Stage 4.4 of docs/PLAN-RUST-PDF-CORE-2026-09.md: does importing a file's
 * annotations through the file reader (pdf-lib, src/pdf/import/
 * sourceAnnotations.ts) give what importing through pdf.js gave? Imports
 * every page of each PDF both ways and compares the overlays and the
 * annotations claimed from the canvas.
 * Run: bun scripts/import/compare-annotation-readers.ts [file.pdf ...]
 *      (default: every PDF under test-artifacts/, local, not in git)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { importPdfAnnotations } from "../../src/pdf/import/annotations";
import type { PdfDocument } from "../../src/pdf/engine/types";
import type { PageModel } from "../../src/pdf/model/types";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function pdfsUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pdfsUnder(path);
    return name.toLowerCase().endsWith(".pdf") ? [path] : [];
  });
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : pdfsUnder(join(REPO_ROOT, "test-artifacts"));
let failed = false;

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const pages: PageModel[] = [];
  for (let i = 0; i < doc.numPages; i += 1) {
    const view = (await doc.getPage(i + 1)).view;
    pages.push({
      id: `p${i}`,
      sourceIndex: i,
      rotation: 0,
      widthPt: view[2]! - view[0]!,
      heightPt: view[3]! - view[1]!,
      originXPt: view[0],
      originYPt: view[1],
    });
  }
  const run = async (annotationReader: "file" | "pdfjs") => {
    const claimed: string[] = [];
    const reported: unknown[] = [];
    const proxy = new Proxy(doc, {
      get(target, key) {
        if (key === "annotationStorage") {
          return { setValue: (id: string, value: { noView?: boolean }) => value.noView && claimed.push(id) };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as PdfDocument;
    const start = performance.now();
    const overlays = await importPdfAnnotations(proxy, pages, bytes, 0, {
      annotationReader,
      onSuppress: (index, annotation) => reported.push([index, annotation]),
    });
    return { overlays, claimed, reported, ms: performance.now() - start };
  };
  const pdfjs = await run("pdfjs");
  const fromFile = await run("file");
  await doc.destroy();
  const same = (key: "overlays" | "claimed" | "reported") => isDeepStrictEqual(fromFile[key], pdfjs[key]);
  const ok = same("overlays") && same("claimed") && same("reported");
  failed ||= !ok;
  console.log(
    `${ok ? "same" : "DIFF"}  ${relative(REPO_ROOT, file)}: ${pages.length} pages, ` +
      `${pdfjs.overlays.length} overlays, ${pdfjs.claimed.length} claimed; ` +
      `pdf.js ${pdfjs.ms.toFixed(0)} ms, file ${fromFile.ms.toFixed(0)} ms`,
  );
  if (!ok) {
    for (const key of ["overlays", "claimed", "reported"] as const) {
      if (same(key)) continue;
      const a = pdfjs[key] as unknown[];
      const b = fromFile[key] as unknown[];
      const i = a.findIndex((item, index) => !isDeepStrictEqual(item, b[index]));
      console.log(`  ${key}: pdf.js ${a.length}, file ${b.length}; first difference at ${i}`);
      console.log(`    pdf.js ${JSON.stringify(a[i])?.slice(0, 400)}`);
      console.log(`    file   ${JSON.stringify(b[i])?.slice(0, 400)}`);
    }
  }
}
process.exit(failed ? 1 : 0);
