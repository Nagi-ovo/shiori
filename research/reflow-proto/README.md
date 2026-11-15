# PDF-metrics-first bounded reflow spike

Standalone research crate; no app dependency or production code/test changes.
Decision/contract: [SPEC §4.9](../../docs/pdf-edit/SPEC-stage5.md#49-layout-engine-selection)
and [candidate evidence](../../docs/pdf-edit/SPEC-stage5-layout-engine.md).
Read [RESULTS.md](RESULTS.md) for all outcomes and limitations, including the
native Type1 metric failure. Geometric fits are not safe-export acceptance.

From the repository root, the **single rebuild/regeneration command** is:

```sh
bash research/reflow-proto/run.sh
```

It reads the pinned original PDFs without modifying the sibling worktree,
extracts glyphs/font programs, freezes six complete body paragraphs and their
original boxes, builds the release executable with `--locked`, runs all 24
edits and six identity controls, generates the report/JSON/six small PNGs and
dependency license listing, then checks Rust formatting and clippy. Corpus
SHA-256 mismatch or a build/tool error stops the command. Recorded layout
overflow/native discrepancies are research results, not a command failure.
No desktop app or web server is launched.

Prerequisites: Bun with this repository's locked JS dependencies installed
(`bun install --frozen-lockfile` in the repo root when needed), Rust 1.95,
Python 3 with Pillow. This VM used Bun 1.4.4, Python 3.13.5 and Pillow 13.0.0.
No Python font parser or MuPDF is used. Existing native PDFium is accessed
through the repository's `scripts/pdf-inplace/nativePdfium.ts` adapter. The
run uses the exact manifest hashes and existing fonts, not network PDF/font
downloads. Crate downloads need network on the first Cargo build.

Default paths in this worktree (override for another checkout):

```sh
CORPUS_CACHE=/workspace/shiori-wt/pdf-inplace-ui/test-artifacts/pdf-corpus/cache \
PDFIUM_LIBRARY=/workspace/shiori-wt/pdf-inplace-ui/vendor/pdfium/linux-x64/lib/libpdfium.so \
LIBERATION_TTF=/workspace/shiori-wt/pdf-inplace-ui/node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-Regular.ttf \
bash research/reflow-proto/run.sh
```

`LIBERATION_TTF` may instead point to
`node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-Regular.ttf` in
this repo (use an absolute path). No woff2 conversion or duplicate TTF is
needed: the existing DOCX dependency already contains it. Noto SC is read
from the existing `src/assets/fonts/NotoSansSC-Regular.otf`. This VM's root
`node_modules` is a temporary ignored symlink to the sibling's existing
dependency installation; no sibling files are written.

The executable also runs directly from this directory after extraction:

```sh
. "$HOME/.cargo/env"
cargo build --release --locked
./target/release/shiori-reflow-proto
```

The output binary is a Linux CLI measurement, not a cross-compiled Android
library or an incremental Tauri bundle-size result. Platforms/build flags,
font registration and shipping feature/license audits remain later gates.

## Data flow and artifacts

| File | Purpose |
|---|---|
| `extract.ts` | Read-only pdf-lib adapter using existing source-width, source-code/coverage and placement modules, plus independent native PDFium origins/ink. Dumps raw embedded programs; never changes PDF bytes. |
| `prepare.py` | Hard-coded paragraph anchors, source lines/slots and box frozen before edits. Infers gap spaces at `gap > 0.12 * size` and 0.25 em soft-join spaces for lines not ending in `-`; clears source/code/GID/native-origin/Unicode proof on those spaces. No manual whitespace reconstruction or RegionProof. |
| `src/metrics.rs` | Source-code metric adapter, verified embedded-code/GID reuse, HarfRust shaping for new fallback clusters, program-width and outline-box diagnostics. |
| `src/measured.rs` | Standalone L1 measured-token breaker, per-slot left/right/baselines, source-gap preservation, direction/finite-input checks, no origins for overflow rows. Its UAX14 set remains diagnostic; production whitelist/codec/native gates are pending. |
| `src/measured_tests.rs` | Hand-specified flush/first-line/hanging wrap and origin checks, PDF-width/gap influence, overflow/invalid-input/RTL failures. |
| `src/layout.rs` | Greedy UAX14/grapheme/prohibition-filter diagnostic layout in the frozen slots, deletion/identity controls, required overflow-line counts and direction guard. |
| `report.py` | Every case in Markdown/summary JSON; original-source provenance; six box-debug PNGs; no edited text raster. |
| `artifacts/metrics.json` | All 30 case summaries, exact output visual lines, length deltas, errors, fallback counts, failed outcomes and controlled prohibition probes. |
| `artifacts/samples.json` | Six original paragraphs, exact slots/boxes, font names/kinds/object IDs, manifest hashes/URLs/licenses and independent native source metrics. |
| `tmp/extracted.json`, `tmp/input.json` | Full input glyph positions, addresses, `/Widths` or `/W`/`DW`, source Tc/Tw/Tz basis and native matches. Ignored; regenerate. |
| `tmp/layouts.json` | Full output glyph origins, advances, GIDs/source identities and ink boxes for all cases. Overflow glyph origins are null. Ignored to avoid committing multi-MB repetitive output. |
| `tmp/fonts/` | Extracted font programs, including raw Type1 dumps. Ignored; never vendored, modified or embedded by the spike. |
| `DEPENDENCIES.md`, `Cargo.lock` | Generated declared license inventory and pinned Rust dependency versions. |

The original observed x gaps may include TJ numbers or explicit positioning;
the prototype does not prove every numeric boundary's emitting operator
recipe. It only carries the observed displacement when original neighbours
remain consecutive. That is enough to study measured-cluster layout but is
**not** a replacement for the production TJ-boundary ownership proof.

The six selections are complete body paragraphs on page 2: law's introduction,
education's definition of intelligence, ethics' AI concept, the arXiv topic
refinement diagnostics paragraph, the reviewer benchmark's corpus paragraph,
and the EHR paper's short natural-language-description paragraph. The first
arXiv selection has 15 source lines and deliberately remains a recorded
failure of the eight-line Stage-5 eligibility cap. Indented Chinese slots are
kept exactly, as required by the new §4.5 indent unit; manually selecting
these slots does not supply a paragraph/scene proof. Known foreign-script
labels, inferred English spaces/hyphens, unverified fonts, mixed state or
missing native matches are also not silently promoted to editable proofs.

Chinese inserts/expansions use **fixed token index 8**, not a detected phrase
boundary. For inserts the joined snippets are `目前人工智能行业在实际应用中发展迅猛，智能系…`,
`“智能”一词被中在实际应用中国古代的思想家们…`, and
`人工智能指的是借在实际应用中助现代科学技术。…`; education and ethics split a word.
The RESULTS generator quotes these directly from the input tokens.

Column selection is also explicit research input: `extract.ts` drops
`arxiv-2611.17030` glyphs whose origin has `x > 300 pt`, and
`arxiv-2611.17053` glyphs with `x > 310 pt`. This manual left-column x filter
is not an obstacle/paragraph proof or a PDF clip; exclusion counts regenerate
in `samples.json`. All three Chinese samples and these two arXiv samples
are indented; §4.5 now models those capacities, while their other proof
requirements remain unmet by this diagnostic runner. Education's insert
additionally breaks
after `·`/`。` outside §4.6; `.17052` insert wraps on inferred gap spaces;
the 15-line `.17030` deletion is one of the geometric fits but exceeds the
eight-line cap.

## Failure log and interpretation

- Initial extraction mistakenly treated the placement walker's full quad
  bottom edge as a baseline. Native source origins exposed the mismatch;
  the final extraction uses `coreQuad` baseline and actual displacement
  including source Tc/Tw/Tz. Original/native checks remain in the report.
- Initial candidate build used rustybuzz 0.20.1. Current upstream evidence
  showed it was archived and recommends HarfRust; the final crate and lock
  use HarfRust 0.16.0. The comparison explicitly records that maintenance
  finding. Earlier local outputs were regenerated, not counted as final.
- Shaping Unicode through extracted Chinese subsets initially returned GID0:
  some subsets do not have a usable Unicode cmap. The final code reuses the
  existing **verified PDF code→GID** mapping and PDF width for those source
  codes; only unavailable/new clusters are shaped in the explicit fallback.
  No guessed OS font, font growth or glyph identity substitution is used.
- A HarfRust constructor API mismatch and clippy `collapsible_if`/`filter_next` findings
  were corrected during implementation; final tool checks must pass.
- The final LaTeX `.17053` source/native mismatch is **unresolved** and
  intentionally retained. Its identity control shows why a zero
  dictionary-adapter error cannot certify native rendering. Unmatched native
  glyphs and unproven mappings are reported as missing evidence, not zero
  errors. No source/native conflict is waived for production.
- The review pass reproduced 218 inferred spaces carrying copied `code`,
  `nativeOrigin` and `unicodeProven` fields; these are now cleared, along with
  GID/source identity. Their positions and advances stay diagnostic heuristics.
  Every edit note now carries the full identity-control native x maximum
  (`.17053`: 0.261620 pt). Its 0.044914 pt insert/expansion figure remains
  explicitly **prefix-only**, not the paragraph's native error.
- The diagnostic breaker is intentionally wider than §4.6's shipping break
  whitelist and does not implement all kinsoku/Unicode locale tailoring.
  Controlled punctuation/mixed-script probes and corpus boundary checks are
  included; they do not claim UAX14 or JLREQ conformance.

No saved-PDF rewrite was attempted: adding the planned surgical writer,
validated RegionProof/obstacle engine and Tlm rejoin would exceed this
layout spike and violate its separation of concerns. The permitted debug
alternative is used, with original/native boxes and proposed layout boxes.
No outside-region pixel, qpdf or extraction-round-trip gate has passed.
No production test/UI/planner/export code or §7 arithmetic is changed.

All hand-written source files stay below 20,000 bytes. No code was committed
or pushed; dispatcher owns the git index as required by BRIEF.md.

The research extractor neutralizes Tr 1/2 only for numeric advances after
the shared production walker began refusing strokes. Per-sample
`stroke_geometry_only_ops` counts and row notes expose this diagnostic
adaptation. Stroke ink/paint semantics remain uncertified.

## L1 checks and integration boundary

```sh
. "$HOME/.cargo/env"
cargo test --locked --manifest-path research/reflow-proto/Cargo.toml
cargo fmt --manifest-path research/reflow-proto/Cargo.toml --check
cargo clippy --locked --manifest-path research/reflow-proto/Cargo.toml -- -D warnings
```

`break_measured(tokens, slots)` consumes measured PDF advances and relative
ink, retaining gaps only between consecutive source identities. It returns
ranges and `Option<[x,y]>` origins for authorized slots; diagnostic overflow
rows have no origin. `src/lib.rs` exposes this standalone research seam.
The full §4.9 request/response codec, whitelist/kern ownership proof, platform
bindings and native saved-PDF oracle are L2/R7/R8 work. No production caller
or wrapping flag is enabled. The Type1 integration hook remains the extractor's
per-code `width1000`/source font records: Rust never parses Type1 or discovers
fonts. Independent native identity drift is retained for every sample.
