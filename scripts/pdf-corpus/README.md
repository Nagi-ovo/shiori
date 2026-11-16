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

## r20 report contract

The headline kind set excludes **only `overflow-unbreakable`**. Unsupported
rows remain in every applicable denominator. The markdown shows three rates
side by side:

- **Succeeded without overlay** (r20 headline): `(in-place + fallback-font +
  substituted + reflowed + retypeset) / headline edits`.
- **Exact-tier rate**: `(in-place + fallback-font + substituted + reflowed) /
  headline edits`, comparable to r19's 43.5% headline.
- **Old-definition exact-tier rate**: the same four exact modes divided by
  edits on all kinds except realistic `overflow` and `overflow-2`, **including
  `overflow-unbreakable`**. Compare with r19 / r18: 48.6% (645/1328).

These are recorded outcome rates. Official saved-sample oracle passes are
reported separately in the markdown and the JSON `oracle` array's `passed`
fields. No per-row corpus-wide raster oracle is inferred or claimed.

The JSON `summary` retains **all rows**, so `summary.edits === rows.length`
for compatibility. Each summary always contains numeric `in-place`,
`fallback-font`, `substituted`, `reflowed`, `retypeset` and `unsupported`
counts, including zeros. Its additional fields are:

| JSON field | Meaning |
|---|---|
| `succeededWithoutOverlay` | Count of the four exact modes plus retypeset |
| `succeededWithoutOverlayRate` | That count divided by `edits` |
| `exactTier` | Count of in-place + fallback-font + substituted + reflowed |
| `exactTierRate` | Exact-tier count divided by `edits` |
| `acceptedRate` | Compatibility alias of `succeededWithoutOverlayRate` |
| `refusalRate` | `unsupported / edits` |

All rates are zero for an empty group. `edits`, total export `ms` and the
descending `reasons` histogram retain their meanings. Each row counts only
under its recorded final mode. The JSON groups are:

- `headline`: all kinds except `overflow-unbreakable`. The r20 headline is
  `headline.succeededWithoutOverlayRate`; the r19-comparable rate is
  `headline.exactTierRate`.
- `oldDefinition`: all kinds except `overflow` and `overflow-2`. The historical
  comparison is **`oldDefinition.exactTierRate`**, not its overlay-free rate.
- `unbreakableOverflow`: only `overflow-unbreakable`, retained in the separate
  stress section with all counts and both rates.

Category/overall and Chinese-file tables use headline rows and show both
rates plus all six outcome counts. Headline refusal reasons and mean export
time use the same rows. This schema does not recompute earlier reports.

## Before/after PNG evidence

Render saved pairs without fetching documents or rerunning the corpus:

```sh
bun scripts/pdf-corpus/render-edits.ts
bun scripts/pdf-corpus/render-edits.ts --samples test-artifacts/pdf-corpus/samples --out test-artifacts/pdf-corpus/renders
```

The default selection is one accepted Chinese sample (preferring `substituted`
or `reflowed`), one LaTeX sample and one Word sample. A GSA `tagged` sample may
fill the Word slot only when no accepted Word pair exists. Selection is
deterministic. Missing categories/new Chinese modes are reported explicitly;
when any required evidence is absent, a tiny synthetic PDF pair also exercises
the native pipeline. With no samples yet, the command succeeds on that pair.
Synthetic output is labeled `smoke: true`, category `synthetic`, and supplies
no real-corpus, Word, substitution or reflow acceptance evidence.

An explicit pair accepts the existing corpus `*.edit.json` metadata, or a JSON
object with `rect`, `paragraphRect` and/or `coverRects`:

```sh
bun scripts/pdf-corpus/render-edits.ts --before before.pdf --after after.pdf --edit edit.json --page 0
```

Rectangles use `{x, y, w, h}` in unrotated PDF points relative to the visible
page box, with the bottom-left origin used by app overlays. `--page` is the
zero-based index **inside the saved pair**, default 0; the original corpus
`row.page`/`page.sourceIndex` is not an index into a single-page saved sample.
The crop unions the edit/paragraph rectangles and, when present,
`row.outcome.reflow.region.mask` (falling back to `region.box` for older
manifests), so recorded downward growth is included.
`--margin` defaults to 8 points, clamped to page edges. Page rotation is
applied using the app's coordinate conversion. Different before/after page
boxes or rotations and invalid/off-page geometry fail clearly.

