# Surgical same-font oracle

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
preview benchmark. All ten positive scenarios and three refusal scenarios
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
GenerateContent. Partial string spans, fallback fonts, Type3/vertical fonts,
Form targets, quote targets, clip/ExtGState-dependent targets and unknown
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
it collects `FPDFFont_GetGlyphPath` using the actual source code and requires
positive segment count, plus positive raster ink within `FPDFText_GetCharBox`.
It also requires a positive integer GID resolved from the saved font's
rendering encoding/program; the native font-program hash links that GID to
the font PDFium actually loaded. This matters because .notdef can have both
an outline and ink. `glyphEvidence.ts` refuses GID 0 and absent, empty or
missing evidence. Native path and ink ensure extraction alone cannot stand
in for a rendered replacement.

`checkNativeEvidence.ts` deliberately bypasses the compiler and renders two
bad outputs, one with an inked .notdef and one with an empty glyf entry. Both
extract `Sand` but must fail the glyph-evidence validator. The main command
runs this self-check and writes `oracle-selfcheck.json` plus the PDFs/rasters.

Raster comparison uses exact BGRA channels at 144dpi, flags=0, no tolerance
and edit boxes declared before rendering. Zero changed pixels are allowed
outside the box; identity cases require zero inside too. PDFium and Poppler
must both extract replacement text and omit the old phrase. qpdf must be clean.
Long replacements may overlap neighbours under the fixed-position policy;
fit/overflow UX remains a separate concern. This is active extraction, not
forensic redaction.

The preview prototype appends a changed page dictionary, new content stream,
classic xref and `/Prev` to an unencrypted 300-page fixture. Full save uses
pdf-lib defaults with object streams. Seven measured runs follow a warmup;
both paths include complete output allocation and exclude parse/disk time.
qpdf, pdf-lib and native PDFium verify page count and first/last-page isolation.
This report-only prototype has no production save/encryption/signature contract.
