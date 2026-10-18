/*
 * Subset Shiori's brand fonts.
 *
 * Source TTFs:
 * - Klee One Regular:
 *   https://github.com/google/fonts/blob/main/ofl/kleeone/KleeOne-Regular.ttf
 * - Klee One SemiBold:
 *   https://github.com/google/fonts/blob/main/ofl/kleeone/KleeOne-SemiBold.ttf
 * - Shippori Mincho Regular:
 *   https://github.com/google/fonts/blob/main/ofl/shipporimincho/ShipporiMincho-Regular.ttf
 * - Licenses:
 *   https://github.com/google/fonts/blob/main/ofl/kleeone/OFL.txt
 *   https://github.com/google/fonts/blob/main/ofl/shipporimincho/OFL.txt
 *
 * Usage:
 *   bun scripts/subset-brand-fonts.ts
 *
 * Re-run when the brand mark glyphs change, when `T.klee` / `T.kanji`
 * starts rendering additional characters, or when replacing the source
 * TTF files under `src/assets/fonts/source/`.
 */

import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";

type SubsetFont = (
  originalFont: Uint8Array,
  text: string,
  options: { targetFormat: "woff2"; noLayoutClosure?: boolean },
) => Promise<Uint8Array>;

const require = createRequire(import.meta.url);
const subsetFont = require("subset-font") as SubsetFont;

const brandFontJobs = [
  {
    name: "Klee One Regular",
    source: "../src/assets/fonts/source/KleeOne/KleeOne-Regular.ttf",
    output: "../src/assets/fonts/ui/KleeOne-Regular-brand-subset.woff2",
    text: "Shiori",
  },
  {
    name: "Klee One SemiBold",
    source: "../src/assets/fonts/source/KleeOne/KleeOne-SemiBold.ttf",
    output: "../src/assets/fonts/ui/KleeOne-SemiBold-brand-subset.woff2",
    text: "Shiori",
  },
  {
    name: "Shippori Mincho Regular",
    source: "../src/assets/fonts/source/ShipporiMincho/ShipporiMincho-Regular.ttf",
    output: "../src/assets/fonts/ui/ShipporiMincho-Regular-brand-subset.woff2",
    text: "栞",
  },
] as const;

for (const job of brandFontJobs) {
  const sourceUrl = new URL(job.source, import.meta.url);
  const outputUrl = new URL(job.output, import.meta.url);
  const sourceBytes = await readFile(sourceUrl);
  const subsetBytes = await subsetFont(sourceBytes, job.text, {
    targetFormat: "woff2",
    // Brand strings are fixed plain glyphs ("Shiori" / "栞"). Avoiding
    // GSUB closure keeps the committed subsets tiny without affecting
    // any ligature-dependent UI text.
    noLayoutClosure: true,
  });

  await mkdir(new URL(".", outputUrl), { recursive: true });
  await writeFile(outputUrl, subsetBytes);
  console.info(`${job.name}: ${subsetBytes.byteLength.toLocaleString()} bytes`);
}
