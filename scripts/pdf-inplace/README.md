# Surgical span and fallback-font oracle

Run from the repository root:

```sh
bun scripts/pdf-inplace/surgical-first.ts
```

Requires installed bun dependencies, qpdf, pdftotext and native PDFium at
`vendor/pdfium/linux-x64/lib/libpdfium.so`; override its directory with
`SHIORI_PDFIUM_DIR`. The oracle uses `bun:ffi` and the vendored PDFium headers.
No Python, Rust build or GUI is needed.

Outputs are under `test-artifacts/pdf-inplace/surgical-first/`: before/after
PDFs, 144dpi PPM rasters, every native glyph's origin/box/path/ink evidence,
extraction, JSON acceptance report, rerun command, and a report-only 300-page
preview benchmark. All twenty-two positive scenarios and seven refusal scenarios
must pass before the command exits successfully.

## Encoding policy

`replaceRunPage` resolves `fontCoverageFromDict` once per font dictionary
object, sharing the result across resource aliases. Distinct font objects
remain distinct even when their BaseFont and embedded program agree. The
pure compiler receives only the resulting synchronous `canEncode` callback,
byte arrays, ToUnicode mapping and dictionary widths; it has no PDF objects.

Coverage is authoritative. There is no "already shown on this page" fallback:
a shown code can itself select .notdef. Missing/unverified coverage refuses
all edits, including identity and deletion. The coverage resolver's explicit
Standard-14 `assumed-standard` status is usable; Type3/vertical fonts remain
outside the compiler's supported font model.

The compiler passes the original run's codes as `preferredCodes`. At each
output code position, coverage picks a matching preferred code, otherwise its
shortest-code/ascending-byte default. A changed run may legitimately miss a
preference; identity with duplicate codes preserves the original when coverage
can segment it the same way. Ligature clusters follow `canEncode` and occupy
one encoded glyph/width, rather than one width per Unicode scalar. Returned
code boundaries and decoded ToUnicode text must agree before compilation.
Refusals preserve `reason`, `firstMissing` and its UTF-16 `offset`, and return
the original content bytes without allocating PDF objects or changing streams.

The fixed-neighbour compensation includes Tc/Tw/Tz and preserves subsequent
TJ adjustments, relative shows and line matrices. The harness never calls
GenerateContent. Type3/vertical fonts, Form targets, quote targets, clip/ExtGState-dependent targets and unknown
state refuse. MCID-only and BMC spans are editable; enclosing BDC
ActualText/Alt/E properties refuse, including named Properties resources.
Unresolvable named properties and unbalanced marked content refuse.

## Fixtures and provenance

The four compact seed PDFs (10.7–21.5 kB each) remain unchanged copies from
the native PDFium edit spike's
`artifacts/spike/fixtures/{happy,kerning,background,subset}.pdf`.

The first three already embed the **full** Foxit Serif CFF program; there is
no need to download or embed a wider font. Its original source is
`crates/shiori-core/tests/fixtures/fonts/FoxitSerif.pfb` (the extension says
PFB but its contents are raw CFF). Source SHA-256:
`4f57d2b9d884af8f907bf22df6019b52d86cbf6214fdbd02b1ae05472a543f35`.
Redistribution is permitted under the PDFium BSD terms in the adjacent
`LICENSE_FOXIT`. The existing source generator
`crates/shiori-core/tests/fixtures/make-fixtures.ts` documents the matching
Type1C descriptor, WinAnsi encoding and Times-Roman dictionary widths.

The spike omitted ToUnicode. On each run, `addFixtureAsciiMappings` adds
explicit ASCII bfchar entries to these known FoxitSerif/WinAnsi fonts before
saving each `.before.pdf`. This is extraction metadata; `canEncode` separately
checks each code's actual CFF glyph. It enables the original intents
`Hello World` → `World Hello Again` and
`Tracked words here` → `Tracked words gone`: g was never shown on those pages
but exists in the embedded program. Both before and after share this metadata.
The tagged case wraps the same happy page in Word-style MCID marked content;
the suffix-relative case installs its declared Tc/Tw/Tz/TJ stream at runtime.
The command above reproduces every augmented fixture in the artifact directory.

The subset seed contains two distinct Liberation Sans subsets sharing a
BaseFont. Its source is the existing dependency
`@docx-editor.dev/fonts/assets/LiberationSans-Regular.ttf`, under SIL OFL 1.1
(`node_modules/@docx-editor.dev/fonts/licenses/LICENSE-Liberation.txt`). Its
generation is documented in the same core fixture generator's
`font-subsets.pdf` block. No new font binary or package is introduced here.

`negativeCases.ts` creates three PDFs from the deterministic synthetic font
fixtures in `scripts/font-coverage/fixtures.ts` / `fontCoverage/fixtures/programs.ts`:
ToUnicode and Encoding advertise d while its GID is 0, d selects an empty
glyf slot, and an unsupported raw Type1 program. Original text is `San`; an
attempt to write `Sand` refuses with the missing cluster/offset. Synthetic
outlines are generated in code and need no third-party font. Stream identity,
context object count, saved bytes and re-parsed content all remain unchanged;
native PDFium and Poppler reopen/extract the refused PDFs and qpdf checks them.

## Independent native checks

The TS tokenizer reopens the SAVED before/after bytes and re-parses every raw
string code and font reference, including Form content. Expected and observed
sequences are separate manifest fields. Tests reject code/font substitutions
even with identical Unicode and width. The positive fixtures have unambiguous
Unicode inverses, so the expected sequence can be derived independently of
the production coverage encoder.

