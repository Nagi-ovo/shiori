# Stage-5 layout engine evidence and decision

Decision record, 2026-11-15. Normative contract: [§4.9](SPEC-stage5.md#49-layout-engine-selection).
This is a layout service selection, not permission to ship reflow or replace
the PDF reader, font resolver, compiler, assembler or renderer. The research
[runner](../../research/reflow-proto/README.md) and
[results](../../research/reflow-proto/RESULTS.md) are a small fixed-box spike,
not O0 or evidence for changing §7's acceptance arithmetic.

## Evidence discipline

**E** means an inspected upstream manifest, documented API/source or this
prototype's measured behavior. **I** means an engineering inference; in
particular no Android binary, iOS binary or Tauri size delta was measured.
Support for a font file is not support for PDF character codes, CIDToGIDMap,
ToUnicode, PDF widths, raw Type1, or an export permission. All five candidates
need Shiori's separate verified mapping/embedding rules.

Primary-source snapshot links below pin the inspected revisions where
possible. Current releases and development main can have different APIs.
No candidate was assumed to retain the stack described in an old blog post.

| Candidate | License and maintenance evidence | Desktop/Android integration and size |
|---|---|---|
| **cosmic-text** | **E:** 0.19.0 manifest is MIT OR Apache-2.0. System76's text library; October 2026 main updates. Main now uses **HarfRust**, fontdb, Skrifa, optional Swash and unicode-linebreak/unicode-bidi. **I:** more established editor functionality than our bounded layout service; its maintenance is not a promise of PDF metric hooks. [manifest](https://github.com/pop-os/cosmic-text/blob/b07cb90a872cb9fec7fea1c72d734f81907fe3ad/Cargo.toml), [README](https://github.com/pop-os/cosmic-text/blob/b07cb90a872cb9fec7fea1c72d734f81907fe3ad/README.md) | **E:** pure Rust; Android build fixes appear in its changelog; system font features are optional. **I:** can run behind Tauri on desktop/Android with explicit font data, without Apple APIs. More font-discovery/raster/cache machinery than needed here; disabling those features helps. Actual app delta **unmeasured**. |
| **Parley (+ Skrifa / optional Swash rendering)** | **E:** main workspace 0.12.0 is Apache-2.0 OR MIT, actively changing in November 2026. Current README names **Fontique, HarfRust, Skrifa, ICU4X**, not Swash as the shaper. Swash remains a rendering example/dependency, not the paragraph contract. [workspace manifest](https://github.com/linebender/parley/blob/f6adbb50b4733e458b6962d66dd82f642cfd3525/Cargo.toml), [README](https://github.com/linebender/parley/blob/f6adbb50b4733e458b6962d66dd82f642cfd3525/README.md) | **E:** Rust and optional system-font backend; a rendering library is not required for layout. **I:** suitable Tauri desktop/Android architecture with bundled fonts, but platform builds were not run. ICU data, font matching and shaping have a cost; smaller than bringing a new C++ graphics stack is an inference. No measured app-size number. |
| **Hand-rolled rustybuzz + unicode-linebreak + unicode-bidi + bounded breaker** | **E:** rustybuzz 0.20.1 is MIT, **archived July 26, 2026**, README recommends HarfRust. unicode-linebreak 0.1.5 is Apache-2.0, last inspected main commit July 2023; unicode-bidi 0.3.18 is MIT OR Apache-2.0. Mature constituent algorithms do not make a new paragraph engine mature. [rustybuzz](https://github.com/harfbuzz/rustybuzz/blob/9faca967408677f17bc15366dbdc3d2b683d1489/README.md), [linebreak](https://github.com/axelf4/unicode-linebreak/blob/829adeed3c07ed160c1c721b61806eb902a4c1f0/Cargo.toml), [bidi](https://github.com/servo/unicode-bidi/blob/9a8c7b03be01def5cf7014b89d5af90f7382fdad/Cargo.toml) | **E:** these components have no mandatory OS text API. **I:** smallest scope to audit for PDF-code provenance, but Shiori owns the breaker and prohibition policy. **Decision:** use the maintained **HarfRust 0.16.0 successor** in this layered design, not archived rustybuzz. The prototype reports a Linux executable size; this includes CLI/JSON and is not a Tauri/Android delta. |
| **Skia SkParagraph** | **E:** Skia's BSD-3-Clause license, long-lived production graphics/text stack. SkParagraph has separate font collection, Unicode/line analysis and paragraph layout interfaces. Third-party dependencies have their own notices. [license](https://github.com/google/skia/blob/5736c298cd2fd98a615dd47e8295a80019a1c112/LICENSE), [paragraph API](https://github.com/google/skia/blob/5736c298cd2fd98a615dd47e8295a80019a1c112/modules/skparagraph/include/Paragraph.h), [Unicode API](https://github.com/google/skia/blob/5736c298cd2fd98a615dd47e8295a80019a1c112/modules/skunicode/include/SkUnicode.h) | **E:** native C++ stack, Unicode backends are configurable; Rust requires a binding/build boundary. **I:** desktop/Android are practical targets, but adding Skia plus text/Unicode dependencies to a PDFium app is the largest integration/build burden here. Do not invent MB estimates without matched builds; not measured. |
| **harfbuzzjs + TS line breaking** | **E:** wrapper MIT, HarfBuzz's own permissive Old MIT notice also applies; package 1.6.4 in inspected main. Shapes explicit font bytes and exposes glyphs/positions; not a paragraph engine. [manifest](https://github.com/harfbuzz/harfbuzzjs/blob/44e4a4eff08f77391c904b7c962b8bcb9be40127/package.json), [README](https://github.com/harfbuzz/harfbuzzjs/blob/44e4a4eff08f77391c904b7c962b8bcb9be40127/README.md), [HarfBuzz license](https://github.com/harfbuzz/harfbuzz/blob/main/COPYING) | **E:** WASM/JS font-byte API. **I:** viable in Tauri webviews on desktop/Android and web, but duplicates a native shaping payload if Rust also needs it. Requires a TS/WASM paragraph breaker and conservative capability startup check. ICU4X segmenter bindings or an audited UAX14 implementation would be additional dependencies, not functionality supplied by harfbuzzjs. Bytes/startup/memory unmeasured. |

| Candidate | CJK / Han+Latin, UAX14 and kinsoku | Justification capability | Embedded TT/CFF and exact PDF metrics |
|---|---|---|---|
| cosmic-text | **E:** multilingual shaping, script/font fallback, unicode-linebreak; CJK examples. **I:** default UAX14 does not prove complete Japanese/Chinese locale-specific prohibition behavior. Must inspect pinned rules and intersect with §4.6. | **E:** alignment/justification exists. Stage 5 does not turn it on. | **E:** memory-loaded font data and positioned glyph output. **I:** ordinary shaping uses program advances, not PDF `/Widths`/CID widths plus source TJ boundaries. No inspected public PDF-code/per-cluster-width contract; would require an adapter before breaking (not a post-layout origin patch), likely lower-level customization. |
| Parley | **E:** ICU4X segmentation, rich script/fallback handling. **I:** promising CJK basis; a locale-specific kinsoku conformance claim still needs cases. Newer Unicode analysis is an advantage over frozen unicode-linebreak tables. | **E:** `Alignment::Justify` and adjusted cluster advances. [run API](https://github.com/linebender/parley/blob/f6adbb50b4733e458b6962d66dd82f642cfd3525/parley/src/layout/run.rs) | **E:** explicit font resources and glyph/cluster advances; Skrifa supports SFNT TrueType/OpenType CFF outlines. **I:** no inspected public per-source-code PDF metrics injection. Changing reported glyph positions after paragraph layout cannot fix already-wrong wraps. Use only with a mandatory pre-break metrics adapter; not selected merely for nicer layout. |
| Small PDF-first breaker + HarfRust | **E:** prototype handles Han, Latin and mixed-script diagnostic input; UAX14 candidate generator plus explicit prohibition filter. **I:** incomplete locale kinsoku coverage, older linebreak data and a new breaker are real maintenance risks. unicode-bidi is a **reject-RTL guard**, not permission to enable bidi layout. | No full justification implemented. **I:** possible with owned spacing recipes, but deliberately excluded. | **E:** unchanged source clusters bypass Unicode reshaping; adapter uses PDF dictionary advances and preserves boundary gaps. Verified source replacement codes can use original GIDs even when subset cmap is absent; HarfRust shapes newly needed fallback clusters. TT and SFNT CFF supported; naked PDF CFF needs a validated wrapper/existing parser adapter; raw Type1 deferred. Exact advances are an explicit input, not an OS-font assumption. |
| SkParagraph | **E:** paragraph wrapping, Unicode break interfaces, script shaping and font collection. **I:** CJK is a normal use case but exact Chinese/Japanese tailoring depends on configured Unicode backend/policies; not measured here. | **E:** paragraph text alignment includes justification. [style API](https://github.com/google/skia/blob/5736c298cd2fd98a615dd47e8295a80019a1c112/modules/skparagraph/include/ParagraphStyle.h) | **E:** typefaces can be constructed from data; visitor interfaces expose glyph advances. **I:** TT/CFF loading does not automatically import PDF codes/Widths/TJ. No inspected public SkParagraph API for arbitrary PDF per-code advances before line breaking. A custom shaper/font backend or internal modification would be necessary, plus f32/native-oracle review. |
| harfbuzzjs + TS breaker | **E:** HarfBuzz shapes CJK/mixed scripts, emits clusters/positions. **E:** no UAX14 paragraph break/kinsoku service in the wrapper README. **I:** can build the same PDF metrics first breaker in TS, adding audited segmentation/prohibition data. `Intl.Segmenter` alone is not a Unicode line-break API. | Not supplied by the shaper; requires separate layout code. | **E:** explicit TT/OpenType bytes, shaping outputs. **I:** PDF codes, raw Type1 and widths remain a separate adapter. HarfBuzz core supports custom font functions, but do not assume the wrapper exports every callback; an app-side measured-token breaker can bypass that uncertainty. |

All listed top-level licenses are permissive and compatible with the repo's
MIT code; this does not remove third-party notice/font-license obligations.
No ship path here depends on MuPDF or proprietary assets. HarfRust is MIT;
its [current manifest and README](https://github.com/harfbuzz/harfrust) document
the rustybuzz succession. The pinned dependency/license listing is regenerated
by the prototype, and must be audited again when selecting production features.

## Choice and limits

Select **a small PDF-metrics-first bounded paragraph engine, using HarfRust
0.16.0 for newly needed glyphs, unicode-linebreak 0.1.5 for candidate breaks,
unicode-segmentation 1.12.0 for graphemes, and unicode-bidi 0.3.18 only to
reject unsupported direction**. Its line breaker consumes immutable measured
clusters and the TS-proven existing slots. It is not Parley with a hidden
post-layout metric correction, and it is not a new PDF renderer.

This accepts more implementation ownership than cosmic-text or Parley, but
§4.6 already asks for a small greedy algorithm, eight lines, no hyphenation,
fixed existing slots and exact provenance. Taking a broad typography engine
then replacing its metrics/fallback/break decisions would add a second layout
authority. Exact source advances and boundary identities take priority.
HarfRust fixes the archived-rustybuzz maintenance objection without claiming
that the custom breaker or frozen UAX14 tables are automatically mature.

For production the initial breakpoint whitelist remains **exactly §4.6**:
UAX14 and the prohibition filter may remove candidates; they do not authorize
punctuation, math, Kana or arbitrary-script breaks. The research runner
examines broader UAX14 boundaries diagnostically. A future library/data
upgrade must rerun cluster, break and native metrics gates; broadening the
whitelist needs its own specified unit. Full justification stays off.

HarfRust's font functions offer a future custom metrics hook, but the chosen
contract does not depend on a GID-only override: the same GID can have distinct
PDF codes, widths or states. Immutable measured source clusters must stay
outside reshaping. Known source replacements use `VerifiedCode`; unknown
clusters use separately prepared, permission-checked fallback codes and their
**actual emitted PDF dictionary widths**. Font hmtx/GPOS measurements are
diagnostics or pre-subset preparation only, never authority for unchanged text.

The runner uses ttf-parser for outline boxes/program-width diagnostics, not
PDF identity. Production can reuse B1's existing validated font/path adapter;
this spike does not require another font parser in the shipping binary.
No font discovery, OS fallback, rasterizer or font-size-to-fit is selected.
See main §4.9 for the wire contract and mandatory compiler/native gates.