The existing native PDFium adapter produces 144-dpi BGRA rasters, converted
to lossless RGBA PNG. Each selection writes `.before.png`, `.after.png` and
`.pair.png` under `test-artifacts/pdf-corpus/renders/`. Pairs place before on
the left and after on the right with a white gutter. `manifest.json` records
the source PDF SHA-256 values, mode/category, page, pixel crop and filenames;
the adjacent `README.md` includes the exact regeneration command. These
images are visual evidence, not a replacement for the independent oracle.

```sh
bun test scripts/pdf-corpus/report.test.ts scripts/pdf-corpus/render-edits.test.ts
```

The render smoke test creates an empty sample directory, runs the CLI, checks
that native before/after PNGs differ, and replays the same inputs through the
explicit-pair route. It requires the native library (and otherwise skips),
but does not require the 41-PDF corpus, qpdf, Poppler or a network request.

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

Each line receives these kinds in stable order: `same-length` (word-character
permutation using existing characters), `missing-glyph` (`é`), `shorter`,
`longer`, `overflow`, `overflow-2`, `overflow-unbreakable`, `substring`
(mid-word substitution), then `cjk` (Han/kana/Hangul replacement) where applicable.
Identity edits are dropped; an empty line produces no edits.

`overflow` and `overflow-2` append a natural phrase to the original line,
targeting final Unicode code-point lengths of 125% and 155% respectively.
These are mild and stronger wrapping probes; actual wrapping depends on the
source measure. Fixed phrase banks prefer candidates in the +10–60% growth
band, then the closest target length, with bank order breaking ties. If even
the shortest phrase exceeds +60% on a short line, it is kept intact. No font
metrics, randomness, I/O or word fragments are used to choose a phrase.
Latin/digit/punctuation lines receive ASCII words with spaces and a separating
space unless the line already ends in whitespace. Han without kana receives a
Chinese clause using everyday characters covered by Noto Sans SC / Source Han;
any Hiragana or Katakana selects a Japanese clause using everyday kana and
common kanji covered by Noto Sans JP. Hangul-only lines use the Latin bank to
avoid introducing additional CJK glyph requirements in a layout probe. Neither
realistic variant adds accented missing-glyph bait.

`overflow-unbreakable` preserves the exact old stress construction: replace
the first ASCII word of at least three letters (or the first three code points
as the existing fallback) with eight copies of itself, retaining the old
replacement span. It does not append and is excluded only from headline
statistics, not from execution or the compatible all-row `summary`.

A detected two-line block gets a first-line edit without reflow. Cases are
independent and all go through
`exportPdf` → `rebuildPdf` → the same production planner/compiler. A font-byte
loader supplies the same bundled fonts to Bun that Vite serves in the app.
Longer edits are allowed to refuse; the corpus never enables `allowOverflow`.

## Independent native acceptance

One saved success per PDF/mode is retained (up to sixteen audited samples,
deterministically selected for category/mode diversity and Chinese
missing-Han). `selectOracleSamples` includes `retypeset` and excludes
`unsupported` and unknown modes; `auditCorpusSample` also rejects unsupported
before opening a sample. `run.ts` passes the entire saved outcome, including
`fidelity` and the paragraph manifest, to the audit.

**Exact tier.** In-place, fallback-font, substituted and reflowed
samples retain the existing native Unicode, font-program/outline/origin and
replacement-glyph proofs, the strict zero-pixel-outside-cover/proved-mask
checks (including the reflow raster veto), qpdf and strict Poppler expectation.
Approximate rows never enter those raster vetoes.

