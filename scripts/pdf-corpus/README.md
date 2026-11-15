# Real-PDF editing corpus

Run from the repository root (Bun, qpdf, Poppler and Linux x64 PDFium):

```sh
bun scripts/pdf-corpus/fetch.ts
bun scripts/pdf-corpus/run.ts
bun test scripts/pdf-corpus
```

`SHIORI_PDFIUM_DIR` overrides `vendor/pdfium/linux-x64/lib`. The runner samples
at most five deterministic pages per PDF (first, quartiles, last), one
high-confidence line per page and a two-line block where detected. For a quick
pilot use `CORPUS_LIMIT=2 CORPUS_PAGES=1 bun scripts/pdf-corpus/run.ts`.

Downloads, licence-page evidence, reports, saved sample PDFs, independent
known-GID0 probe PDFs and oracle JSON live in ignored
`test-artifacts/pdf-corpus/`. `fetch.ts` verifies both bytes and SHA-256 before
using a cached or downloaded PDF; a changed upstream file fails closed.
`report.json` lists every actual edit, export time, outcome, refusal code,
skipped sample and native sample result. `report.md` gives category totals,
rates, top refusals and timing. Exit status is nonzero if any accepted sample
fails its native oracle; those failures are P0, never silently counted as passes.

## Provenance and attribution

The manifest pins 41 distinct real PDFs and records URL, SHA-256, bytes,
producer, creator, category, licence, evidence URL and verification date.
Producers/creators and tagging were read using `pdfinfo` (Info/XMP); missing
producer declarations are recorded explicitly. Categories describe origins,
not an assertion that every sampled page can be edited.

- Eight arXiv papers: CC BY 4.0 licence links were inspected on each linked
  abstract page. Saved abstract HTML is in the evidence directory. Attribution
  is to the authors and paper identified by that abstract URL; generated
  `*.after.pdf` files are Shiori test modifications, not original papers.