`nativePdfium.ts` reopens each PDF with native PDFium and verifies text,
embedded font-program SHA-256, and one-to-one font-object/native-handle identity.
Untouched glyphs must retain font, code, order and origins within 0.01 pt.
Generated whitespace is recorded; missing/extra/reordered source glyphs fail.
For **every replacement non-space glyph**, including identity/forced-identity,
it calls `FPDFFont_GetGlyphPath` with the **Unicode scalar**, then snapshots
every native segment's type, coordinates and close flag. The vendored header
calls the argument `glyph`; PDFium's
[implementation](https://pdfium.googlesource.com/pdfium/+/refs/heads/chromium/7881/fpdfsdk/fpdf_edittext.cpp)
maps it through `CharCodeFromUnicode`. A regression checks that CID PDF code 1
queries Unicode L's seven-segment outline, rather than the ten-segment .notdef
box returned by querying scalar 1. Positive raster ink within the native
`FPDFText_GetCharBox` remains required.

An independent native discriminator rejects outlines matching this font's
known .notdef outline, even when .notdef has ink. Unmapped-scalar queries alone
are insufficient: the synthetic simple TrueType returns null for unmapped
scalars while its .notdef has an outline. `notdefProbe.ts` therefore copies
the exact embedded program into a separate, saved `.notdef-probe.pdf`, forcing
two probe codes to GID0 via explicit zero CIDToGIDMap entries (TrueType) or
`.notdef` Differences (simple CFF). The two codes map to U+FFFE/U+FFFF for
native path lookup. CID CFF probes map both codes to CID0. Native font-data
SHA-256 must match the source program, for the probe and real font alike.
No coverage resolver is involved in constructing or comparing these probes.

`glyphEvidence.ts` requires consistent probe data and compares complete path
geometry, rather than segment count or handle identity. A match fails with
`native-notdef-match`; absent probe data, inconsistent probes and blank glyphs
have distinct failure codes. A positive coverage GID is checked afterward as
an additional guard. This GID cannot authorize a native .notdef match.

`checkNativeEvidence.ts` deliberately bypasses the compiler and renders two
bad outputs, one with an inked .notdef and one with an empty glyf entry. Both
extract `Sand`. It deliberately forges GID=7 for the inked .notdef, verifies
positive native outline/ink, and requires precisely `native-notdef-match`.
The empty glyph must fail specifically with `blank-native-glyph`. The main
command runs this self-check and writes `oracle-selfcheck.json`, PDFs/rasters,
and the separate known-GID0 probe PDFs. Focused tests cover both native
regressions when the Linux x64 library is available, alongside the pure
validator tests on every platform.

Raster comparison uses exact BGRA channels at 144dpi, flags=0, no tolerance
and edit boxes declared before rendering. Zero changed pixels are allowed
outside the box; identity cases require zero inside too. PDFium and Poppler
must both extract replacement text and omit the old phrase. qpdf must be clean.
Overflow defaults to atomic refusal with measured available/needed points.
The harness explicitly opts in for its deliberately long compensation fixtures. This is active extraction, not
forensic redaction.

The preview prototype appends a changed page dictionary, new content stream,
classic xref and `/Prev` to an unencrypted 300-page fixture. Full save uses
pdf-lib defaults with object streams. Seven measured runs follow a warmup;
both paths include complete output allocation and exclude parse/disk time.
qpdf, pdf-lib and native PDFium verify page count and first/last-page isolation.
This report-only prototype has no production save/encryption/signature contract.

## Stage 3 span/fallback acceptance

`stage3Scenarios.ts` declares nine positive and four refusal inputs before the
oracle generator. `stage3Cases.ts` writes independently addressed partial
Tj/TJ edits, original kerns, tracked/rising text and following lines, MCID,
shorter/longer runs, café/em-dash/CJK mixed fallback, overflow, cross-item, quote
and restricted-fsType refusal. Fallback cases require pdffonts to report an
embedded subset with Unicode mapping, in addition to native path/.notdef/ink
checks and qpdf. Expected code/font/Unicode sequences are checked exactly;
PDFium and Poppler extracted full text is compared after collapsing inferred
layout whitespace. Raw extraction remains in JSON/text artifacts. Edit boxes
are declared independently of rendering.

The synchronous source-font adapter remains available. The async
`replaceRunPageWithFallback` prepares fonts in a disposable document and
installs resources only after all edits compile and the page still matches.
See `src/pdf/export/contentStreamEdit/README.md` for exact byte addressing,
conservative available-space calculation, source/fallback segmentation,
fontkit writer fixes, font classes, permissions and explicit shaping limits.

`subsetFallbackCase.ts` additionally edits Sans → Sand in the real two-byte
Liberation subset seed. It asserts d is absent from source coverage and checks
that only the final s is replaced by an independently embedded fallback d.

`wordSpacingCases.ts` replaces a simple code-32 space under Tc/Tw/Tz and
emits a fallback CID 0x0020 space with a following replacement glyph. Native
origin checks require the exact -3.2pt pre-compensation delta for the CID
space (Tw=4, Tz=80%), then zero drift for untouched following text. A fallback
B shares the space's show so PDFium retains the real whitespace object. The
compiler acceptance input deliberately forces coverage misses for space/B;
real source-coverage misses are independently checked by subsetFallbackCase.
The compiler tests additionally lock literal TJ numbers and positions for
both CID 2 and CID 32, so applying Tw to CID space fails even if text extracts.

After `bun run build`, run `bun scripts/pdf-inplace/checkFallbackAssets.ts`.
Its independent Vite probe executes the default lazy loader for all twelve
DOCX Liberation faces and the two existing Noto URLs, checks cache/fetch
behavior and compares emitted bytes with both source assets and app output.
It requires exactly twelve emitted Liberation TTFs, one copy per font hash.
The report and compiled loader are in
`test-artifacts/pdf-inplace/review-round/asset-probe/`.