**Retypeset gate.** `mode === 'retypeset'` or `fidelity === 'approximate'`
selects `compareRetypesetNativePages`. PDFium reopens the saved before/after
PDFs and renders BGRA at 144 dpi. Source text is located at the edit's native
glyph origins and cover rectangles; an identical old phrase elsewhere may
remain. The requested local replacement must extract at the original anchor
(within 0.01 pt), with the rest of the owned paragraph's Unicode preserved.
`retypesetSourceOwnership` reads the immutable source's text frames, graphics
and marked scopes and paragraph groups to identify the paragraph tail from
the first edited line. The manifest's coarse `paragraphBox` never grants
ownership of every object inside it. Without source ownership the comparator
only authorizes the selected span. Earlier lines and unrelated text keep
native Unicode, font program, outline, multiplicity and origins (within
0.01 pt). `assertRetypesetStreamIdentity` additionally checks their saved
character codes, font identity and quads, including invisible spaces. Source
operator/item/byte identities keep coincident unrelated objects distinct.

`compareRetypesetRaster` requires every changed pixel to lie within
**old-glyph ink mask ∪ new text box**, dilated by exactly **one raster pixel
(Chebyshev distance; 0.5 pt at 144 dpi)** for edge antialiasing/strokes. Old ink
is nonwhite before-raster coverage inside PDFium's tight glyph ink bounds,
not the loose advance boxes or edit covers. The new text box bounds only the
owned output's native glyph boxes, including wraps/downward growth. This is
a separate approximate mask; no tier-1 proved-region mask or old-ink/backdrop
veto is applied. Oracle JSON exposes `changedPixelsOutsideRetypesetMask`,
`maskDilationPx`, `newTextBox`, `untargetedGlyphs`, `untargetedStreamGlyphs` and
`oracleTier: 'retypeset'`.

Every nonspace output glyph needs native path and ink, and an outline
distinct from two independently forced .notdef/GID0 probes using the same
native font program. Embedded replacements reuse the existing probe builder;
unembedded Type1 reuse has a retypeset-only probe whose program hash must
also match. Available coverage GIDs must remain positive. Both tiers run
`qpdf --check` on before and after. After diagnostics must be a multiset subset
of before, with no worse exit (errors are worse than warnings). Paths are
normalized; shifted offsets/object IDs are equivalent only for the same
encoded stream fingerprint, including its decoding settings. Other locations
remain literal, so an unrecognized relocation conservatively fails. A new
damaged stream cannot replace an old warning of the same kind. Oracle JSON
records `qpdf: 'clean'` when no new issue exists, plus source/inherited issue
counts when the source was noisy.

Poppler independently accounts for every extracted nonspace scalar change in
retypeset output: its signed before/after scalar delta must equal PDFium's.
This allows spatial reading-order differences after wrapping and inherited
engine differences (the native helper exposes PDFium's line-end hyphen marker
as U+0002 while Poppler extracts `-`). No scalars are globally remapped or
dropped; a missing/extra wrapped character still changes the delta and fails.
Oracle JSON records the comparison and source differences. The native gate
enforces local sequence and position. Exact-tier Poppler
checks remain strict. Successful audits write `*.oracle.json`, embedded in
the report's separate sample evidence.

Focused tests (no corpus downloads/run or PNG generation):

```sh
bun test scripts/pdf-corpus/oracle.test.ts scripts/pdf-corpus/report.test.ts scripts/pdf-corpus/reflowOracle.test.ts scripts/pdf-corpus/retypesetOracle.test.ts scripts/pdf-corpus/retypesetStreamOracle.test.ts scripts/pdf-corpus/retypesetNative.test.ts scripts/pdf-corpus/selectOracleSamples.test.ts
```

The native retypeset test saves wrapped Latin and bundled-subset Chinese
production exports (including unembedded Type1 descriptor reuse), their
audit JSON, duplicate old text elsewhere and an
inked-tofu corruption under `test-artifacts/retypeset-oracle-m2/`. Its adjacent
README records the regeneration command. Pure tests inject wrong-position
replacement, retained old text, neighbour deletion/font/code/position changes,
mask-hole/outside pixels and missing raster/glyph evidence. The separate
existing surgical oracle remains available as `bun scripts/pdf-inplace/surgical-first.ts`.