- Six Japanese Digital Agency open-data guidance documents: the agency's
  [copyright policy](https://www.digital.go.jp/copyright-policy) applies
  [PDL 1.0](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0),
  compatible with CC BY 4.0, and permits attributed modifications. 出典：
  デジタル庁（各 manifest URL）。加工：Shiori の PDF 編集検証。
  Logos and third-party illustrations are not edited or used as corpus targets.
- Seventeen GSA federal assessment/guidance PDFs: the agency's
  [reuse policy](https://www.section508.gov/website-policies/#reuse-and-copyright)
  identifies employee-authored material as US public domain. The selected
  reports identify GSA as author. Attribution: General Services Administration,
  Government-wide IT Accessibility Program; modified outputs are test artifacts.
  `creator` distinguishes Word/PDFMaker, tagged PDFs and an InDesign report.
- Two Internet Archive OCR scans: *The Open Court*, December 1910 (Paul Carus,
  died 1919), and the US Public Printer's 1910 annual report. Linked Commons
  file pages identify public-domain status (expired copyright / US federal
  authorship). Original download URLs point to Internet Archive.

Excluded during selection: GPT-4's arXiv report (nonexclusive distribution,
not CC BY/CC0), and SSA's alternate-text guide (express no-modification clause).
No PDF assets are intended for version control. Only the manifest and tooling
belong in the repository.

## Simplified Chinese set

Eight additional PDFs are reported under `chinese`, separately from `japanese`:

- Five Hans Chinese journal articles declare CC BY 4.0 in the article PDFs.
  Saved opening-page text preserves each explicit declaration and the PDF URLs
  are the licence evidence. Landing-page URLs are retained where resolved;
  some raw HTTP requests to those pages returned an anti-bot page, so those
  pages alone were not used to infer the licence. Authors retain attribution
  through the original title/author pages and the manifest source URL.
- One Chinese OJS article explicitly declares CC BY 4.0 on its article page;
  the actual PDF was made by **WPS 文字**, with no declared producer. The
  saved article HTML contains `DC.Rights` and the Creative Commons licence link.
- The CTEX manual is distributed under **LPPL 1.3c**. Saved `ctex.dtx` licence
  evidence explicitly permits modification and lists `ctex.pdf` as part of
  the work. Attribution: CTEX.ORG and package contributors. Derived test files
  use different names and are identified as Shiori modifications.
- The official Chinese D2L source repository declares **Apache 2.0**, and its
  README links the Chinese book edition. The saved source LICENSE/README are
  the evidence; the English edition's CC BY-SA label is deliberately not
  assigned to this edition. Attribution: Aston Zhang, Zachary C. Lipton, Mu Li,
  Alexander J. Smola and contributors. Its PDF uses Source Han Sans/Serif SC.

The set covers PDFMaker/Word 11 and 22, WPS, and two xdvipdfmx versions, subset
SimSun/SimHei CID TrueType Identity-H, Source Han SC CID Type0C Identity-H,
ctex, and mixed Simplified Han/Latin. No unverified vertical-text example is
claimed. `*.fonts.txt`, licence HTML/source text and article opening-page text
are retained under the evidence directory. A second OJS candidate timed out
and was excluded instead of assigning unverifiable PDF metadata.

Chinese sampling requires a Han-containing line. In addition to the fixed
matrix, `missingHanEdit` addresses a Han glyph with the production planner and
requires the real source font's `canEncode` to refuse the candidate. The export
then records actual font-loader calls; successful `missing-han` rows must show
`NotoSansSC-Regular.otf`. Native sampling prioritizes these outputs, including
all retained Chinese missing-Han successes up to the sample cap. To run just
this category: `CORPUS_CATEGORY=chinese bun scripts/pdf-corpus/run.ts`.

## Geometry and edit matrix

The ABI adapter reads real PDFium glyph origins, font sizes and loose
advance/ink boxes. It groups consecutive native text objects on a baseline,
then reuses the UI's `detectParagraphs`, `paragraphLineText`, cover expansion,
edit rectangle, style inference and source-baseline builders. The shortcut is
native-object grouping instead of the app's complete `pageTextFromPdfiumGlyphs`
reading-layer adapter; physical font size follows the app core's Tf × character-matrix calculation,
vertical bands use the shared UI normalization, and font names/sampled colours are not supplied, so
mixed-style or difficult-layout selections can refuse conservatively. The
paragraph confidence filter and every resulting skip are reported. OCR pages
with no selectable text are skips; OCR text that cannot be proved exact is a
counted refusal. InDesign is included even when no high-confidence line is found.

Each line receives word-character permutation using existing characters,
missing-glyph (`é`), shorter, longer, deliberate overflow, mid-word substitution,
and a Han/kana/Hangul replacement where applicable. A detected two-line block
gets a first-line edit without reflow. Cases are independent and all go through
`exportPdf` → `rebuildPdf` → the same production planner/compiler. A font-byte
loader supplies the same bundled fonts to Bun that Vite serves in the app.
Longer edits are allowed to refuse; the corpus never enables `allowOverflow`.

## Independent native acceptance

One saved success per PDF/mode is retained (up to sixteen audited samples,
deterministically sorted by category/missing-Han/mode/name). Native PDFium reopens saved
before/after bytes. The oracle checks expected native text, untouched Unicode
order/font-program identity and origin drift ≤0.01 pt, exact BGRA differences
at 144 dpi with zero pixels outside the original declared covers, replacement
paths and ink, and path inequality against two independently forced .notdef/GID0
probes of the exact saved embedded program. A positive coverage GID is only an
additional guard. qpdf must return clean and Poppler extraction must equal the
original extraction with the intended phrase replaced. Every successful audit
writes `*.oracle.json`; report JSON embeds the evidence.

The corpus oracle tests deliberately inject drift, text mismatch and one
outside-box channel change. The existing surgical oracle separately tests
inked .notdef and blank-glyph discrimination and remains a required command:

```sh
bun scripts/pdf-inplace/surgical-first.ts
```

The current conservative refusals include unknown glyph maps/fonts, Form
invocations, graphics/semantic-dependent states, source geometry that cannot be
matched exactly, reflow, and any measured overflow. Two cheap production fixes
retain geometry for untargeted unmapped fonts and split equal-scalar-count
changes at exact TJ boundaries. Length-changing changes spanning items still
refuse. The third production fix compares the UI point size with transformed
Tf rather than raw Tf, avoiding false style-change refusals in Word/WPS exports. Corpus baseline and final rates have different denominators because
the native adapter was corrected from tight ink boxes to advance/ink unions;
use the per-case reports rather than treating the rate delta as a controlled
benchmark.
