# Stage 5: verified fonts, bounded reflow, safe state and Form edits

Design specification for verified source-font editing, bounded reflow and Form isolation.

## 1. Evidence, baseline and boundaries

### 1.1 Measured baseline

Corpus: 41 real PDFs, 1,328 edits, **20.7% accepted** (132 in-place + 143
fallback-font, 1,053 refused). Mean export 73.7 ms/edit. Native oracle on
accepted samples: untouched-glyph drift ≤ 0.005 pt, 0 px outside edit boxes.

Acceptance by category: chinese 46.5%, latex 26.9%, japanese 26.1%, word
12.1%, desktop-publishing 11.4%, tagged 0.9%, scanned-ocr 0.0%.

The baseline report was generated at `test-artifacts/pdf-corpus/report.json`.
Its SHA-256 is
`1c54d372297e0c6b9edd72a3db00665e46503f9fddb043aab684ca804760d408`.
Its 1,328 rows reproduce every count below. Stage-4 STATUS contains several
superseded runs and a warning about a subsequent rerun; use this pinned
snapshot for forecasts, and retain it when a later run replaces the report.

| Category | Edits | In-place | Fallback-font | Refused | Accepted |
|---|---:|---:|---:|---:|---:|
| chinese | 314 | 76 | 70 | 168 | 46.5% |
| latex | 275 | 14 | 60 | 201 | 26.9% |
| japanese | 165 | 33 | 10 | 122 | 26.1% |
| word | 33 | 3 | 1 | 29 | 12.1% |
| desktop-publishing | 35 | 4 | 0 | 31 | 11.4% |
| tagged | 467 | 2 | 2 | 463 | 0.9% |
| scanned-ocr | 39 | 0 | 0 | 39 | 0.0% |
| overall | 1,328 | 132 | 143 | 1,053 | 20.7% |

| Current reason | n | Actual `outcome.detail` | By category |
|---|---:|---|---|
| `font-unavailable` | 623 | `font-unavailable` | tagged 453, chinese 51, scanned-ocr 39, desktop-publishing 28, word 26, japanese 25, latex 1 |
| `overflow` | 208 | `replacement overflows available space` | latex 120, chinese 66, japanese 14, desktop-publishing 3, word 3, tagged 2 |
| `unsupported-state` | 111 | `clip/graphics/semantic dependent target` | japanese 71, chinese 40 |
| `style-change` | 39 | `style-change` | latex 15, japanese 12, tagged 8, chinese 4 |
| `font-coverage` | 36 | `unsupported Type1 font program` | latex 36 |
| `form-xobject` | 14 | `form-xobject` | latex 14 |
| `cross-item` | 11 | `cross-item` | latex 11 |
| `reflow-required` | 7 | `reflow-required` | chinese 7 |
| `source-mismatch` | 4 | `source-mismatch` | latex 4 |

These are first blockers, not independent inventories of all underlying
causes. In particular, **the 36 `font-coverage` rows are the raw Type1/PFA/PFB
bucket**. They are all `shorter` edits, spread over the eight arXiv PDFs.
The 623 `font-unavailable` rows have no subtype diagnostic; attributing them
all to Type1, Type3 or absent programs would be unsupported.

Other useful observations from the saved rows:

- Of 208 overflows, 71 have edit kind `overflow` (eightfold word expansion
  in `scripts/pdf-corpus/editMatrix.ts`); 71 are `longer`, 25 `same-length`,
  22 `multi-line`, 13 `missing-glyph`, 3 `cjk`, 3 `missing-han`.
- The 111 state refusals are Japanese Digital Agency documents (71) and
  `zh-ojs-law`, a word-processor export (40). The detail does not say whether a clip,
  ExtGState or semantic property caused each refusal.
- The 453 tagged font-unavailable rows dominate that category. OCR's 39
  rows are all font-unavailable. Neither is evidence of an editable visible
  Type3 font. Hidden OCR text can correctly remain refused.
- The report embeds 16 native sample records, not an audit of every accepted
  row. Their maximum recorded drift is 0.00006103515625 pt and all record
  zero outside-box pixels; the brief's ≤ 0.005 pt bar also covers prior
  native evidence. Do not extrapolate sampling to universal correctness.

### 1.2 Where today's behavior actually lives

Paths in this document are relative to the repository root unless absolute.

| Source | Current behavior / seam to extend |
|---|---|
| `src/pdf/export/contentStreamEdit/replaceRun.ts` | Pure `replaceRuns`: immutable content fingerprint; resource/object/op/item/decoded-byte addressing; only Tj/TJ; `scope: 'form'` explicitly refuses `form invocation edits are unsupported`; expected failures return original bytes. |
| `contentStreamEdit/runSpan.ts` | Preserves prefix/suffix codes, existing TJ numbers and source Tf; emits `newAdvance - oldAdvance` compensation; slot starts at original span advance and is reduced by every other later-positioned glyph on that baseline, independent of paint order. |
| `contentStreamEdit/runEncoding.ts` | Verified encoder and code-boundary validation; `pdfNumber` uses ten decimal places, no exponent notation. Optional existing-code permutation requires an injective single-scalar mapping and exactly the addressed code/scalar multiset. |
| `contentStreamEdit/tokenizer.ts` | Carries exact decoded-content op extents and decoded string bytes; dictionaries expose entry extents rather than full values, inline images are opaque. Coalesces Contents parts with a space, matching the current PDFium boundary convention. Parse failure prevents partial rewriting. |
| `contentStreamEdit/runRefusal.ts` | RunCompileError carries a stable compiler code; programming exceptions are not ordinary input refusals. Stage-5 codes must extend this shared contract rather than adding message-substring classification. |
| `contentStreamEdit/replaceRunPage.ts` | Decodes/coalesces /Contents and installs a new page stream. `resolveRunFonts` accepts indirect fonts with measurable `contentFontInfo`, uses `runToUnicode` for `unicodeByCode`, and separately attaches program-verified coverage. It does not use coverage's name-derived Unicode when ToUnicode is absent. |
| `contentStreamEdit/glyphWidths.ts` | Dictionary widths for simple fonts with /FirstChar + /Widths and Type0 Identity-H /W + /DW; rejects Type3, non-Identity CMaps and simple fonts without widths, including many Standard-14 fonts. Descriptor ascent/descent can be estimates; these are not ink bounds. |
| `contentStreamEdit/textState.ts` | Tracks CTM, Tm, Tlm, Tc/Tw/Tz/TL/Ts/Tr and q/Q; places one-/two-byte codes; exposes show origin and advance vector, but not the full state trace reflow needs. Unsupported shows become unplaced and taint advances. Tr ≥ 4 aborts the walk. |
| `contentStreamEdit/textSafety.ts` | Currently only environment types and BT-scope helpers. `followsUnplaced` blocks the rest of the same BT even after an explicit Tm; this conservative barrier must not vanish incidentally. |
| `contentStreamEdit/replaceRun.ts` safety scan | W/W* make a persistent dependent flag until Q; gs is dependent unless resolved `safe` and not Font-changing; BDC inspects ActualText/Alt/E keys separately from q/Q. All become `clip/graphics/semantic dependent target`. BI/BX/EX cause a wider refusal. |
| `contentStreamEdit/pageRunPlan.ts` | Clamps `availablePt` to editBox.w. It is a fixed-span cap, not permission to move neighbours. |
| `contentStreamEdit/fallbackFont.ts`, `fallbackPage.ts` | Existing Liberation/Noto subsets prepared in a disposable document; permission/shaping/dictionary/coverage validation; only a `font-coverage` result triggers preparation. Rechecks revision/resources before installation. Copies new subsets into private resources. |
| `contentStreamEdit/resourceStamp.ts` | Recursively hashes Font and Properties dependencies. Its explicit traversal does **not** yet fingerprint indirect ExtGState values, Form paths, clips or structure-tree dependencies needed below. |
| `contentStreamEdit/sourceFontEncoder.ts` | Legacy overlay helper inverts ToUnicode without program proof. Its comments predate current coverage. Do not make it the Stage-5 authority or fork a second parser there. |
| `src/pdf/export/fontCoverage/coverage.ts`, `types.ts` | Pure FontInput → coverage; mapping is separate from widths. Verification levels include `defined-type3`, which proves defined names only, not safe painting. Candidate codes and preferred round trips already exist. |
| `fontCoverage/program.ts` | Actual TrueType/CFF selection and presence checks. Rejects FontFile, `%`-prefixed PostScript and PFB bytes as `unsupported Type1 font program`. Symbolic TT accepts equal-GID high-byte aliases and rejects conflicting GIDs per code. |
| `fontCoverage/cmap.ts` | Parses PDF ToUnicode/Encoding CMap programs, **not** TrueType cmap tables. TrueType table lookup is in `program.ts`. PDF CMap counts, ranges, UTF-16 and codespaces are bounded; unknown usecmap refuses, duplicate maps currently overwrite via Map.set. |
| `fontCoverage/encodings.ts` | Existing AGL, Standard/MacRoman/MacExpert/WinAnsi/Symbol/Zapf data and `@pdf-lib/standard-fonts` AFM access. Extend these; do not copy another AFM/AGL set. |
| `fontCoverage/cffEncodingOffset.ts` | Bounds-checks fontkit's private CFF encoding offset; supplements still refuse. Raw Type1 support must not bypass this existing CFF guard. |
| `fontCoverage/pdfLibAdapter.ts` | Extracts plain font fields/program bytes; Type3 extraction is names of stream-valued CharProcs only. Enumerates Form **resources**, with an ancestor cycle set, deduplicating fonts by object identity. This is not a count of executed Do invocations. |
| `src/pdf/export/contentText/planner.ts` | Assigns coarse font-unavailable for no placed selection, failed Unicode decode, unknown preceding advances or possible intersection with unplaced text. Form classification can mean merely “no selected placed glyphs and some Do exists.” Different line counts refuse reflow-required. |
| `contentText/outcomes.ts`, `apply.ts` | Public stable reason union; compiler codes mapped without substring guessing. Plans overlays against one immutable snapshot, preflights individually, installs one combined plan. Changing-advance plans sharing a BT with a refused hybrid sibling are downgraded to `shared-text-object`. |
| `scripts/pdf-corpus/report.ts`, `oracle.ts` | Counts outcome.reason; native oracle assumes unchanged line counts and unchanged non-replacement origins. It compacts whitespace in extraction comparisons, with a separate real-space preservation check. Reflow needs an independent, stronger oracle mode. |

The full `contentStreamEdit/` paths above share prefix
`src/pdf/export/`; `fontCoverage/` and `contentText/` do likewise.
The three READMEs in these packages and `scripts/pdf-corpus/README.md` are
entry points, but the code takes precedence over old broad comments.

### 1.3 Decisions that apply to all pillars

1. Keep PDFium as reader/renderer, pdf-lib **1.17.1** as assembler, pure TS
   as compiler, MIT-compatible implementation/data. Exclude a new renderer,
   general Rust font-stack migration, page regeneration or fontkit dependence
   for raw Type1. The sole Rust addition selected in §4.9 is a bounded layout
   service; TS retains font/code proof, compilation and PDF writing. The
   service must not discover OS fonts, subset, embed, or parse Type1/Type3.
   HarfRust/read-fonts parsing is not width or glyph-identity authority.
2. Keep fixed-neighbour replacement as the default. Stage-5 reflow is an
   explicit policy with a proven region and moved-glyph manifest, never
   `allowOverflow: true`. Default overflow still refuses.
3. Never mutate an existing font program, encoding, CharProc or shared
   content stream. Missing glyphs use a new embedded subset resource from
   the existing Liberation/Noto SC/JP path. No source subset growth or
   same-BaseFont substitution. A Type3 code absent from its Encoding cannot
   be invented, even if a suitably named CharProc exists.
4. Keep single-span addresses inside one Tj/TJ string item; quotes `'` and
   `"` remain unsupported edit targets. Preserve today's limited planner
   split of provably equal-scalar changes into separate item-local edits.
   Do not turn 11 cross-item refusals into a separate project.
5. Preserve original codes, widths, spacing and kern numbers for unmoved
   prefix/suffix; restore exact unmoved endpoints with compensation.
   Reflow explicitly revises **only** the position invariant for its owned
   glyphs. No font-size-to-fit, Arabic shaping, bidi, hyphenation, general
   typography, cross-page movement, style edits or semantic text rewriting.
6. All ownership, decoding, safety and layout proofs bind to source bytes
   and dependency hashes, not mutable page objects. Prepare in scratch;
   revalidate immediately before a single installation. Programmer
   exceptions escape; they are not counted as refusals.
7. Preview/export already share the rebuildPdf writer; new Stage-5 plans
   must follow that same route and saved bytes, with PDFium rendering the
   result. §4.9 specifies the layout-only Rust boundary.

## 2. Shared contracts, diagnostics and measurement

### 2.1 Pure proof model

These are proposed types, not changes already made. Put shared primitives
next to `fontCoverage/types.ts` and `contentStreamEdit/runRefusal.ts`; adapters
alone contain pdf-lib types. All maps/bytes are immutable to consumers.

```ts
type Code = { bytes: Uint8Array; unicode: string };
type GlyphIdentity =
  | { kind: 'gid'; programHash: string; gid: number }
  | { kind: 'type1-name'; programHash: string; name: string }
  | { kind: 'type3-name'; fontHash: string; procHash: string; name: string }
  | { kind: 'standard14'; face: string; name: string };
type Rect = { x: number; y: number; w: number; h: number };
type VerifiedCode = Code & {
  glyph: GlyphIdentity;
  width1000: number; // PDF text displacement basis; not program hmtx
  widthSource: 'pdf-widths' | 'cid-widths' | 'standard-afm' | 'type3-widths';
  unicodeSource: 'to-unicode' | 'verified-glyph-name';
  // Original decoding and replacement eligibility are different capabilities.
  replacementProof?: {
    toUnicodeLabel: string; verifiedGlyphName: string; glyphNameUnicode: string;
  };
  ink?: { box: Rect; proofHash: string }; // conservative, in glyph/text basis
};
type FontResolution = {
  fontObject: string; resourceScopeHash: string; dependencyHash: string;
  mappings: ReadonlyMap<string, VerifiedCode>;
  failures: readonly Diagnostic[];
};
type Diagnostic = {
  code: Stage5Reason; detail: string; family: LegacyReason;
  data?: Readonly<Record<string, string | number | boolean>>;
  blockers?: readonly Stage5Reason[];
};
```

Keep `FontCoverage.glyphIds` for real GIDs. Type1/Type3 names are not synthetic
GIDs, and `defined-type3` is not upgraded to verified-program merely by
counting CharProcs. Add a separate eligibility result for safe compilation.
The parser can resolve some codes and refuse others; one broken unused glyph
need not clear unrelated verified mappings. An invalid font-wide container,
encoding definition or encryption boundary invalidates the whole font.

Unify decoding evidence between coverage and the surgical adapter, while
keeping **original decode labels separate from replacement eligibility**.
ToUnicode remains the decode label of the original span, even when its label
disagrees with the selected glyph's name. Preserve untouched source bytes;
do not relabel original text to hide that disagreement. Name-derived decoding
when ToUnicode is absent can be diagnostic evidence, but cannot by itself
authorize a Stage-5 replacement. Holes in a present map remain holes.

Every replacement code requires both its ToUnicode label and independently
verified glyph-name Unicode, and those strings must agree exactly with the
requested cluster. Use existing `glyphUnicode` rules in `encodings.ts`
(AGL, suffixes, underscore ligatures, `uni`/`u` names); do not normalize or
split a ligature to manufacture agreement. Establish the name from the
**actually selected glyph/program or CharProc**, not merely an Encoding
slot, requested Unicode or a synthesized uXXXX name derived from the label.
A selected `/B` labelled `A`
is **`glyph-identity-conflict`**, family `font-unavailable`: exclude it as a
candidate and refuse the edit, with no fallback around that conflict. A
missing label/name proof remains unavailable, never “presence verified,
therefore editable”; nameless/CID or custom Type3 names do not gain guessed
Unicode aliases to pass this rule. Controlled new resources must satisfy
the same ToUnicode/verified-glyph-name agreement and independent O1a outline
requirements before Stage-5 use, or stay refused. A conflict in an addressed
code or candidate for the requested cluster is terminal for that target;
choosing a fallback font does not erase it.

When the requested scalar/code multiset matches the addressed source and
the identity checks pass, honor `preferredCodes` and preserve original bytes
for unchanged clusters. The existing-code permutation fast path cannot
bypass the identity check. Original spans retain ToUnicode decode provenance
even if a proposed replacement is refused. Neither extraction, a non-.notdef
path nor coverage's GID proves that the outline represents the requested
cluster; O1a must compare it to hand-specified expected outlines. Keep
sourceFontEncoder outside this authority rather than creating another encoder.

### 2.2 Stable refusal union and human messages

Retain the existing `ContentTextReason` members for saved outcomes and the
unmodified paths. Add the following explicit literals in one shared exported
tuple (derive `Stage5Reason` from it plus the existing tuple). Do not maintain
diverging compiler/UI/reporter copies or infer codes from message text.
Proposed ownership is a pure `contentStreamEdit/refusalCodes.ts`: export the
old tuple as `legacyContentTextReasons`, the new tuple and their derived
types. Here `LegacyReason` means the old tuple's union. `outcomes.ts`
re-exports the combined public type; `RunCompileError`, compiler results,
ContentTextOutcome, UI consumers and reporter all import that type. Newly
emitted compiler refusals require a code; optional-code/string handling is
restricted to reading legacy results. This avoids a runtime dependency from
the pure compiler back into the export outcome adapter.

```ts
const stage5Reasons = [
  'font-program-missing', 'font-program-malformed', 'font-resource-invalid',
  'font-metrics-missing', 'font-metrics-conflict', 'glyph-unavailable',
  'glyph-bounds-unavailable', 'glyph-identity-conflict',
  'missing-tounicode', 'tounicode-malformed',
  'source-code-unmapped', 'unknown-text-advance', 'unplaced-text-intersection',
  'type1-container-invalid', 'type1-eexec-invalid', 'type1-ps-unsupported',
  'type1-charstring-invalid', 'type1-charstring-unsupported',
  'type1-subr-invalid', 'type1-other-subr-unsupported',
  'type3-charproc-missing', 'type3-charproc-unsafe',
  'type3-matrix-unsupported', 'type3-width-invalid',
  'symbolic-cmap-ambiguous', 'symbolic-cmap-unsupported',
  'tt-cmap-format-unsupported', 'cmap-malformed',
  'cmap-inheritance-unsupported', 'cmap-predefined-unsupported',
  'cmap-code-width-unsupported', 'cff-encoding-unsupported',
  'reflow-context-unsupported', 'reflow-spacing-limit',
  'reflow-obstacle', 'reflow-paragraph-unproven',
  'reflow-paragraph-full', 'reflow-break-unsupported',
  'layout-metrics-disagreement',
  'clip-unproven', 'clip-target-intersection', 'text-clip-dependent',
  'graphics-state-unresolved', 'graphics-state-font',
  'graphics-effect-unsupported', 'semantic-text-dependent',
  'marked-content-unresolved', 'invisible-text-layer',
  'content-malformed', 'opaque-content', 'parser-budget-exceeded',
  'form-xobject-shared', 'form-xobject-cycle',
  'form-xobject-context', 'form-xobject-ambiguous',
] as const;
// type Stage5Reason = LegacyReason | typeof stage5Reasons[number];
```

Default English diagnostic templates follow; placeholders live in `data`.
UI translation is a follow-up through `t()` in en/zh/ja, not raw English
messages rendered as UI. `detail` remains evidence, `code` is the counted
machine value, and `family` permits comparisons with the old report.

| New code(s) | Human text (one template per listed code, in order) | Legacy family |
|---|---|---|
| `font-program-missing`, `font-program-malformed`, `font-resource-invalid` | `Source font program is not embedded`; `Source font program is malformed`; `Source font resource cannot be resolved` | font-unavailable |
| `font-metrics-missing`, `font-metrics-conflict` | `Source font has no proven width for code {code}`; `Font width disagrees with its glyph program for code {code}` | font-unavailable |
| `glyph-unavailable` | `No verified source or permitted fallback glyph for {cluster}` | font-unavailable |
| `glyph-bounds-unavailable` | `Conservative glyph bounds are unavailable for {cluster}` | reflow-required |
| `glyph-identity-conflict` | `ToUnicode label {label} disagrees with verified glyph-name Unicode {glyphUnicode}` | font-unavailable |
| `missing-tounicode`, `tounicode-malformed`, `source-code-unmapped` | `No authoritative Unicode mapping for this font`; `Source ToUnicode map is malformed`; `Source code {code} has no authoritative Unicode mapping` | font-unavailable |
| `unknown-text-advance`, `unplaced-text-intersection` | `Source text has an unknown advance at operator {opIndex}`; `Unplaced source text could intersect the selection` | font-unavailable |
| `type1-container-invalid`, `type1-eexec-invalid`, `type1-ps-unsupported` | `Invalid Type1 container or segment lengths`; `Type1 eexec data cannot be decoded`; `Unsupported Type1 PostScript construction {token}` | font-coverage |
| `type1-charstring-invalid`, `type1-charstring-unsupported`, `type1-subr-invalid`, `type1-other-subr-unsupported` | `Invalid Type1 charstring {name}`; `Unsupported Type1 charstring operator {operator}`; `Invalid or recursive Type1 subroutine {index}`; `Unsupported Type1 OtherSubr {index}` | font-coverage |
| `type3-charproc-missing`, `type3-charproc-unsafe`, `type3-matrix-unsupported`, `type3-width-invalid` | `Type3 code has no defined CharProc`; `Type3 CharProc depends on unsupported painting state`; `Unsupported Type3 FontMatrix`; `Type3 Widths and d0/d1 do not provide a consistent horizontal width` | font-unavailable |
| `symbolic-cmap-ambiguous`, `symbolic-cmap-unsupported`, `tt-cmap-format-unsupported` | `Symbolic code {code} selects conflicting glyphs`; `No supported symbolic cmap selects code {code}`; `Unsupported TrueType cmap format {format}` | font-coverage |
| `cmap-malformed`, `cmap-inheritance-unsupported`, `cmap-predefined-unsupported`, `cmap-code-width-unsupported`, `cff-encoding-unsupported` | `Malformed or conflicting CMap entries`; `Required inherited CMap entries are unresolved`; `Unsupported predefined CMap {name}`; `Source code width is unsupported by the placement compiler`; `Unsupported CFF encoding or supplement` | font-unavailable, except CFF → font-coverage |
| `reflow-context-unsupported`, `reflow-spacing-limit`, `reflow-obstacle` | `Line ownership or text state cannot be proven`; `Required spacing reduction exceeds the conservative budget`; `Reflow would intersect unowned content` | reflow-required, overflow, overflow respectively |
| `reflow-paragraph-unproven`, `reflow-paragraph-full`, `reflow-break-unsupported` | `No proven paragraph box for wrapping`; `Replacement does not fit inside the proven paragraph box`; `No supported break at this cluster boundary` | reflow-required |
| `layout-metrics-disagreement` | `Layout {kind} differs from verified PDF metrics by {errorPt} pt` | reflow-required |
| `clip-unproven`, `clip-target-intersection`, `text-clip-dependent` | `Active clip geometry cannot be proven`; `Edited ink is not fully contained by the unchanged clip`; `Text contributes to a clipping path` | unsupported-state |
| `graphics-state-unresolved`, `graphics-state-font`, `graphics-effect-unsupported` | `Graphics state resource cannot be resolved`; `Graphics state changes the source font`; `Unsupported graphics effect at the edit target` | unsupported-state |
| `semantic-text-dependent`, `marked-content-unresolved`, `invisible-text-layer` | `ActualText, Alt or E depends on the edited text`; `Marked-content properties cannot be resolved`; `Invisible text layer is not a visible content-edit target` | unsupported-state |
| `content-malformed`, `opaque-content` | `Malformed content or unbalanced state`; `Opaque content prevents a complete edit proof` | unsupported-state |
| `parser-budget-exceeded` | `Parser resource budget exceeded in {parser}` | Family of the parser that exhausted its budget; see dispatch below |
| `form-xobject-shared`, `form-xobject-cycle`, `form-xobject-context`, `form-xobject-ambiguous` | `Shared Form invocation cannot be isolated`; `Cyclic Form invocation path`; `Unsupported inherited state or Form semantics`; `Selection matches multiple Form invocations` | form-xobject |

`layout-metrics-disagreement` has family `reflow-required`, including advance,
boundary, endpoint and origin-space disagreement; its data names the kind,
measured user-space error and affected cluster/boundary when known.
`font-metrics-conflict` remains exclusively §3.2's character-space
program-versus-dictionary width check (family `font-unavailable`, tolerance
one character-space unit), not a layout-service error. A raw hmtx diagnostic
in §4.9 does not change either code's meaning.

The existing literals include source-mismatch, ambiguous-match, glyph-boundary,
cross-item, reflow-required, form-xobject, unsupported-matrix,
unsupported-state, font-unavailable, font-coverage, font-permission,
overflow, style-change, stale-source, preview-unavailable,
missing-source-style and shared-text-object. Preserve their behavior and
messages on old paths. New paths must emit the precise code at its detection
site; keep coarse font-unavailable only for legacy result compatibility.
Use existing `font-permission` for fallback embedding restrictions and
`unsupported-matrix` for nonfinite/singular/page text geometry **and vertical
metrics/writing** (including Identity-V), until a real vertical unit exists. A present
malformed ToUnicode is never reported as merely missing.

Close the planner's current empty-selection branch explicitly: if no glyphs
are selected and `walk.unplacedText` is true, emit `unknown-text-advance`
when a show has an unknown origin/advance, or `unplaced-text-intersection`
when a known unplaced origin could intersect the selection. Include the
responsible `opIndex` (and BT/scope if known) in `data`; if several shows are
possible, retain every index in the inventory and deterministically select
the earliest as the primary diagnostic. No bare font-unavailable remains
on this branch, and unrelated Do presence does not override it.

`parser-budget-exceeded` retains `data.parser` and `data.limit`, and inherits
the parser's registered family: Type1/container/charstring and TT/CFF program
parsers → `font-coverage`; PDF CMap/ToUnicode/Type3 font resolution →
`font-unavailable`; paragraph/layout proof → `reflow-required`; invocation
walk/COW → `form-xobject`; content/state syntax → `unsupported-state`.
This dispatch is typed/exhaustive; it is not a message-substring heuristic.

Structural/stale failures precede font work; source provenance/placement
precedes encoding; safety precedes layout. Report the first deterministic
primary failure and optionally all independently proven blockers. A spacing
limit can be a blocker while a later bounded wrap succeeds; do not count it
as a refused edit in that case. `font-program-missing` is not a license to
fall back when original rendering or widths are unknown. Replace the current
“any font-coverage permits preparation” rule with an explicit recoverability
check: source decode, placement and state proven; replacement-only absence
may try existing fallback; malformed source programs do not become safe
through fallback. `glyph-identity-conflict` is terminal and never recoverable.
`glyph-unavailable` is in `font-unavailable`, but its family does not decide
fallback: only the explicit recoverability predicate can authorize it.

### 2.3 Instrument before claiming gains

Add a read-only diagnostic pass over the pinned cases, without changing
acceptance. Persist row key `(id,page,kind,original,text)` plus revision,
selected code/font subtype, metric source, decode status, all blockers and
Form invocation path. Distinguish program absence, Type3, variable-width CMap,
missing/malformed ToUnicode, opaque glyphs, unknown advances and invisible
text. No “Type3 detected, therefore recoverable” counters.

All forecasts in §7 are assumptions until this pass and the native rerun.
Keep first-blocker totals and a separate blocker matrix; do not sum both.
Run each pillar alone and combined on the same immutable cases. A row gains
acceptance only when every blocker clears and its oracle passes. Report new
refusals of previously accepted rows explicitly, not hidden in a net rate.

O0 must also classify **all 208 overflow rows** using actual encoded
advances and the unchanged original slot: how many fit **spacing-only**
within every per-gap cap, the 2% aggregate cap and ink clearance, with no
suffix shift or wrap? Publish per-category row IDs, old/new advance,
availablePt, required reduction, cap/clearance failures and unsupported
measurement counts. Separate the 71 known eightfold expansions. The saved
report contains no such advance measurements; do not infer a fit from edit
length or manufacture a count. Keep this unmeasured count out of the gain
tables until the inventory exists.

## 3. Pillar 1 — Type1, Type3 and legacy font resolution

### 3.1 Goals, non-goals and data model

Goal: prove source code → glyph identity → Unicode and PDF width for an
editable subset of PFA/PFB, safe Type3 and legacy symbolic TT, and explain
every unresolved case with §2's enumerable codes. Keep the existing CFF,
Identity and fallback paths; stricter identity/MM/render-mode refusals
explicitly revise eligibility and require regression accounting. Standard-14 metrics extend the existing AFM
access. Coverage and placement must both accept a font before any gain exists.

Non-goals: execute arbitrary PostScript, render Type1, implement TrueType
hinting, add glyphs to source fonts, manufacture Type3 encodings, use local
installed fonts, infer CID=GID outside a proven Identity mapping, support
Multiple Master design interpolation or load external/predefined CMap packs.
`MMType1`, and Type1 programs declaring Blend/Design machinery, explicitly
refuse `type1-ps-unsupported` before any charstring execution. The old
glyphWidths MMType1 switch case does not authorize a new parser accept path.

Extend plain `FontInput` with `fontMatrix`, `fontBBox`, FirstChar/LastChar,
Widths, FontFile Length1/2/3, and a map of decoded CharProc bytes and their
dependency hashes. Add resolved FontInput subtypes instead of passing
PDFDicts or changing `charProcs?: string[]` to mean a painting proof.
Proposed pure records:

- `Type1Program`: container/clear/private hashes, encoding code→name,
  FontMatrix, lenIV, bounded Subrs and CharStrings, per-name closure status
  and horizontal program width. No numeric GID field.
- `Type3GlyphProof`: code/name/procHash, d0/d1 width, raw and transformed
  bounds, read-set of inherited painting state, resources (initially empty),
  operator allowlist result and eligibility. No nonempty fake font program.
- `MappingEvidence`: chosen TT platform/encoding/format, code, candidate
  GIDs, selected name, ToUnicode provenance and PDF-width provenance.
  Conflicting codes can fail without discarding unrelated good codes.

### 3.2 Type1 parser and eligibility algorithm

Implement fresh TS modules under `fontCoverage/` (for example
`type1Container.ts`, `type1Dictionary.ts`, `type1CharString.ts`). Preserve the
fontkit CFF path in `program.ts`; dispatch raw FontFile/PFA/PFB to the new
parser before calling fontkit.
Check subtype and Blend/Design declarations first: emit
`type1-ps-unsupported` for MMType1, Blend or Design, before executing any
CharString/Subr. No interpolation/default-instance guess is supported.

1. **Container.** Accept embedded PDF FontFile's clear/encrypted/trailer
   segments using checked Length1/2/3; standalone PFA and PFB records are
   also accepted for fixtures/analysis. PFB uses marker/type/LE length
   records (0x80/1 ASCII, 0x80/2 binary, 0x80/3 terminal, with no terminal
   length field); validate order, bounds and total length.
   Preserve binary bytes exactly. A PDF FontFile is not required to include
   PFB headers. Conflicting lengths, truncated records or ambiguous eexec
   boundaries refuse `type1-container-invalid`, not speculative scanning.
2. **Encryption.** Adobe Type1's byte cipher uses eexec seed 55665 and
   charstring seed 4330, constants 52845/22719, and ciphertext-fed 16-bit
   state updates. Discard four decrypted eexec prefix bytes; charstrings
   use Private lenIV (default 4). Support ASCII-hex and binary eexec with
   verified boundaries. See [Adobe Type 1 Font Format, §§5.12, 6–8](https://adobe-type-tools.github.io/font-tech-notes/pdfs/T1_SPEC.pdf).
   For this implementation accept lenIV -1 (unencrypted), 0–32; reject other
   values or strings shorter than their prefix. Establish -1 behavior with
   independently generated/native fixtures. Decrypt Subrs separately with
   the same lenIV. Never treat encrypted bytes as delimiter-terminated text.
3. **Bounded dictionary language.** Parse the declarative Type1 idioms,
   not a PS VM: literal names/numbers/arrays/dicts; known dict begin/end/def;
   StandardEncoding or 256-entry name arrays and literal `dup code /name
   put` Differences; the standard `.notdef` initialization loop; known
   RD/ND/NP and `-|`/`|-` aliases only when their definitions exactly match
   the byte-reader/dictionary idiom. Counted RD data consumes exactly its
   byte length. Unknown executable encoding generation, file operations,
   procedure aliasing or conditional definitions refuse
   `type1-ps-unsupported`. Strings/comments containing eexec, RD or
   CharStrings do not change parser state. Reject duplicate contradictory
   definitions; do not merge two font programs by FontName.
4. **Charstring proof.** Decode Type1 number formats and escaped operators;
   check operand arity, finite values and stacks throughout the reachable
   program, not just through the first hsbw. Record hsbw/sbw horizontal
   width and sidebearing. Validate endchar; allow path moves/lines/curves,
   closepath, hint/dotsection operators, div, callsubr/return and setcurrentpoint
   with their actual stack effects. Subr indices are direct, with no Type2
   bias. Reject invalid termination, stack errors, duplicate widths,
   nonhorizontal widths or unknown operators. No need to rasterize or hint.
5. **Dependencies.** Follow reachable Subrs with depth/cycle/operation
   guards. `seac` resolves both components by StandardEncoding names, not
   PDF Differences; require their valid closure. Support only the canonical
   flex/hint-replacement OtherSubrs stack conventions after a dedicated
   fixture unit; arbitrary callothersubr/unknown pop behavior refuses
   `type1-other-subr-unsupported`. Initially refusal is acceptable for these
   glyphs; do not label a font verified because unrelated glyphs passed.
6. **Code selection.** PDF Encoding + Differences selects the name, else
   the proven built-in program Encoding. ToUnicode labels that selected code
   for original decoding but cannot prove its outline identity. A replacement
   requires the label **and** `glyphUnicode(verifiedName)` to equal its cluster,
   including the existing ligature rules. Disagreement is terminal
   `glyph-identity-conflict`, not a candidate and not a fallback request.
   Missing ToUnicode is `missing-tounicode`; name-only decoding is insufficient
   for replacement. Reject .notdef/missing or invalid reachable glyphs.
   Preserve `preferredCodes` ordering/ligature cluster semantics already in
   `coverage.ts` when the multiset matches and identity checks pass. If a needed glyph exists in CharStrings but has no existing
   PDF code, it is unavailable to this font; use a new fallback resource.
7. **Widths.** Existing finite PDF /Widths remains the placement authority.
   Compare the decoded charstring horizontal width directly to the /Widths
   number in **character space**, with absolute tolerance **≤1 character-space
   unit** (e.g. 600 versus 600, not 0.600 versus 600). Do **not** multiply by
   FontMatrix before this comparison. A larger difference is
   `font-metrics-conflict`; do not substitute the program width. The
   program width does not silently replace a missing PDF width. Nonstandard
   Type1 without valid required dictionary metrics refuses
   `font-metrics-missing`; a custom/nonhorizontal FontMatrix is initially
   refused as `unsupported-matrix`. Support only the standard 0.001 diagonal
   Type1 matrix in the first release. Standard-14 is the exception below.

Limits are policy constants: ≤16 MiB decoded font data, ≤65,536 CharStrings
and Subrs each, ≤1 MiB per string, 24 charstring operands, ≤16 Subr/component
depth, ≤100,000 executed operators per glyph and ≤2,000,000 per font. The
dictionary subset has ≤64 nesting levels and ≤1,000,000 tokens; reject before
allocation or recursion exceeds a limit. Cache by complete font/program and
encoding hash; limits apply cumulatively, not per repeated reference.
`parser-budget-exceeded` names the parser and limit; malformed termination
is not misreported as a resource limit.

Successful decryption means the bounded decoded structure validates, not
cryptographic authenticity; Type1 encryption has no integrity guarantee.
An unencrypted Private dictionary can be supported only through the same
literal subset with explicit string/lenIV semantics, otherwise
`type1-ps-unsupported`. Do not recover by guessing where damaged encrypted
bytes end. Implement the algorithms from the cited specifications with
original TS code; no copied proprietary code/assets or substantial
upstream source. Preserve existing AFM/encoding data notices. Any later
reference implementation use requires checking its actual file license;
“PDF parser” is not a license category.

### 3.3 Standard-14 and widths integration

`coverage.ts` already uses `standardFont(baseFont)` and AFM glyph presence;
`glyphWidths.ts` nevertheless refuses absent /Widths and the surgical
adapter leaves no-ToUnicode fonts unmapped. Add a plain metrics resolver
beside `encodings.ts`, backed by `@pdf-lib/standard-fonts`, and use its
code→selected-name→AFM width for an exact unembedded Standard-14 face.
Reuse the existing encoding/Differences and Unicode evidence. Do not strip a
subset tag to guess an unembedded standard font; no arbitrary Arial→Helvetica
alias. Embedded programs always win over a familiar BaseFont.

If valid explicit PDF widths exist, retain them. If the font is exactly one
of the 14 permitted unembedded standard faces with missing widths, expose
AFM widths and `assumed-standard` verification, not “embedded verified”.
Standard-14 native outlines may vary by viewer; fixture the installed
PDFium path and gate geometry at save/reopen. Missing AFM name/.notdef
refuses; do not use descriptor MissingWidth=0 as proof for an addressed code.
No other simple font's absent widths are repaired from fontkit hmtx.
AFM supplies metrics/presence, not a missing ToUnicode label. F7 must refuse
unlabelled replacement codes under §2.1; no-ToUnicode/no-width cases remain
useful diagnostic/refusal fixtures. F7 stays default-off in `planContentText`
until O1a's AFM identity/compensation scenario is green.

### 3.4 Type3: defined is not necessarily safe to show again

Keep the rule “encode only codes already defined in /CharProcs”: the
**existing Encoding** must select the named existing stream. Reusing that
code at another occurrence is allowed only with the proof below. A different
existing alias code can be chosen only if its Encoding selects the identical
CharProc and its own width/Unicode mapping is proven. No adding aliases or
patching the font to expose a glyph-by-name.

Type3 glyph descriptions, encoding and FontMatrix are specified in
ISO 32000-1:2008, §9.6.5 and Tables 112–113.
The corrected horizontal d0/d1 width must agree with Widths; see the
[PDF Association's approved text errata, Table 111](https://pdf-issues.pdfa.org/32000-2-2020/clause09.html).

Initial eligibility is deliberately useful but narrow:

- FontMatrix must be `[a 0 0 d e f]`, a,d positive finite, nonsingular,
  with finite translation. Normalize displacement to `width1000 =
  1000*a*Widths[code-FirstChar]`; translation affects ink, not advance.
  Validate a horizontal d0/d1 displacement (wy=0) against Widths to ≤1e-6
  glyph unit. Missing/out-of-range Widths, inconsistent metrics or a rotated,
  skewed, negative or singular matrix get the precise Type3 code. Do not
  divide every Type3 width by 1000 as if FontMatrix were fixed.
- Accept a single leading d1 plus bounded fill-only vector paths
  (`m,l,c,v,y,h,re,f,f*,n`) and balanced q/Q, **without cm**. Any cm refuses
  `type3-charproc-unsafe` with `data.operator='cm'`, including the optional
  d0 subset, until a later dedicated CTM-accurate hull unit exists.
  Compute a convex hull of every path control/end point, including the
  implicit current point for v/y, each subpath start/close edge and all four
  re corners. Map the hull through FontMatrix **including translation** and
  the caller transform for clip checks. Require the hull inside the d1 box
  in the same coordinate basis, and inside the unchanged clip; d1's declared
  box never substitutes for the hull. Compare glyph-space hull to d1 bounds,
  or transform both by FontMatrix before comparison, never mixed units.
  Require valid arities and no path/state leak. Empty glyphs are allowed
  only for already mapped whitespace/formatting with a proven advance.
- A d0 procedure can be a separate afternoon extension: permit the same
  fill-only path set and literal DeviceGray/RGB/CMYK color setters; all
  painted paths must have a proven literal color or the same explicitly
  inherited fill color at the target. Compute its own bounds; d0 supplies
  no bounding rectangle. Until that unit passes, refuse d0 with
  `type3-charproc-unsafe`, `data.operator='d0'`.
- Reject nested text, Do/BI/images/shading/patterns, W/W*, gs, marked content,
  compatibility operators, strokes relying on inherited line properties,
  unsupported colors and unknown operators. Such valid PDFs can remain
  `type3-charproc-unsafe`; malformed syntax gets `content-malformed`.
  No resource traversal is necessary for the first allowlist.
- Inherited fill color and the caller's transform are explicit read-set
  dependencies. Target state must supply an identical supported value and
  ordinary fill rendering; alpha/blend/soft-mask restrictions in §5 apply.
  The proof must hold at the new position under the unchanged clip, not
  merely at an original show. Cache a proc's structural proof separately
  from per-target state eligibility.

The later cm unit, if separately commissioned, must map **every** control,
implicit current point and re corner by the q/Q/cm CTM at path construction,
then FontMatrix including translation, before taking the conservative hull
and testing the transformed d1 box/clip. Until that unit passes, cm is always
refused. Mandatory red fixture: FontMatrix 0.001 diagonal, Tf=1000, d1 box
`[0,0,20,20]`, then `2 0 0 2 0 0 cm 0 0 8 8 re f`, under a `[0,0,12,12]`
clip (origins aligned). Raw corners reach 8 and look contained; painted ink
reaches 16 and crosses the clip. Initial output must be unchanged with
`type3-charproc-unsafe`, operator cm; a future accurate hull must still
refuse containment for this fixture.

The adapter must expose these fonts to `contentFontInfo` through a new
resolved pure-metrics path, and propagate the actual FontMatrix/ink envelope
to the walker. Do not enable Type3 simply by removing its switch-case
refusal. Keep every original code and source font object unchanged. For a
new requested character missing a verified code, existing fallback resources
are permitted once original Type3 decoding/placement/state is proven.

The native evidence model must handle Type3's absent FontFile without an
empty-buffer FFI call. Use proc/encoding/resource hashes and path/ink evidence;
do not require a fabricated program hash or GID0. Include a known missing
Type3-code probe where meaningful, plus independently expected vector shapes
and reused-proc outline comparisons. Coverage alone is not the oracle.

### 3.5 Legacy TrueType and the two CMap layers

Keep and extend `program.ts` selection; `cmap.ts` is for PDF CMaps.
OpenType's table layouts and GID0 convention are reference material in
[Microsoft's cmap specification](https://learn.microsoft.com/en-us/typography/opentype/spec/cmap).
These are eligibility rules for the PDF compiler, not permission to choose
any Unicode cmap that happens to contain the desired character:

1. For a symbolic (3,0) code, preserve today's candidate bases
   `0x0000`, `0xF000`, `0xF100`, `0xF200`, but replace today's conflated lookup
   with a result that distinguishes **unmapped**, **explicit GID 0** and
   **nonzero glyph id**. Unmapped bases may be ignored. An explicit GID 0 at
   **any** applicable base, or two different nonzero GIDs, yields
   `symbolic-cmap-ambiguous` for that code; never emit the other base's GID.
   Only repeated equal nonzero hits with no explicit zero are aliases.
   All-unmapped is `symbolic-cmap-unsupported`; out-of-range GIDs and missing
   glyf/loca remain refusals. Do not use filter(Boolean). Duplicate matching
   (3,0) selection records also refuse `symbolic-cmap-ambiguous`; do not
   select the first and hide the other record.
2. If no (3,0) subtable exists, the supported (1,0) Mac path remains valid
   with proven code/name semantics. A present (3,0) hole does not authorize
   falling through to a different (1,0) glyph. Symbolic PDF Differences do
   not override actual rendering selection. Without ToUnicode, require an
   actual post/built-in name for diagnostic decoding, but replacement still
   requires a ToUnicode label and name agreement. Private-use cmap numbers
   alone do not identify text. Otherwise `missing-tounicode`.
3. Preserve both-flags-plus-standard-Encoding's existing nonsymbolic rule.
   The nonsymbolic (3,1)→name/Unicode, (1,0) Mac name and post fallback must
   agree with PDF rendering selection. Do not reinterpret ToUnicode as a
   (3,1) character index when the PDF Encoding chose a different name.
4. Today's TT lookup handles formats 0,4,6,10,12,13. Validate format table
   lengths, ordered/nonoverlapping ranges, offset arithmetic and output GID
   bounds. Add format 2 in a separate bounded unit for legacy tables if
   diagnostics find it, with explicit high-byte/subheader tests. Formats
   8/14 and unknown formats stay `tt-cmap-format-unsupported`; format 14
   alone is not a base cmap. Do not opportunistically add new platform
   selection rules to inflate acceptance. Conflicting/unsupported selection
   is `symbolic-cmap-unsupported`.
5. Tighten PDF `parseCMap`: reject conflicting duplicate entries/ranges,
   malformed UTF-16, invalid WMode and incompatible codespaces; preserve
   bounds. Align `runToUnicode` with the common parser without losing its
   “explicit local entries usable, inherited entries unknown” policy.
   `coverage.ts` must likewise allow verified **local** entries when a
   non-Identity usecmap is unresolved, while recording an unresolved base;
   entries that need that base refuse `cmap-inheritance-unsupported`.
   No silent partial success on malformed local syntax. Stream-dictionary
   /UseCMap dependencies need the same explicit-local distinction in the
   pdf-lib adapter; unresolved external mappings are never guessed.
6. Preserve verified Identity inheritance, CFF supplements/private-offset
   guards and partial ToUnicode authority. Type0 still requires ToUnicode.
   Font coverage can understand embedded CMap codes 1–4 bytes, but today's
   placement compiler supports only simple one-byte and Identity-H two-byte
   codes. This stage adds metrics support for a uniform one-/two-byte
   embedded horizontal code→CID mapping only when widths are proven from
   /W+/DW. Mixed-length or three-/four-byte layouts explicitly remain
   `cmap-code-width-unsupported`; vertical metrics return `unsupported-matrix`.
   F14 is default-off in `planContentText` until O1a's CID metrics/identity
   scenario is green. Do not claim
   all coverage-encodable fonts are therefore placeable.

### 3.6 Invariants, tests, risks and acceptance targets

Invariants: Unicode never proves glyph presence; a name proves presence only
after its complete reachable program is valid. Widths and code boundaries
must match PDF rendering. No existing code/font mutation. No fallback on
unknown original advances. .notdef is never a replacement; a deliberately
empty mapped separator need not have ink. Existing-code permutations remain
restricted to their current multiset, require ToUnicode/name agreement,
preserve preferred original bytes and keep independent native outline evidence.

Write failure lists, then red tests, then implementation. Extend the existing
`fontCoverage/{coverage,cmap,review,adapter}.test.ts` and compiler tests; use
tiny generated text/binary arrays, not large checked-in fonts/PDFs.

| Test tier | Required failures and success evidence |
|---|---|
| Container/decrypt unit | PFA hex/binary; multi-record PFB; PDF Length1/2/3 without PFB wrapper; truncation/overflow, wrong record order, trailer confusion, encrypted delimiter bytes, independent cipher vectors, lenIV -1/0/1/4, too-short strings and budget attacks. |
| Charstring unit | hsbw/sbw, valid/invalid arities, width in Subr, recursion/missing Subr, div-by-zero, hint stack effects, seac missing component, canonical flex/hint OtherSubrs versus arbitrary PS, .notdef, invalid endchar and malformed unused versus reachable glyphs. |
| Metrics/mapping unit | Character-space Type1 widths: 600/600 succeeds, 600/601 meets tolerance, 600/602 refuses; never FontMatrix-scaled comparison or program-width substitution. ToUnicode A selecting /B refuses glyph-identity-conflict with no fallback; matching ligature/name rules and preferred bytes pass. MMType1/Blend/Design refuse before execution; Standard-14 no-ToUnicode/no-width refusal; embedded Helvetica is not AFM; partial maps, supplementary scalars and empty spaces. |
| Type3 unit | Safe d1 fill glyph, optional literal-color d0, non-0.001 FontMatrix/translation, implicit v/y points and every re corner, wy≠0, mismatched d1/Widths, false bbox; cm scale fixture above must refuse with operator cm. Nested Do/BT/gs/clip, inherited color changes, stale resources and unencoded names refuse. |
| Legacy unit | Each permitted high byte; equal nonzero aliases, explicit zero + nonzero must refuse symbolic-cmap-ambiguous, unmapped + nonzero can pass, distinct nonzero conflict. Add beside equal-alias regression in fontCoverage/review.test.ts. Conflicting subtables, (1,0), flags, missing labels/names, format 2, malformed offsets and unresolved inheritance. |
| Native rendering and independent extraction | Saved raw Type1 source replacement and fallback, AFM face, safe Type3 reuse/fallback and symbolic mappings; independent expected selected glyph names/shapes, real GIDs where applicable, non-.notdef path/ink, intended text, untouched origin ≤0.005 pt target/≤0.01 hard limit, zero pixels outside edit boxes, qpdf clean. |
| Corpus | Run all fixed 1,328 cases; separately count newly eligible source fonts, replacement fallback and remaining blockers. Revised pillar-1 credit: +24/+64/+97 edits, overall 22.5%/25.5%/28.0%; category counts/rates and assumptions are in §7. |

`scripts/pdf-corpus/oracle.ts` currently permits no-GID replacements only
when an identical original native font/Unicode/outline exists. Stage 5 must
add name/proc-aware independent probes before allowing new raw-Type1 or
Type3 characters absent from the original native sample. **O1a compares the
native path for the requested cluster to a hand-specified outline**, with
known transform normalization, contour/control coordinates and declared
tolerance. Include the A-label/B-outline adversarial fixture: a non-.notdef
path plus a coverage GID must fail because it is the wrong shape. A positive
parser claim, name agreement or GID alone is insufficient. Native FFI limitations are blockers to broadening
acceptance, not reasons to skip the audit.

Risks: uncommon PS dialects and OtherSubrs reduce eligibility; invalid
FontMatrix/metrics can corrupt all later positions; symbolic labels can look
right while selecting another glyph; tagged/OCR failures may be unrelated to
fonts. Bound CPU/allocation, retain diagnostic uncertainty and prefer precise
refusal over a permissive parser. No claim of recovering all 623 cases.

### 3.7 One-afternoon implementation units

Each row is a separately reviewable afternoon with its listed red tests and
focused gate; rows are sequential dependencies, not a promise the whole
pillar fits one afternoon. Shared setup O0/O1 is listed in §6.

| Unit | Depends on | Bounded deliverable and its own tests |
|---|---|---|
| F1 | O0 | Plain font snapshots/diagnostics; preserve current eligibility. Adapter tests for raw Type1 lengths, CharProc bytes, direct font identity and missing-resource diagnostics. |
| F2 | F1 | PFA/PFB/PDF FontFile containers + cipher only. Independent vectors and truncation/length/budget tests; no enabling edits. |
| F3 | F2 | Declarative dictionaries, Encoding, lenIV and counted CharStrings/Subrs extraction. PS-idiom and delimiter-confusion tests; unsupported idioms stay refused. |
| F4 | F3 | Charstring core, widths, path/hint arities and bounded callsubr closure. Handwritten expected widths/stack failures; glyph eligibility only, no adapter enablement. |
| F5 | F4 | seac and canonical OtherSubrs extension. Independent composed-glyph/flex fixtures plus arbitrary OtherSubr refusal; optional ink hull only where complete. |
| F6 | F4, O1 | Type1 name coverage + PDF width consistency and shared authoritative decode. Native raw-Type1 probe extension and saved shorter/fallback fixtures before enabling this path. F5 increases eligible closure later. |
| F7 | F1, O1a | Existing AFM/name data exported as pure widths; surgical resolver consumes it only after the native identity/compensation gate passes. Default-off in planContentText until then; missing ToUnicode still refuses. |
| F8 | F1 | Type3 d1 path allowlist, metrics/FontMatrix/bounds/read-set proof. Safe/unsafe proc unit matrix; leave walker eligibility disabled. |
| F9 | F8, O1 | Type3 resolved metrics/walker/compiler integration and proc-aware native evidence. Saved code reuse, absent-code fallback, stale-proc and unsafe-state fixtures. |
| F10 | F8 | Optional d0 literal-color subset, bounded ink hull and inherited-color tests. Independent native colored-vector fixture; all resource-dependent d0 still refused. |
| F11 | F1 | Symbolic TT selection evidence and strict subtable bounds; preserve high-byte alias rules. Mapping fixtures and native selected-glyph case, no new general cmap selection. |
| F12 | F11 | Format-2 lookup only if found in diagnostic inventory; otherwise retain precise refusal. Tiny known subheader fixture, malformed bounds, native legacy sample. |
| F13 | F1 | Common PDF CMap local/inherited/duplicate semantics and adapter diagnostics. Regression tests proving inherited holes stay unknown while local entries work in both consumers. |
| F14 | F13, O1a | Uniform one-/two-byte embedded code→CID metrics path. Real /W and native identity/compensation tests. Default-off in planContentText until O1a passes; mixed-length codes refuse, vertical returns unsupported-matrix. |

F3 stops at the first unsupported dictionary idiom with a precise refusal
and its red fixture; do not broaden the PS language to finish the afternoon.
Every extra idiom is a newly scoped unit. F8/F10 exclude cm; CTM-accurate
CharProc hull support is likewise a separate future unit, not implicit work.

## 4. Pillar 2 — bounded within-line layout and paragraph wrapping

### 4.1 Goals, non-goals and policy

Goal: absorb small overflow with conservative spacing, then move a proven
following suffix on the same baseline within one BT…ET. If that still does
not fit, wrap only inside an independently proven paragraph box in that BT.
Keep fixed-neighbour mode, original overflow measurement and its refusal as
the default API behavior.

**Shorter edits keep the original suffix positions and intentional gaps.**
Do not close gaps automatically, even in the Stage-5 reflow policy. A shorter
word need not move a carefully aligned label or equation. Overflow-triggered
wrapping may redistribute its owned tail, but an ordinary deletion does not
trigger paragraph compaction. Closing gaps can be a later explicit policy
with separate acceptance evidence.

Non-goals: cross-BT/page layout, arbitrary rotated/skewed text, full paragraph
typography, hyphenation, default full justification, font-size/scale changes
to fit, bidi/shaping, rebuilding source style, merging edits across items,
moving unowned annotations, tables, formulas or graphics. No inferred
column/paragraph expansion from the page's empty-looking margin alone.

### 4.2 Data model and ownership

Extend the pure compiler with a separate discriminated policy, not new
meanings for `allowOverflow` or `availablePt`:

```ts
type LayoutPolicy =
  | { mode: 'fixed-neighbours' }
  | { mode: 'spacing-only' } // opt-in, inside original slot; no RegionProof
  | { mode: 'bounded-reflow'; proof: RegionProof; maxWrapLines: number };
type SourceAddress = {
  streamHash: string; opIndex: number; itemIndex: number;
  byteStart: number; byteEnd: number; fontObject: string;
};
type TextTrace = {
  // Full snapshots before/after each relevant op; plain numeric state only.
  bt: number; opIndex: number;
  ctm: readonly number[]; tm: readonly number[]; tlm: readonly number[];
  fontObject: string; size: number; tc: number; tw: number; tz: number;
  leading: number; rise: number; renderMode: number; safetyHash: string;
};
type RegionProof = {
  sourceHash: string; dependencyHash: string; bt: number;
  kind: 'paragraph' | 'explicit-line-region'; box: Rect;
  // Every capacity uses its own left/right, never box.x / box.w.
  lineSlots: readonly { baseline: number; left: number; right: number;
    kind: 'observed' | 'explicit-blank' }[];
  indent: { kind: 'flush' | 'first-line' | 'hanging'; amountPt: number;
    emMultiple?: 1 | 2 }; // nonnegative displacement; emMultiple diagnostic only
  leadingPt: number;
  owned: readonly SourceAddress[]; obstacleProofHash: string;
  boundaryProofHash: string; scopeProofHash: string;
  tjBoundaries: readonly { opIndex: number; itemIndex: number; value: number;
    left: SourceAddress | null; right: SourceAddress | null }[];
  // Explicit-line-region is future caller intent, never an inferred margin.
};
type MovedGlyph = {
  source: SourceAddress; code: Uint8Array; unicode: string;
  // PDF user-space pt: copy oldOriginUser / output originUser, never originText.
  oldOrigin: readonly [number, number]; newOrigin: readonly [number, number];
  glyph: GlyphIdentity; ink: Rect;
};
type ReflowManifest = {
  region: RegionProof; moved: readonly MovedGlyph[];
  replacementText: string; visualLines: readonly string[];
  expectedLogicalText: string; spacingRecipes: readonly SpacingRecipe[];
  rejoin: TextTrace; // independently checked after the last affected source op
};
```

`SpacingRecipe` records each scoped Tc/Tw delta, its emitting font/code
segments, affected inter-cluster gaps and actual saved advances. Full
snapshots, ink envelopes, op byte extents, cluster boundaries and original
TJ item identities are required. The current `ShowTextState`/coreQuad is
insufficient; extend the walker read-only before altering compilation.

Ownership is the target's changed clusters plus following movable glyphs on
its proven line, and, for wrapping, an explicitly owned tail of consecutive
paragraph lines. A single selection/replacement still cannot cross TJ items.
Following items may be owned and relocated independently, retaining their
own bytes/identity; they do not become one merged replacement. An existing
equal-scalar planner split remains multiple local edits. Overlapping ownership
between edits is an atomic layout conflict, not a reason to sequentially
rebase one plan on another.

The bounded planner entry accepts an explicit `ReflowRequest` alongside the
source hash/selection: the proven paragraph's source-line addresses,
replacement logical string, explicit hard-break offsets and source visual
breaks being treated as soft. This is necessary because today's overlay
`originalText`/`text` newline arrays do not distinguish user hard breaks from
PDFium's visual lines. Require a source-line-to-code round trip before
treating any break as soft; ambiguous hyphenation, inferred spaces or
paragraph boundaries refuse. Existing overlays without that intent remain
on the unchanged fixed planner path.

In `contentText/planner.ts`, dispatch a validated bounded request before the
current “originals.length !== replacements.length” refusal, then build the
owned token sequence in §4.6. Do not globally remove that refusal, normalize
all newlines away, or send wrapping through `lineChanges` as an ordinary
single-run edit. R7/R8 exercise this pure entry with explicit requests; W1
is the later producer/preview/export wiring. Without a RegionProof, only
the opt-in spacing-only path may recover inside the original slot; exhausted
spacing emits `reflow-spacing-limit`, never a suffix move or guessed box.
The paragraph detector itself returns `reflow-paragraph-unproven` when a
requested wrap box cannot be established, in family `reflow-required`.

### 4.3 Discover the line and its available corridor

1. Walk the immutable stream with full state, including unknown shows and
   all later/earlier paint-order neighbours. Restrict the first version to
   horizontal positive-advance, nonsingular axis-aligned text and known
   widths/Unicode/ink. Same-baseline tolerance is 0.01 pt. Keep original
   `followsUnplaced` barriers; relaxing them is a separate proof/unit.
2. Eligible followers are on that baseline, in the same BT, same source
   font object and physical size (≤0.05 pt), same linear text transform,
   rise, render mode and semantic/graphics proof. Replacement fallback
   segments may differ in font; arbitrary mixed-source-font math cannot
   become an eligible line. Source horizontal scale must be positive and
   unchanged. Compare linear matrix coefficients to relative tolerance
   1e-6 (absolute floor 1e-9), then validate all actual origins to 0.01 pt;
   coefficient tolerance alone cannot authorize visible drift. Existing
   kerning is part of the trace, not an estimated gap.
3. Distinguish relative shows from Tm/Td/T*/TD anchors. Later text with an
   absolute placement is not automatically carried by a changed advance.
   It can move only if explicitly owned, its predicted position is known,
   and its rejoin can be reconstructed. Collinear glyphs in another BT
   are obstacles even if their origins sort next to this line.
4. A right edge comes from §4.5's proven paragraph or an explicit authorized
   line-region proof. **Original editBox and availablePt retain their
   existing fixed-span meaning**; do not silently widen them. No region
   proof means no following-glyph movement or wrap. Before either operation,
   require a RegionProof with a **finite right edge, proven obstacle
   clearance and an explicit owned-follower set**. Spacing alone may still fit
   inside the original slot. In a paragraph, the limit is the minimum of
   its right edge, unchanged clip and first unowned obstacle minus clearance.
5. Verify the whole destination ink corridor against unowned glyphs,
   annotation/widget rectangles and nontext paint. Use conservative bounds
   for simple paths/image quads; an opaque or unbounded possibly intersecting
   paint is a barrier. An unchanged uniform backdrop proven to cover the
   whole region is permitted; unknown partial artwork is not presumed to
   be background. Text not on this line never moves to make room.

This requires a small scene-boundary analyzer alongside the text trace;
today's text walker alone cannot certify an empty region. Bounds failures
produce `glyph-bounds-unavailable` or `reflow-obstacle`, not guessed whitespace.
For a rigidly moved suffix, retain its original pairwise geometry; do not
recompute it from proportional font averages.

### 4.4 Conservative Tc/Tw tightening, then suffix shift

Try the unchanged fixed plan first. On measured overflow only, try the
following deterministic sequence. All budgets are **new shrinkage relative
to the saved source state**, never total negative tracking allowances.

| Quantity | Cap / floor |
|---|---|
| Latin replacement inter-grapheme Tc reduction | ≤0.01 em per eligible gap (0.10 pt at 10 pt) |
| Han/CJK replacement inter-grapheme Tc reduction | ≤0.005 em per eligible gap (0.05 pt at 10 pt) |
| True word-space Tw reduction | ≤min(0.05 em, 20% of that original word-space advance); final space advance ≥0.20 em |
| Combined replacement reduction | ≤2% of its untightened advance |
| Ink clearance at a newly tightened gap | ≥0.01 em between conservative ink envelopes; if this cannot be proven, no shrink at that gap |

“em” is the physical source em under the unchanged text/CTM transform; convert
to text-space Tc/Tw through the measured baseline scale. Do not apply a 0.10
**text-unit** budget blindly to Tf=1/large-Tm or Tf=240/small-Tm files.

- Tighten only the replacement, not every untouched character on the line.
  Apply Tw only for a literal one-byte code 0x20 in the emitting font.
  A two-byte fallback/CID space does not gain Tw by virtue of Unicode U+0020;
  its measured advances must use the actual encoding. Never tighten NBSP,
  inferred whitespace, combining sequences, ligatures internally, tabs,
  zero-advance glyphs or an existing overlap. CJK punctuation/marks get no
  new tightening budget; the initial CJK subset is separated full-em Han.
- Allocate permitted Tw shrink first, then distribute needed Tc shrink
  uniformly over eligible gaps, stopping at the first cap/clearance limit.
  No arbitrary negative kerning to force the last glyph inside the box.
  A no-space CJK run has no Tw budget. Existing negative source Tc is not
  reset; further shrink still must meet all caps and clearance.
- Emit scoped Tc/Tw around the replacement and restore original values
  before any untouched suffix. Account for PDF's spacing after the last
  shown code as well: the recipe explicitly cancels any unintended trailing
  gap change. Do not compute n−1 gaps while emitting n spacing increments.
  Mixed-font segments get separate actual advances and boundary adjustments.
- If this fits the original span, keep fixed neighbours and original terminal
  compensation. **Otherwise stop here unless a validated RegionProof already
  supplies a finite right edge, obstacle clearance and owned followers.**
  Without it the primary refusal is `reflow-spacing-limit`, with exhausted
  caps/available/needed points in data; leave every following glyph unmoved.
  A same-BT/same-style neighbour alone is not ownership. Only with that
  precondition may the solver take the largest permitted conservative shrink,
  compute residual overflow and shift the entire owned suffix right by
  exactly that residual. No left shift for shorter replacements. Check all
  moved ink and the last glyph, not just the replacement endpoint.
- If a suffix boundary would break preserved kerning or require moving an
  unowned anchor, refuse `reflow-context-unsupported`. If no safe in-line
  capacity exists, wrapping may be attempted only **after** §4.5 constructs
  its own valid RegionProof; no speculative move precedes that proof. If
  discovery fails after exhausted spacing, retain primary
  `reflow-spacing-limit` and add `reflow-paragraph-unproven` as a typed blocker.
  An explicitly requested paragraph-proof/wrap operation that fails discovery
  returns `reflow-paragraph-unproven` (family `reflow-required`). The reporter
  counts primary reasons and blockers separately; no proof means no rewrite.

For an item-local replacement with total old/new advances Aold/Anew in
today's 1000-em-plus-spacing units and factor
`k = fontSize * |advanceVector| / 1000`, a desired downstream displacement
Δpt needs terminal TJ number `Anew - Aold - Δpt/k`. Positive TJ numbers
subtract displacement. Δpt=0 is exactly today's compensation. After the
last owned follower, rejoin the original endpoint before unowned text.
Compute from the actual emitted segments and saved Tc/Tw/Tz; do not use a
Unicode character count or fontkit advance estimate.

### 4.5 Detect a paragraph box; never extrapolate its capacity

The detector operates on existing showing/positioning operators, not DOM
paragraph guesses. It returns a proof or **`reflow-paragraph-unproven`**,
family `reflow-required`, detail `No proven paragraph box for wrapping`.
The original fixed planner keeps its existing `reflow-required` behavior;
the bounded caller handles a failed proof as specified in §4.4. Initial
proof requires all of:

1. At least three consecutive nonempty lines in one BT, same font object,
   physical size within 0.05 pt, same axis-aligned linear transform,
   Tc/Tw/Tz/rise/render mode and compatible safety/marked-content scope.
   No inline math, superscripts, quote ops, unknown shows, path painting,
   overlapping rows or column interleaving in the candidate tail. Existing
   local TJ kerns are allowed but remain attached to their source boundaries.
2. Positive explicit TL or consistent observed y-advance. If TL exists, each
   y-advance must match it after transformation; otherwise require at least
   two matching observed advances. Tolerance is min(0.25 pt,
   max(0.10 pt, 1% of physical leading)). No inference of an extra blank row
   merely from a large gap.
3. **Flush unit:** shared left origins within min(0.50 pt,
   max(0.25 pt, 0.025 em)). **Indented unit:** the first line may have a
   distinct left origin beyond that tolerance, while all remaining body
   lines (including the ragged final line) share left origins within it.
   Further right is `indent.kind = 'first-line'`; further left is `hanging`.
   `amountPt` is the nonnegative difference between first left and the
   conservative body left (the larger matched body origin). Every slot
   records its own left: the first line's measured show origin for an indent,
   the conservative body left thereafter; flush slots use the larger
   matched origin. No other alternating/unique later-line indent is inferred.
   At least two nonfinal line advance endpoints share a right edge within
   min(1.0 pt, max(0.50 pt, 0.05 em)); take the smaller matched edge for
   every slot's right limit. Validate original/proposed conservative ink
   within the proven box; a ragged final line may end earlier. A centered
   caption, table cell or two aligned labels is not a paragraph proof.
   A non-round indent is eligible: CJK 1 em / 2 em and the corpus's ~20 pt
   at ~10 pt are examples, not a quantization rule. Optional `emMultiple`
   diagnoses 1/2 em within min(0.5 pt, 0.05 em) without affecting eligibility.
4. The box spans the conservative ink envelopes at the first/last known
   baselines, with ≤0.5 pt raster guard, entirely inside crop/clip bounds.
   Its vertical slots are the observed baselines plus **explicitly encoded
   blank baseline slots** of the same leading/style within that box. No
   bottom extension beyond observed/explicit region bounds. No object,
   annotation or other text can intersect destination space except the
   stationary backdrop allowed in §4.3.
5. Reject vertical overlap between line ink envelopes even if leading is
   nominally regular. Reject unresolved ActualText/Alt/E or tagged scopes
   whose structure/reading order would change when codes move between
   lines. Same MCID alone does not prove safe line redistribution.

These geometric conditions identify a conservative layout container, not
semantic certainty. Require complete, monotonic reading order inside each
source item and across owned lines. Ambiguous text-order/whitespace provenance
or uncertain column/paragraph boundary refuses. An explicit future caller
region must still pass ownership/obstacle/clip checks and stay inside one BT;
it cannot bypass an unknown glyph or state.

The indented-paragraph unit is normative. Mandatory **positive** fixture:
three Chinese lines in one BT, matching style/leading/right edges, first
left 24 pt to the right of the two body lines. The proof records
`first-line`, `amountPt: 24` and the first slot's actual narrower capacity.
Add ~20 pt / 2 em and hanging-indent positives. The proof box may begin at
the body left (or minimum conservative source ink), but first-line wrapping
and occupancy must use `lineSlots[0].left/right`, never that overall box.
A leading TJ displacement can encode the indent after a flush Tm; use the
first actual show origin, not the pre-kern anchor. The sibling adversarial
fixture must never produce a first slot using the
body left: that would erase the indent and overstate capacity. Two-line
candidates, inconsistent body indents, shifted later lines, tables/captions,
column interleaving, unencoded large gaps and unknown scope/order/whitespace
still refuse `reflow-paragraph-unproven`. Indents grant no extra baseline,
right-edge growth or deletion compaction (§4.1), and earn no corpus credit
without measured/native evidence (§7.2).

R6's pure `detectParagraphRegion` seam consumes tokenized operators,
per-item full before/after `TextTrace`, explicit line-anchor snapshots,
conservative ink and revision-bound R1/R2 scene/boundary/semantic evidence,
including explicit plain-prose (no inline math/superscript) evidence.
It does not infer a non-table paragraph from alignment alone. The initial
seam requires a first absolute Tm; subsequent Tm/Td/TD/T* anchors are checked
against saved Tlm. Whole source string items are owned in monotonic order,
including every original TJ number and its neighbouring source addresses;
unexplained displacement or an unowned show is not proof. Blank slots need
an actual position anchor inside the first/last nonempty ink box. Scope,
scene and boundary hashes must be revalidated before use; today's reduced
ShowTextState/coreQuad cannot manufacture those inputs. R6 exports all
three integration flags false and stays disconnected from the planner.

### 4.6 Wrap and splice only the owned tail

Preflight before layout: require a RegionProof and a contiguous source
operator range from first to last owned show. The **only** allowed operators
in that range are `Tj`, `TJ`, relative moves `Td`/`TD`/`T*`, and the exact
line-anchor `Tm`s explicitly owned/replayed by this plan. Any other original
operator—color, gs, clip/path, q/Q, Tf, Tc/Tw, marked-content or an unowned
absolute Tm—refuses `reflow-context-unsupported`. Generated, scoped replacement
font/spacing operators are validated emission recipes, not permission to
move original state operators. Replay every unowned operator's original
bytes at its original boundary; no unowned operator is skipped or reordered.

1. Begin at the overflowing replacement, retain its unmoved prefix and all
   earlier lines. Assemble an ordered token sequence of replacement
   graphemes, untouched source-code slices and literal spaces, each with
   measured width, ink, font/state and original byte/item provenance. Retain
   hard line breaks as hard breaks; distinguish original visual soft breaks.
   Unknown inferred-word-space provenance refuses; do not insert guessed
   literal spaces because the old oracle stripped whitespace.
2. Greedily fill existing line slots to the proven right edge using actual
   advances and ink. Initial break whitelist: literal ASCII-space boundaries
   in simple Latin text, and boundaries between two plain Han graphemes.
   Do not split graphemes, ligatures, NBSP, surrogate pairs, math, Kana
   small-letter sequences, or adjacent opening/closing punctuation.
   Unsupported required breaks return `reflow-break-unsupported`. Broader
   Unicode line breaking can be a later unit; this is not UAX#14 completeness.
3. Carry the overflow tail into the next known slot and include that line's
   existing owned text; continue only while it fits inside the same box.
   Limit to eight owned lines and 4,096 source/replacement clusters per plan
   initially. If another baseline below the last proven slot is necessary,
   refuse `reflow-paragraph-full`. Do not push a paragraph below or create a
   page. An inserted line can use an explicitly encoded empty slot, but cannot
   turn speculative bottom whitespace into a new slot.
4. Splice only affected Tj/TJ operator extents and insert explicit Tm (or a
   proved Td/T* equivalent) before carried text. Source slices moved to a
   different show retain their original bytes/font and relative order.
   Leave all unowned operators byte-for-byte. A TJ number is attached to
   the **boundary between its two string items**, not just the preceding
   or following glyph. When both strings move, their boundary and intervening
   number sequence move together in the same order. A wrap splitting a
   nonzero-kern boundary refuses; do not leave the number on the old line,
   drop it or attach it to a different pair. Unpaired leading/trailing
   nonzero numbers whose boundary cannot be proven also refuse
   `reflow-context-unsupported`. No rebuilding the BT or reserializing graphics.
5. Track both **Tm and Tlm** at every splice. `q/Q` does not restore text
   matrices. After an inserted-line window, restore original text parameters,
   emit the saved original Tlm with Tm, then a number-only TJ to reach the
   original Tm endpoint along its baseline. This works only if the saved
   matrices have identical linear parts and their translation difference
   is representable as a finite horizontal text advance. Otherwise refuse
   `reflow-context-unsupported`. Verify a subsequent original Td/T*/TD uses
   the original line start and leading. Do not restore only visible origin.
6. Output a manifest for every moved original glyph and every intended
   replacement, including the exact output line breaks. Rewalk the compiled
   bytes with an independently checked state trace: unmoved prefixes,
   original rejoin matrices and all glyph destinations must match the plan.
   Install nothing if any proof or sibling fails.

This explicitly revises the fixed compiler's unmoved-suffix invariant inside
the owned region. Original codes, glyph identities and kern sequence survive;
new layout translations/Tm and scoped spacing are the only permitted layout
changes. In-line movement has zero outside-line changes; wrapping has zero
outside-paragraph changes. A broad page-sized “paragraph” cannot pass proof.

### 4.7 Invariants, tests, risks and acceptance targets

- Every untouched glyph outside the owned line/tail retains Unicode, font
  identity and origin: ≤0.005 pt target, ≤0.01 pt hard gate. Every moved
  glyph matches its predicted origin to the same tolerances. Zero changed
  pixels outside the predeclared paragraph/line box at 144 dpi; no widening
  the mask after seeing the differences.
- Compensation is exact for unmoved prefixes/endpoints, including Tc/Tw
  and switching fallback Tf. Source TL/Ts/Tz/Tlm and the next text object
  resume their saved state. Existing kerns are never “helpfully” normalized.
- The saved document's extracted logical Unicode, spaces and hard breaks
  equal the intended string. Compare visual line breaks to the manifest
  separately; normalize only documented reader-specific CRLF and planned
  soft-break representation. Never use whitespace compaction as the only
  reflow text check. qpdf must be clean, no .notdef, no new ink overlap.
- Refused/hybrid siblings remain at original geometry. Extend `apply.ts`'s
  immutable preflight/combined install and `shared-text-object` downgrade
  to the complete reflow ownership region. No partially moved lines if a
  second edit refuses. Mutually overlapping regions refuse, not last-writer-win.

Failure lists and tests precede code:

| Tier | Cases / required evidence |
|---|---|
| Trace/geometry unit | Nondefault Tc/Tw/Tz/TL/Ts, Tf=1 and Tf=240 matrix scaling, Tm/Td/TD/T*, q/Q, number-only TJ, earlier-painted later glyph, negative kern, independent BT/columns and unknown-advance barriers. |
| Budget unit | Exactly-at and beyond every cap, 10 pt examples, zero eligible gaps, literal 0x20 versus CID space, CJK without spaces, existing negative tracking, trailing Tc, mixed fallback, rounding at 1e-7 overflow tolerance, conservative ink clearance. |
| Shift unit | Rigid following suffix only under RegionProof; mandatory same-BT neighbour past the span with no supplied box stays at its exact old origin and exhausted spacing refuses reflow-spacing-limit. Explicit anchors, unowned neighbours, shorter gap preservation, empty/identity replacement, endpoint and relative show. |
| Paragraph/wrap unit | Three-line flush/first-line/hanging proofs versus two labels; 24 pt Chinese indent proves with its own first-slot capacity, while a sibling must never borrow the body left. ~20 pt/1 em/2 em/non-round positives; inconsistent later indents refuse reflow-paragraph-unproven. Any interleaved gs/color/q/Q/clip/unowned Tm refuses reflow-context-unsupported. TJ boundary numbers move with both strings; split nonzero boundary refuses. Ragged final line, wrong leading/style/edges, obstacles, exact bottom, NBSP/graphemes, inferred spaces and hard breaks. |
| Native PDFium | Before/after/probe PDFs and independent predicted origins for moved glyphs; after a wrapped line exercise untouched Td/T* to detect Tlm damage; original backgrounds/overlapping vector fixtures, whitespace counts, same-font/fallback CJK. Exact outside-region raster comparison and independent text extraction; qpdf clean. |
| Corpus | The reference fixed run reproduces the baseline; record any tighter-rule regressions separately. O0 measures spacing-only fits among 208 overflows; until published, additional corpus credit is 0/0/0 (20.7% baseline), not an estimated fit count. All 71 known eightfold expansions stay refused. Explicit-box suffix-shift is a fixture target; no inferred-box/wrap credit. See §7.2. |

Risks: a regular-looking paragraph can actually be a table; Tm changes can
leave Tlm damaged; compiler and oracle could share the same layout mistake;
coreQuad bounds omit overhangs; many LaTeX overflows are math/explicit kerns
and correctly stay refused. Independent native destinations, fixed region
masks, hard refusal on unproven ownership and no automatic box expansion
are prerequisites, not optional follow-up hardening.

### 4.8 One-afternoon implementation units

| Unit | Depends on | Bounded deliverable and its own tests |
|---|---|---|
| R1 | O0 | Read-only full Tm/Tlm/state trace and source cluster provenance; all geometry/unknown-show tests, no acceptance change. |
| B1 | O0 | Revision-bound ink envelopes for validated TT/CFF and existing fallback glyphs using the already parsed program/path data. Hand-specified outline/extrema/overhang fixtures and native envelope checks; unavailable bounds remain explicit. Type1 hulls come from F5 and Type3 hulls from F8/F10. |
| R2 | R1, B1 | Corridor obstacle proof for text and simple bounded paints; unknown-paint refusal and background/annotation fixtures. May initially refuse more reflow candidates. |
| R3 | R1, O1 | Numeric budget and scoped-spacing compiler for replacement only. Cap/word-code/trailing-spacing tests plus native fixed-slot fixture. |
| R4 | R2, R3 | Same-line relative-show suffix movement inside an explicit/proven region; residual compensation and rejoin. Independent moved-origin native fixture. |
| R5 | R4 | Owned absolute-anchor followers + saved Tlm reconstruction. Tm/Td/T* regression fixtures; unrepresentable rejoin refuses. |
| R6 | R1, R2 | Paragraph detection/proof only, including flush, first-line and hanging indent units with per-line slots. Positive 24 pt/~20 pt CJK and hanging fixtures; adversarial stolen-first-capacity/body-pattern/table/column/leading/semantic fixtures. No wrap enablement. |
| R7 | R5, R6 | Pure greedy token-to-existing-slot layout with Latin-space/Han breaks. Expected origins specified by hand; bottom/full/unsupported-break tests. |
| R8 | R7, O1 | Surgical wrapped-tail emitter for one replacement and existing line slots. Native inserted-Tm, untouched next-line/Tlm and exact text/raster fixtures. |
| R9 | R8 | Atomic multi-overlay ownership checks in existing adapter seam; stale/overlap/refused-hybrid tests. One native two-edit rollback scenario. UI controls remain a later unit. |
| L1 | R1, B1 | Standalone Rust measured-cluster layout service + mandatory PDF widths/TJ adapter from §4.9. Hand-specified flush/first-line/hanging slot origins plus metric/break/kinsoku/overflow failures; unchanged advances and original boundary identity must survive. No writer or app dependency. |
| L2 | L1, R6, O1b | Versioned JSON/FFI adapter to feed R7 with proven slots and verified source/replacement codes. UTF-8/cluster round trips, stale proof and response validation; no production enablement before R8/O1b/W1. |

Near-term pillar-2 success means spacing-only within the original slot and
suffix-shift on an **explicit fixture RegionProof**, plus standalone R6
flush/first-line/hanging proofs and L1 slot consumption. These are fixture
capabilities, not a corpus paragraph recovery claim. R8 stops at the first
precise refusal plus its red fixture;
extra interleaved operators and boundary idioms are new units, not more
work hidden inside an afternoon emitter task. R8 must consume the R6 indent
slots exactly; it must not implement a second indent detector.

### 4.9 Layout engine selection

**Select a PDF-metrics-first bounded Rust layout service**: HarfRust 0.16.0
for newly needed fallback clusters, unicode-linebreak 0.1.5 for candidate
breaks, unicode-segmentation 1.12.0 for graphemes and unicode-bidi 0.3.18 as
an unsupported-direction guard. Keep source-code clusters outside Unicode
reshaping. A small greedy breaker uses PDF advances, conservative ink and
the existing slots from `RegionProof`, including each first/body left/right
and observed/explicit-blank baseline; no global-box capacity substitution,
OS metrics or font discovery.

The [bounded layout design](SPEC-stage5-layout-engine.md) requires source
codes, dictionary advances and TJ boundaries before line breaking. A layout
that adjusts positions after line wrapping can select the wrong break.

This narrows the older “no Rust font stack” boundary in §1.3 only for layout.
PDFium remains reader/renderer; TS owns verified fonts, source addressing,
RegionProof, policy/refusal decisions, compensation and Tj/TJ compilation;
pdf-lib remains assembler. Rust returns layout data, never PDF bytes, a new
box, an inferred baseline or permission to move an unowned glyph. Web/mobile
can use the same pure service via WASM later; Android and desktop native
bindings need their own target gates. The layout contract keeps dependency and platform gates explicit.

L1 is the only later Rust implementation exception to §6's current no-Rust
scope; web reflow stays off until the same service exists for the worker.

**Wire contract (proposed, version 1).** Reuse §2.1 and §4.2 types below;
`Bytes` is a JSON integer array of octets (native bindings may use a byte
buffer), `Matrix` is six finite PDF affine coefficients and offsets are
**UTF-8 byte offsets** into the specified logical string. TS converts its
UTF-16 offsets only at checked grapheme/source-code boundaries. Do not split
a multi-scalar source code/ligature to satisfy the wire encoding.

```ts
type Bytes = readonly number[];
type Matrix = readonly [number, number, number, number, number, number];
type LayoutFont = {
  fontObject: string; dependencyHash: string; programHash: string;
  program: { bytes: Bytes; format: 'sfnt-tt' | 'sfnt-cff' | 'raw-cff' }
    | { handle: string }; // revision-bound registered immutable program
  // raw-cff means a TS-validated face/handle or TS-prepared SFNT wrapper;
  // this does not authorize a new Rust raw-CFF parser.
  // Type1/Type3 parsing stays outside the service, using proven TS records.
  codes: readonly VerifiedCode[]; // width1000 is PDF /Widths or /W + /DW
};
type LayoutCluster = {
  id: string; logicalUtf8: readonly [number, number]; // sourceLogicalText
  unicode: string;
  source: SourceAddress; code: Bytes; glyph: GlyphIdentity;
  fontObject: string; width1000: number;
  state: { size: number; ts: number; tc: number; tw: number; tz: number;
    writingMode: 'horizontal-ltr'; tm: Matrix; ctm: Matrix;
    singleByteWordSpace: boolean };
  oldOriginText: readonly [number, number];
  oldOriginUser: readonly [number, number];
  advanceText: number; advanceUser: readonly [number, number];
  inkUser: Rect; // B1/F5 conservative proof, never hmtx used as ink
};
type LayoutBoundary = {
  leftId: string; rightId: string;
  sourceItems: readonly SourceAddress[];
  tjNumbers: readonly number[]; // original ordered numeric boundary recipe
  advanceText: number; advanceUser: readonly [number, number];
  splittable: boolean; // hint only; recompute from tjNumbers and §4.6
};
type LayoutRequestBodyV1 = {
  version: 1; requestHash: string;
  sourceHash: string; dependencyHash: string;
  sourceLogicalText: string; // LayoutCluster.logicalUtf8 refers to this
  expectedLogicalText: string; // validated source + the item-local replacement
  sourceLineCount: number; // observed source visual lines, not slot capacity
  fonts: readonly LayoutFont[]; clusters: readonly LayoutCluster[];
  boundaries: readonly LayoutBoundary[];
  replacement: {
    sourceClusters: readonly string[]; // one item-local selection
    logicalText: string;
    codes: readonly { logicalUtf8: readonly [number, number]; // replacement.logicalText
      verified: VerifiedCode; fontObject: string;
      stateFromCluster: string; inkUser: Rect }[];
  };
  // Both offset fields below refer to expectedLogicalText, not source text.
  hardBreakUtf8: readonly number[];
  authorisedVisualSoftBreaks: readonly {
    logicalUtf8: number; left: SourceAddress; right: SourceAddress;
    join: 'none' | 'literal-source-space';
  }[];
};
type LayoutRequestV1 = LayoutRequestBodyV1 & (
  | { policy: Extract<LayoutPolicy, { mode: 'spacing-only' }>;
      evaluation: 'natural-advances'; // no tightened state/gaps from Rust
      spacingSlot: { box: Rect; baseline: number; left: number; right: number } }
  | { policy: Extract<LayoutPolicy, { mode: 'bounded-reflow' }>;
      spacingSlot?: never; evaluation?: never }
);
type LayoutOutputGlyph = {
  clusterId: string; logicalUtf8: readonly [number, number]; // expectedLogicalText
  unicode: string; // corresponding expectedLogicalText slice
  identity: { kind: 'source'; source: SourceAddress; code: Bytes }
    | { kind: 'replacement'; replacementCodeIndex: number; code: Bytes };
  glyph: GlyphIdentity; fontObject: string; lineSlot: number;
  originText: readonly [number, number]; originUser: readonly [number, number];
  advanceText: number; advanceUser: readonly [number, number]; inkUser: Rect;
};
type LayoutOutputBoundary = {
  leftId: string; rightId: string;
  advanceText: number; advanceUser: readonly [number, number];
} & ({ kind: 'retained'; inputBoundaryIndex: number }
  | { kind: 'new-natural'; inputBoundaryIndex?: never });
type LayoutResultBodyV1 = {
  version: 1; requestHash: string; sourceHash: string; dependencyHash: string;
  // Fit includes advances AND conservative ink, not just character count.
  fits: boolean;
  glyphs: readonly LayoutOutputGlyph[];
  breakUtf8: readonly { utf8: number; kind: 'hard' | 'soft' }[]; // expectedLogicalText
  boundaries: readonly LayoutOutputBoundary[];
  spacingRecipes?: never; // only the TS §4.4 solver creates these
  visualLines: readonly { slot: number; text: string; baseline: number;
    predictedInk: Rect; glyphRange: readonly [number, number] }[]; // glyph array indexes
  metrics: { maxAdvanceErrorPt: number; maxEndpointErrorPt: number };
  // Typed service evidence; TS maps it to §2.2, never message substrings.
  blocker?: 'metrics' | 'break' | 'capacity' | 'context' | 'bounds';
};
type LayoutResultV1 = LayoutResultBodyV1 & (
  | { mode: 'spacing-only'; evaluation: 'natural-advances'; lineCountChange: 0 }
  | { mode: 'bounded-reflow'; lineCountChange: number } // after minus before
);
```

`fixed-neighbours` never calls this service. In `spacing-only`, Rust only
answers whether **natural PDF advances** fit the validated original
`spacingSlot`, without moving unchanged source origins or changing line
count/ownership. Rust must not tighten gaps, change Tc/Tw or return a
`SpacingRecipe`; all tightening, cap/clearance checks and scoped recipes stay
in the TypeScript §4.4 solver. Reject a response that violates this contract.
For bounded layout require the revision-matching `RegionProof`
and `maxWrapLines` (at most eight existing slots, 4,096 clusters), not merely
numbers resembling a paragraph rectangle. There is no unproven-space join:
softening a source visual break requires §4.2's source-line-to-code round trip.
Unknown inferred spaces/hyphens refuse. Every input hard break must reappear
at the same `expectedLogicalText` offset tagged `hard`; a missing tag is
invalid, never implicitly `soft`. Hard breaks cannot be removed or retagged;
unsupported break needs map to `reflow-break-unsupported`. Candidate UAX14
breaks are intersected with the **existing §4.6 Latin-space/plain-Han whitelist**,
grapheme boundaries and the prohibition filter; this decision does not expand
the accepted scripts. Justification and hyphenation stay disabled.

Every UTF-8 range is half-open in its named string: source cluster ranges
use `sourceLogicalText`; replacement-code ranges use
`replacement.logicalText`; output glyph ranges, both input break fields and
tagged output breaks use `expectedLogicalText`. Replacement ranges must be
ordered, adjacent and partition the complete `replacement.logicalText` on
grapheme boundaries (empty ranges list for an empty replacement). An output
glyph's Unicode must equal its named slice; visual line text must equal the
concatenation of `unicode` in its half-open `glyphRange`. `lineCountChange`
is output visual-line count minus the TS-validated `sourceLineCount`. A hard-break
offset is immediately after its LF in `expectedLogicalText`; a soft-break
offset is a cluster boundary and inserts no logical character. For example,
in `人工智能指的是借助`, `借` starts at JS UTF-16 index 7 but UTF-8 byte 21;
passing 7 as its UTF-8 offset is invalid.

The codec must bound byte lengths, reject NaN/infinity and unknown
handles/versions, validate every offset/identity, and compute `requestHash`
as SHA-256 of the canonical UTF-8 JSON **request body with `requestHash`
excluded** (sorted object keys, preserved array order, finite JSON numbers).
A handle resolves only while its registered bytes match `programHash` and
its dependency set matches `dependencyHash`; invalidate it when the source
revision changes. Never resolve by BaseFont/system family. `raw-cff` is a
TypeScript-validated face or SFNT wrapper, not permission for a new Rust CFF
parser. HarfRust/read-fonts IDs are not glyph identity or width authority.
Type1/Type3 parsing, subsetting and embedding remain outside the service;
an unavailable F5 proof remains a precise refusal. HarfRust shapes proposed
fallback text only during preparation; TS verifies coverage/embedding and
returns its actual subset codes and
dictionary metrics for final layout. No hidden fallback occurs in Rust.

**Mandatory PDF metrics adapter.** Compute a horizontal code's text advance
as `(width1000 / 1000 * size + Tc + eligibleTw) * (Tz / 100)`;
Tw is eligible only when `singleByteWordSpace` is true **and** the code is
exactly one byte 0x20. Apply the supplied Tm/CTM linear basis to that vector;
Ts affects origin/ink, not advance. Retain each
ordered TJ boundary's signed `-number / 1000 * size * Tz / 100` displacement
in that same basis. Do not replace it with GPOS kerning or spread it between
characters. Width authority is `(font object, code, state)`, not GID alone.
An embedded subset can lack a Unicode cmap; verified code→GID remains usable
without reshaping unchanged codes. Unknown identity/metrics/bounds refuse.

Apply `tz` once in the advance/cursor calculation; do not also bake it into
`tm`. `originText` is the text-basis cursor after that single horizontal
scale and including `ts`; map it through the supplied Tm then CTM to
`originUser`. The matrices retain their source linear parts, without an
extra normalization by `tz`. Refuse `layout-metrics-disagreement` if this
mapped origin differs from `originUser` by more than 0.005 pt. Input
`oldOriginText` must pass the same mapped-origin check against
`oldOriginUser`. Copy source
`oldOriginUser` and output `originUser` to `MovedGlyph.oldOrigin/newOrigin`,
both in PDF user-space pt; never copy `originText`.

Before returning and again in TS before compilation, compare **every output
cluster, including replacements**, against its `VerifiedCode` dictionary
width and validated state, and compare **every retained or new boundary**
and cumulative endpoint against its authorized PDF displacement, at
**≤0.005 pt in user space**. Unchanged source clusters and retained TJ
boundaries remain in this check. A retained boundary must match its indexed
input recipe; a `new-natural` boundary has zero extra displacement beyond
the code/state advances, not a guessed hmtx/GPOS adjustment. Recompute
`splittable` from the actual ordered `tjNumbers`: any nonzero number makes
that kern boundary unsplittable under §4.6, regardless of the supplied flag.
Refuse `layout-metrics-disagreement` before inventing any TJ number that
would force a non-dictionary or non-verified-fallback cluster advance.
`metrics` reported by Rust does not replace the independent TS calculation.
This does not remove TS's separately validated rejoin/compensation recipes
in §4.6; cursor restoration must not disguise a changed glyph advance.
Raw program hmtx disagreement is a recorded diagnostic when overridden by
authoritative PDF widths, not an
automatic excuse to substitute metrics. If adapted output still disagrees,
never write drifted coordinates. Native PDFium additionally compares original
source positions and predicted destinations (§6.2); a source/native conflict
cannot pass merely because the adapter agrees with itself. The existing
0.01 pt hard oracle limit remains unchanged; 0.005–0.01 pt is investigatory
and does not satisfy this service's stricter metric handoff.

**TS validation and surgical mapping.** Match all response hashes, consume
every intended source/replacement identity exactly once and reject any new
unowned identity/slot/box. TS builds the existing `MovedGlyph[]` and
`ReflowManifest` (including replacement text/visual lines/spacing recipes and
saved `TextTrace` rejoin); `LayoutResultV1` is evidence for that manifest,
not an alternative ownership model. Map metrics/break/capacity/context/bounds
blockers to `layout-metrics-disagreement` (family `reflow-required`),
`reflow-break-unsupported`,
`reflow-paragraph-full`, `reflow-context-unsupported`,
`glyph-bounds-unavailable` respectively. Stale sources, obstacle failures and
bad RegionProofs remain TS decisions with their existing precise codes.

1. Preserve all unmoved prefix/suffix codes, dictionary widths, original TJ
   kern numbers and compensation. Shorter edits preserve suffix origins and
   intentional gaps (§4.1); they do not request paragraph compaction.
2. A single selection/replacement cannot cross TJ string items. Relocate
   following owned items independently, with original byte slices/addresses;
   never concatenate them into a newly encoded paragraph string. Preserve
   ordered TJ numbers between their original pair of items. If wrapping would
   split a nonzero-kern boundary, refuse as in §4.6.
3. New line starts use only §4.6's contiguous Tj/TJ window, permitted relative
   moves and explicitly owned/replayed anchor-Tm operators. Never rewrite BT,
   drop an interleaved operator, reset the whole text object or ask Rust for
   content-stream bytes. Scoped spacing/font recipes restore exact state.
4. Reflow changes **only the position invariant for its owned glyphs**.
   Restore saved Tlm and Tm with the proven anchor plus residual number-only
   TJ recipe, not q/Q. Unowned origins and rejoin endpoints remain exact;
   rewalk the compiled bytes independently before one atomic installation.
5. Keep this service and R7/R8 **default-off** until native PDFium O1b gates
   are green: original/replacement identity and ink, predicted moved origins,
   untouched neighbours, Tlm-relative next line, zero outside-region pixels,
   extraction and clean qpdf. Unit layouts and debug PNGs do not enable it.

## 5. Pillar 3 — proven state dependencies and Form invocations

### 5.1 Goals, non-goals and data model

Goal: subdivide the current 111 identical state refusals, allow containment-
proven clips and already-safe semantics, and edit text inside a selected Form
invocation through copy-on-write. The 14 Form refusals are all LaTeX, but
`planner.ts` has not proved that those particular selections are in Forms.
Resolve actual invocation paths before calling any of them recoverable.

Non-goals: editing clip-producing text, rewriting ActualText/Alt/E or
structure trees, arbitrary transparency/soft-mask effects, changing
ExtGState fonts, editing a Form used as a soft mask/pattern/annotation
appearance, editing all instances at once, untangling cycles or mutating a
shared stream/resource. Reflow inside Forms is deferred; first support the
fixed-neighbour font paths only. This limits interaction risk and makes the
Form units finishable.

```ts
type SafetyProof = {
  dependencyHash: string;
  clip: { kind: 'known-rect'; rect: Rect } | { kind: 'unknown' };
  renderMode: number;
  graphics: { fontOverride: boolean; supportedValues: boolean };
  marked: readonly {
    scope: number; mcid?: number; semanticKeys: readonly string[];
    propertiesHash: string; structureHash?: string;
  }[];
  inkEnvelope?: Rect;
};
type InvocationStep = {
  parentStreamHash: string; doOpIndex: number; resourceName: string;
  formObject: string; formStreamHash: string; resourceScopeHash: string;
  matrix: readonly number[]; bbox: Rect; seededStateHash: string;
};
type ResourceScopeSnapshot = {
  owner: string; resourcesPresent: boolean; dictionaryHash?: string;
  bindings: ReadonlyMap<string, ReadonlyMap<string, {
    objectId: string; dependencyHash: string;
  }>>; // resource category -> name -> original object identity
};
type FormEditPlan = {
  pageIdentity: string; pageSourceHash: string;
  path: readonly InvocationStep[];
  leafPlan: RunPlan; // local decoded-byte Tj/TJ spans, fixed-neighbour policy
  resourceChain: readonly ResourceScopeSnapshot[]; // page -> ancestor -> leaf
  dependencyHash: string; safety: SafetyProof;
};
```

The pure layer receives plain stream/scope IDs, matrices, resources and
hashes. The pdf-lib adapter owns cloning/allocation. Add a seedable walker
entry state for nested content; current identity-only `walkTextPlacements`
cannot simply walk a Form and pretend its coordinates are page coordinates.
Forms' implicit state save/restore and BBox clip are modeled explicitly.

### 5.2 Split and prove state eligibility

First inventory the 111 rows with exact op/scope/resource blockers. The
current dependent boolean loses this information. Replace it with a
q/Q-restored state ledger, while marked-content scopes stay independent of
q/Q as in today's compiler. Track pending path/clip state correctly; W/W*
does not justify applying a rectangle before the path terminator.

| Dependency | Stage-5 decision | Precise refusal when proof fails |
|---|---|---|
| Tr 0 ordinary fill | Eligible with complete bounds/state proof | existing geometry/font code if unresolved |
| Tr 1/2 stroke or fill+stroke | Refuse throughout this stage; no stroke-envelope eligibility or miter-width approximation | `graphics-effect-unsupported` |
| Tr 3, alpha=0, or fill text wholly covered by an earlier opaque image with no later uncovering paint | Apply the explicit invisible-layer predicate below before source/fallback replacement; no visible text painted over a scan | `invisible-text-layer` |
| Tr ≥4 clip-producing text | Refuse even if glyphs currently look contained; replacing them changes later clipping | `text-clip-dependent` |
| No additional path clip / known page or Form BBox clip | Eligible if both old/new ink fit; BBox is transformed to page space | `clip-target-intersection` |
| Known rectangular path clip | Allow unchanged clip if all old/new ink envelopes, including raster guard, are strictly contained in its intersection | `clip-target-intersection` |
| Complex/unknown clip | Do not approximate by its bbox or drop clip operators | `clip-unproven` |
| Resolved ordinary gs with no Font | Preserve gs bytes; validate dictionary **values** and dependencies, not only allowed key names | `graphics-effect-unsupported` |
| gs with Font or unresolved dictionary | Retain refusal, even if a later Tf looks familiar without full state proof | `graphics-state-font` / `graphics-state-unresolved` |
| MCID-only BDC or ordinary BMC | Already supported, not new acceptance. Preserve tag/property object and reading-order identity exactly | `marked-content-unresolved` if scope/properties cannot be resolved |
| ActualText/Alt/E inline, named or relevant structure-tree semantic override | Keep refused; replacing glyphs without changing this text would leave copy/accessibility semantics stale | `semantic-text-dependent` |
| Unknown property key with unknown semantics; unresolved OC visibility | Conservative refusal. Only proven MCID-only/ordinary tag scopes are newly certified | `marked-content-unresolved` |
| BI/BX/EX, malformed state or opaque unknown operators | Keep complete-parse requirement; do not authorize a partial walk | `opaque-content` / `content-malformed` |

The **invisible-text-layer** predicate is Tr 3, effective fill alpha 0, or
fill text whose **entire ink box is covered by an earlier opaque image with
no later uncovering paint**. For the image case, snapshot target/image op
indices, transforms and clips; require a genuinely opaque image (no mask,
SMask or nonunit effective alpha/blend), full containment in its actual
paint region, and a complete later-paint ledger. “Earlier” follows source
painting order; this is a conservative edit-eligibility predicate, not a
claim that an earlier image physically occludes every later fill. Do not
infer it from a page-sized image's axis-aligned bbox or a corpus category.
Unproven bounds/opacity/later visibility stay refused with the corresponding
geometry/effect diagnostic; they do not default to visible. Fully occluded
or otherwise unproven-visibility cases outside this narrow predicate also
stay refused. Never append fallback shows after the scan as a workaround.

OCR's zero-gain target is enforced by this predicate and its visibility
proof/refusal fixtures, **not** `category === 'scanned-ocr'`. Include Tr3,
alpha-zero and Tr0-under-earlier-opaque-image cases, plus opaque/transparent
and later-paint counterexamples; the 39 existing rows must stay refused
through per-target evidence or its precise unproven-visibility blocker.

Rectangle clipping algorithm:

1. Start from known page crop region; carry q/Q clip snapshots. For Forms,
   intersect with the transformed BBox at invocation entry.
2. Initial path subset is one `re` under a known axis-aligned transform,
   followed by W or W* and `n`, with checked operands and no mixed subpaths.
   Transform at path-construction time. Keep the pending path distinct from
   the effective clip. Multiple proven rectangles intersect exactly. Unknown
   paths/curves/rotated rectangles set clip unknown until a restoring Q;
   they are never reduced to an overpermissive rectangle.
3. Compute conservative old/new glyph ink envelopes from verified program
   outlines/control hulls or proven Type3 path bounds, not `coreQuad`, advance
   width, unverified FontBBox or d1's declaration alone. A Type1 parser that
   has only width proof cannot authorize a containment edit until a bounded
   hull or independent engine envelope is available and revision-bound.
4. Require containment with a fixed 0.5 pt guard at 144 dpi for supported
   fill-only targets; Tr1/Tr2 always refuse this stage. No clipping change and no clip-induced
   truncation of replacement. Insufficient bounds → precise refusal. A
   different zoom raster is an additional test, not permission to alter the
   region or guard after observing differences.

For gs values, the initial safe profile is ordinary Normal blend, unit
fill/stroke alpha, SMask None, supported device colors, resolved finite
line parameters, identity/default transfer functions, ordinary overprint
settings and no Font override. Missing entries inherit **proven** values;
unknown inheritance refuses. The current adapter's broad key allowlist
includes SMask/BM/transfer entries but does not establish this value-level
profile. Do not describe it as a full effect analyzer. Existing already-safe
gs + named-MCID tests must remain accepted. Extending fractional alpha or
blend effects requires its own bounded envelope/native unit later.

Resolve named Properties and, for tagged targets, the relevant structure
ancestry/ParentTree link sufficiently to identify semantic overrides.
No full structure-tree rewrite is planned. If the relevant association is
ambiguous, refuse; do not scan an unrelated Alt on another page and block
everything. Malformed scope nesting refuses even if the renderer tolerates
it. MCID-only operator preservation does not claim PDF/UA semantic validation.
`tokenizer.ts` currently records dictionary keys/extents rather than values;
S2 must add a bounded decoder for the needed inline property values using
those extents, and snapshot named values at the pdf-lib boundary. A list of
keys alone cannot establish MCID identity, OC state or a structure link.

### 5.3 Resolve Form invocation provenance

Reuse `collectFontCoverage`'s resource lookup, object identity and ancestor
cycle-guard pattern, extracting shared helpers rather than duplicating it.
**Do not use its resource list as a uniqueness proof.** It visits registered
resources even when they are not painted and does not count Do multiplicity.

1. Enumerate actual Do operators from the decoded page and reachable Form
   streams, retaining op byte extents and full state at each invocation.
   Resolve the resource name in that invocation's scope. Non-Form images
   remain opaque obstacles, not recursive text containers. Bound depth to
   16, visited invocation nodes to 10,000 and total decoded bytes to 32 MiB
   per page; use a per-path ancestor set. An actually traversed cycle gets
   `form-xobject-cycle`; do not globally mark a reusable acyclic form visited
   and thereby lose its second invocation.
2. For each Form, compose invocation CTM, Form /Matrix and text transforms
   in the walker's established multiplication convention; intersect the
   caller's clip with /BBox. Snapshot the **full resource chain**, from page
   through ancestor Forms to leaf, including each dictionary's presence or
   absence and every category/name/object binding. An absent /Resources
   inherits the effective ancestor environment; a present /Resources does
   **not** merge missing names with its parent's dictionary. Resolve using
   those exact rules, not a shallow Font-only overlay. If the full chain
   cannot be snapshotted, refuse `form-xobject-context`. Retain a
   plain scope identity even for direct dictionaries/streams. Missing or
   unsupported resources/matrices/Group semantics refuse
   `form-xobject-context` with a typed blocker.
   The initial rectangle-clip subset cannot replace a rotated/sheared BBox
   polygon with its axis-aligned bounding rectangle. Such a clip remains
   unknown and refuses `clip-unproven` until exact polygon containment has a
   separately tested implementation. Translation/axis-aligned scale are
   supported; a singular transform is always refused.
3. Initial support requires Do outside a caller BT and balanced independent
   BT…ET inside the Form. Require explicit, resolved font/state before the
   target show; no reliance on unknown parent text matrices, vertical fonts,
   Form font override or unplaced preceding text. Ordinary inherited color
   can be supported when explicitly seeded/proven. Form-owned ActualText,
   OC, transparency groups, StructParent(s) or unresolved structure identity
   remain refused. Allow an ordinary Form without Group only.
4. Map the page-space selection through each invertible invocation path to
   local glyphs, then compare original text, font identity and byte-address
   provenance exactly. An image Do or a remote Form elsewhere on the page
   must not explain an otherwise unmatched selection. Multiple matching
   overlaid invocations refuse `form-xobject-ambiguous`; zero matches stays
   `source-mismatch` or its proven font/state blocker.
5. Run the same fixed-neighbour compiler over the selected leaf Form with
   the seeded environment and local widths, checking all containment in
   page space. Add a distinct proven-form scope variant to RunPlan instead
   of deleting `scope === 'form'` refusal for arbitrary callers. A plain
   `scope: 'form'` without an invocation proof continues to refuse.

### 5.4 Always isolate the selected path with copy-on-write

Use copy-on-write even for apparently unique Forms in the initial version.
This avoids a fragile global reference census and preserves the “never
mutate an existing shared stream” invariant. The isolation proof is the
exact invocation path plus private resource aliases, not a BaseFont/resource
name or observed single-page occurrence count.

1. Compile the leaf content and any replacement fallback subsets in scratch.
   Clone only the selected leaf stream dictionary/content. If /Resources
   existed, clone that complete effective dictionary and only changed
   subdictionaries. If /Resources was **absent**, first materialize the full
   effective inherited environment from the snapshotted page/ancestor-Form
   chain, preserving its actual lookup rules and all categories/names; only
   then add the font or XObject alias. A Font-only or XObject-only dictionary
   would shadow the inherited environment and is forbidden. Fonts/unchanged
   CharProcs remain references to immutable originals; missing glyphs add
   a new subset resource in the leaf's private Font dictionary.
   Rebuild Length/Filter/DecodeParms consistently for newly encoded stream
   bytes through pdf-lib; do not copy an old compressed stream dictionary
   over newly decoded content. Preserve the Form's nonencoding semantics.
   The scratch clone plan keeps source object IDs as immutable references
   to be reattached in the target export context. Do not deep-copy the
   entire old resource closure through PDFObjectCopier: that could duplicate
   shared source fonts/images. Copy only newly prepared objects; unchanged
   source resources retain their existing target-context references.
2. For each parent invocation, allocate a fresh XObject name in a private
   clone of the parent resources, point it at the cloned child, and replace
   **only that Do operator's resource name** at the original byte extent.
   If `/Fm Do` occurs twice, rebinding `/Fm` in the shared resource dictionary
   would edit both; alias `/ShioriFormN` and patch one selected invocation.
   Reuse `pdfName` escaping rules and check collisions against the **entire
   snapshotted chain**, not just a local/new subdictionary. Apply the same
   inheritance materialization to each cloned ancestor whose Resources was
   absent. Never fill a missing name from a farther ancestor when the
   original present dictionary would have masked that ancestor.
3. If a parent Form is itself shared/repeated, clone it and continue this
   process up to a new page content stream and private page resources.
   Never replace the original Form reference globally. Keep each Form
   Matrix/BBox and every unrelated operator unchanged; page edits are the
   selected Do aliases, not re-emitted drawing commands.
4. Revalidate page revision, every parent/leaf stream hash, resource lookup,
   Form dictionaries, Font/Properties/ExtGState/semantic dependencies and
   invocation seeded state immediately before installation. Existing
   `runResourceStamp` must expand to these dependencies; object identity of
   /Resources is insufficient. On stale or failed sibling, no installation.
5. Install the fully built graph and page root together synchronously after
   validation. Prefer a disposable document/object graph until success, as
   fallbackPage already does; a refusal must not leave objects/references
   allocated into the source document. Stage all changes before swapping
   Contents/Resources so observers never see a half-installed pair.
   An unexpected exception during final object materialization aborts that
   disposable export revision; it must not return a partially edited result
   or masquerade as an ordinary counted refusal.

Required invariant for **every** cloned leaf/ancestor: lookup of every
resource name used by an operator that was **not rewritten** returns the
**same original object** as before the edit, across Font, XObject, ExtGState,
ColorSpace, Pattern, Shading and Properties (and any other used resource
category). Compare stable source object identities and revision hashes,
not just equal names or matching rendered pages elsewhere. Validate this
lookup equivalence before install; an unresolved/incomplete inherited chain
is `form-xobject-context`, never permission to install partial Resources.

Mandatory fixture: a Form with **no /Resources**, an inherited font used by
both edited and unedited shows, and an inherited image Do, painted twice.
After COW/fallback, the unedited show and image in the edited invocation
must resolve to the original objects and match the other invocation in
native text/origins/raster. This checks the edited clone as well as its
untouched sibling; cross-page isolation alone would miss lost inheritance.

Sharing across pages or repeated paintings is supported **only** when this
entire path can be isolated and its semantics are supported. If aliasing,
resource inheritance, structure identity, cycles or budgets prevent proof,
refuse `form-xobject-shared` (or the more specific cycle/context code).
No optimistic “used once in the resource walker, mutate it” branch. Edits
to two leaves sharing a parent are merged against one original graph;
conflicting invocation/leaf ownership refuses. Form plans sharing geometry
with a hybrid sibling retain the same conservative downgrade rule as page
plans; no partial private graph can leak to save/export.

### 5.5 Invariants, tests, risks and acceptance targets

State edits keep original state/clip/marked-content bytes. All source and
replacement ink must remain contained; clipping text never edits. Refused
ActualText/Alt/E stays refused, MCID identity/reading order is retained.
Form edits change one invocation only: other instances on the same page,
every other page and every original Form/font program remain identical in
appearance, glyph origins and semantic references. Font/reflow safety is
not weakened by entering a Form; reflow there is out of initial scope.

| Tier | Required failures / evidence |
|---|---|
| State units | re W n/W* containment, nested clips, Q restoration, path-construction CTM, unknown clip, ink-overhang crossing clip; Tr1/Tr2 always graphics-effect-unsupported, Tr3/alpha0/image-hidden predicate; malformed state and Tr≥4. |
| Semantics/gs units | Existing ordinary gs + MCID success, named/direct Properties, q/Q independent BDC/EMC, Font-changing/unresolved gs, mutable indirect BM/SMask/Properties during await, ActualText/Alt/E in local and relevant structure ancestors, unknown OC, no leaked fallback preparation on structural refusal. |
| Form units | No-Resources Form inherits font + image: edited clone's unedited show/image must equal the other invocation and resolve to the exact same source objects. Full-chain alias collisions; present dictionaries never merge parent holes. Direct/indirect scopes, nested matrices/BBox, repeated/shared parents/pages, cycle/budget, unrelated image Do, ambiguity, stale hashes and rollback. |
| Native PDFium | Rectangular-clip safe edit and clipped-overhang refusal, MCID-only extraction retained, hidden OCR remains hidden/refused; saved single and nested Form edits with fallback, exact raster/glyph identity for other same-page instances and **all pages referencing the cloned path**. Native no-.notdef/text/ink and qpdf clean. |
| Corpus | Reclassify all 111 state + 14 Form rows before recovery claims. Revised state-only credit +9/+28/+50 edits, overall 21.4%/22.8%/24.5%; gains only japanese/chinese. Form credit is 0/0/0 pending actual X1 text-Do hits. Category breakdown/assumptions in §7. |

Unit tests start from failing examples of the current dependent flag/Form
refusal. Native artifacts must include both shared-page originals and edited
outputs, with independent expected invocation identities/transforms. Check
all related pages rather than merely the edited page's outside-box mask.

Risks: clip-path construction timing; overstating glyph bounds; missing
semantic overrides; inherited resource ambiguity; repeated invocations that
look unique in a resource graph; reference leaks during cloning; duplicate
large assets. Keep shared font/image references immutable, clone only the
selected spine, impose growth limits and record object counts/bytes in the
report. A deliberate small size increase is acceptable; multiplying a font
program per page is not (see `docs/POSTMORTEMS.md`, 2026-06-10 copyPages case).

### 5.6 One-afternoon implementation units

| Unit | Depends on | Bounded deliverable and its own tests |
|---|---|---|
| S1 | O0, R1 | Dependency ledger with precise state refusals; no new eligibility. Existing gs/MCID behavior and hidden-text/clip diagnostic tests. |
| S2 | S1 | Value-level gs/property/structure-ancestor snapshots and expanded async stamps. Named/direct/indirect mutation tests; semantic cases stay refused. |
| S3 | S1 | Rectangle-only clip interpreter with q/Q/pending-path rules. Independent path-timing/intersection fixtures; unknown clip refuses. |
| S4 | S2, S3, R2, O1 | Containment eligibility for fill-only glyphs with verified bounds. Native contained-versus-overhang fixtures; no stroke/transparency broadening. |
| X1 | O0, R1 | Actual invocation discovery with resource scope, ancestor guard and seeded transforms. No editing; image/unmatched/multiple-use/cycle fixtures. |
| X2 | X1, S2, S3 | Pure leaf Form fixed-plan compilation with invocation proof. Font/Matrix/BBox/semantic refusal tests and single-Form native fixture. |
| X3 | X2 | Single-level COW resource alias + selected Do splice in scratch. Native twice-painted Form and cross-page isolation fixtures. |
| X4 | X3 | Nested COW spine + shared-parent merge and expanded stale dependency check. Native repeated ancestor and two-edit rollback fixtures. |
| X5 | X4, F6/F9 as applicable | Existing fallback subsets in private leaf resources. Permission/stale/refusal tests; native mixed source/fallback shared-Form fixture. No reflow in Forms. |

X4 stops at the first unsupported inherited-resource/nesting idiom with a
precise refusal and its red fixture. Extra idioms are a separate unit;
copy-on-write is not complete until the unchanged-operator lookup invariant
passes on the edited invocation as well as its other uses.

## 6. Common implementation and release gates

### 6.1 Order, adapters and afternoon-sized shared work

Do O0 and a diagnostic inventory first. The parser and trace units can then
progress independently in later work; this specification does not initiate
parallel agents or change the current task's scope. Enable a capability only
after O1's native oracle can distinguish its failure modes.

| Unit | Depends on | Deliverable / tests / artifact |
|---|---|---|
| O0 | none | Shared typed catalog, recoverability predicate and precise planner/parser-family dispatch. Frozen-row inventory must measure how many of the 208 overflows actually fit spacing-only under every cap/clearance, per category, with row IDs and unsupported measurements. Keep that count out of §7 until published. No intentional acceptance change. |
| O1a | O0 | Name/proc-aware native evidence for Type1/Type3, Standard-14 and uniform CID metrics, including no-program Type3. Compare each fixture cluster's native path to a hand-specified outline; A-labelled /B must fail despite a positive coverage GID/non-.notdef path. Identity, cipher, compensation and missing-glyph fixtures; artifacts under `test-artifacts/pdf-stage5/fonts/`. |
| O1b | R1 | Independent moved/unmoved-glyph oracle with destination manifest and unchanged external glyphs/spaces. Inject wrong destinations, Tlm drift and outside-mask pixel changes; artifacts under `test-artifacts/pdf-stage5/reflow/`. |
| O1c | X1 | Related-page/invocation isolation oracle. Inject accidentally rebound shared resource and unselected Do changes; artifacts under `test-artifacts/pdf-stage5/forms/`. |
| O2 | each enabled capability + O1a/b/c as applicable | Production export-path corpus run using pinned cases, modes, old/new reasons and blockers; acceptance/regression comparison, timings and native audit. Saved run instructions/JSON plus outputs under `test-artifacts/pdf-stage5/corpus/`. |
| W1 | approved core units | Later adapter/preview/export consumption of the explicit layout/Form plan and localized typed reasons. No implementation in this task. Browser selection→edit→preview→export→reopen→undo/redo/refusal E2E; exact commands, screenshot and machine state beside artifacts. |

Tables elsewhere abbreviate O1a/b/c as **O1**. O2 is one afternoon **per
enabled capability checkpoint**; do not defer all native/corpus failures
to a single end-of-project afternoon. F1 initially extracts plain snapshots;
F6/F7/F9/F14 deliberately enable specific eligibility, avoiding a broad “all
font types now supported” switch. R1/R2/R6 and X1 are read-only groundwork.

The future compiler integration must be a discriminated layout plan at
`replaceRuns`/`pageRunPlan`, with a separate bounded-layout emission path.
The existing fixed `compileSpanItem` keeps its slot clamp and compensation.
Do not pass `allowOverflow:true`, inflated editBox/availablePt or manually
edited compiled strings to simulate reflow. A caller-supplied explicit hard
space cap still constrains layout; only the new explicit region policy
authorizes neighbour ownership and a larger region. Full reflow plans are
fingerprinted and validated just as fixed plans are. Unsupported rotations,
mixed code widths and unproven boxes never fall through to a permissive path.

`src/editor/components/contentTextPreview.ts` **already** implements
`buildContentTextPreview` by calling `rebuildPdf`, which reaches
`applyContentTextEdits`; preview and export already share the writer. W1
extends that existing route to consume the new policy/proofs. It does not
introduce a second preview compiler or a new rendering/export architecture.
F7 and F14 are explicitly default-off in `planContentText` until their O1a
identity/metrics/compensation scenarios pass; unit-only width results cannot
enable an accepted edit through either route.

Each unit starts with its written failure list and a failing reproduction
where behavior is currently refused/broken, then code and focused tests.
Pure-parser rejection tests should assert the uneditable input/correct
mapping or unchanged output, not source-code regexes or private call order.
Keep production files below repository size policy; modules above are
bounded seams, not suggestions to put everything into `replaceRun.ts`.

### 6.2 Native E2E and corpus protocol

Implementation must add a deterministic Stage-5 harness, for example
`scripts/pdf-inplace/stage5.ts`, that goes through the same pdf-lib export
assembler and pure compiler as production. The commands below for that new
script are **proposed**, not commands available or run in this spec-only task.

```sh
# Existing commands, after the corresponding implementation changes:
bun test src/pdf/export/fontCoverage
bun test --preload ./src/test/setupDom.ts src/pdf/export scripts/pdf-corpus
bun scripts/font-coverage/report.ts
bun scripts/pdf-inplace/surgical-first.ts
bun scripts/pdf-corpus/run.ts
bun run verify

# Proposed harness; implement these switches in O1/O2, then record exact use:
bun scripts/pdf-inplace/stage5.ts --scenario fonts
bun scripts/pdf-inplace/stage5.ts --scenario reflow
bun scripts/pdf-inplace/stage5.ts --scenario forms
```

Use the environment's Bun path when needed; source the Cargo environment if
a command invokes Rust. Do not run CPU-heavy native/build work alongside
the full timing-sensitive test suite. No Rust/Tauri code change is proposed;
`test:core`/desktop builds become additional gates only if scope later touches
those trees. Never launch/relaunch the desktop app without the requested run.

Required protocol:

1. Copy the pinned baseline manifest/rows/hash into an ignored Stage-5
   artifact directory before rerunning tools that overwrite report.json.
   Preserve the original 1,328 row keys and input PDF hashes. Re-running a
   changed sampler is a separate report; it cannot establish gain against
   this denominator. `scripts/pdf-corpus/README.md` documents at-most-five-page
   sampling, native geometry shortcuts and license evidence; preserve those
   caveats rather than presenting this as a random sample of all PDFs.
2. Add a deterministic policy-mode option to the corpus harness. Compare
   fixed/default and each enabled bounded mode on the same cases, never
   enable raw `allowOverflow`. Record original primary reason, new primary
   reason/family/blockers, source type, code/metric provenance, region or
   invocation ownership and actual fallback font loads.
   Keep the **71 baseline eightfold expansions** (original reason overflow,
   kind overflow) refused in every Stage-5 corpus gate. Use their pinned row
   keys, not a claim that every edit with that kind was refused in the old
   report. Suffix movement is a fixture-box target; no guessed corpus box
   or unmeasured spacing-only count contributes acceptance credit.
3. Native PDFium reopens **saved bytes** independently. Check intended text
   and spaces, all surviving original glyphs, correct replacement glyphs,
   predicted moved origins, unchanged font/proc identity and state rejoins.
   Keep .notdef probes independent of the font resolver, and never derive
   expected text/destinations by re-running production `lineChanges`, the
   encoder or layout solver. Hand-specified small fixture expectations and
   source-native identities anchor the oracle; the manifest is a claim to
   verify, not self-validating evidence.
   O1a must additionally compare the native path for each fixture cluster
   against a hand-specified expected outline. Positive coverage GID and
   non-.notdef/ink checks alone do not prove character identity. Check
   ToUnicode/name disagreement before preparing any fallback.
4. The old oracle's unchanged-line-count/prefix-suffix model must remain
   available for fixed edits. Add explicit reflow mode: reconstruct expected
   logical/source sequence without assuming contiguous glyph indices or
   unchanged physical lines. Account for real native spaces, multi-scalar
   glyph clusters and unrelated interleaved objects; unsupported cluster
   evidence fails the audit instead of silently filtering glyphs out.
   Preserve the existing regression that absent Type3 program data never
   enters an empty native FFI buffer.
5. Assert ≤0.005 pt target drift for untouched and predicted moved origins;
   **reject >0.01 pt**. Report any 0.005–0.01 result separately and investigate
   before broad enablement. At 144 dpi assert exactly 0 outside-mask pixels;
   add 100%/200% fixtures for clipping/rounding without relaxing that gate.
   Masks are source-proven edit/line/paragraph regions fixed before export.
   For Forms, also compare all other invocations/related pages unchanged.
6. Check independent text extraction against the intended string with only
   explicitly documented soft-break/CRLF normalization, positive expected
   non-.notdef shape/ink (spaces exempt from ink), and `qpdf --check` clean.
   A crash, lost unrelated text, changed other Form instance, overlap or
   failed oracle is P0: fix/refuse before acceptance is counted. Do not
   convert programming exceptions into refused rows.
7. Audit every **newly accepted** baseline row with native geometry/text;
   retain full before/after/probe/raster evidence for all distinct new
   font/state/Form/reflow configurations and every suspicious row. If full
   raster auditing is sampled for runtime/storage, report its exact coverage
   separately; broad enablement requires all new accepted baseline rows'
   outside-region raster checks at least once. The existing 16-sample cap
   alone is insufficient for enabling Stage 5. Keep large binaries ignored.
8. Measure planning, parse-cache misses, font preparation, compilation,
   full save and native audit separately; report median/p95 and mean export
   versus the **73.7 ms/edit** baseline on the same machine/input rows.
   No invented speed guarantee. Parser budgets bound hostile work; reflow's
   eight-line/4,096-cluster limits and Form COW byte/object counts prevent
   unbounded layout or whole-document duplication.

These pure interfaces are shared by web worker/wasm, desktop native and CLI
export. Any later adapter/UI wiring must verify the same plans and saved
outputs on each route; no native-only parser/proof dependency can quietly
disable web/mobile. Core byte parsing and clone semantics require no Tauri
command/plugin change. W1 adds browser PDFium preview/export E2E and desktop
harness evidence without broad platform refactoring.

## 7. Expected acceptance gains and falsifiable targets

These are **revised scenario credits**, not measured acceptance, empirical
upper bounds, guaranteed minimums or probabilities. P/L/O means pessimistic /
likely / optimistic conditional on all relevant units and native gates.
Actual recovery can be zero. Compute absolute percentage-point (pp) gains
from exact counts over **1,328**, then round to one decimal.

The revision removes unmeasured spacing/wrap credit, caps tagged optimism,
and assigns no Form gains until actual invocation hits are counted. The
first draft's larger combined forecast is withdrawn. Fonts/state still have
conditional planning assumptions below; an external font-pack inventory is no evidence
for their Shiori category distribution. Unknown parser/outline/visibility
eligibility never becomes an accepted row to satisfy a forecast.

Assign every recovered case to its **original first-refusal bucket** so the
pillars are disjoint. Supporting cross-pillar prerequisites must also pass;
there is no extra synergy credit. The tables assume no additional loss among
the 275 baseline successes. The tighter identity/render-mode checks may
expose such losses: O2 must report and subtract them, giving gross recovery
and net acceptance separately. These tables are not a completed rerun.

### 7.1 Pillar 1: source-font resolution

Inventory ceiling: 36 raw-Type1 coverage rows + 623 coarse font-unavailable
rows, not an estimate of recoverable cases. Every credited code must pass
ToUnicode/glyph-name agreement, character-space width checks and O1a's
independent outline gate; the original slot/state must still be safe.

| Category | Added acceptance credit P / L / O | Gain pp P / L / O | Resulting category acceptance P / L / O |
|---|---:|---:|---|
| chinese | 2 / 8 / 18 | 0.6 / 2.5 / 5.7 | 47.1% / 49.0% / 52.2% |
| latex | 20 / 30 / 37 | 7.3 / 10.9 / 13.5 | 34.2% / 37.8% / 40.4% |
| japanese | 0 / 3 / 8 | 0.0 / 1.8 / 4.8 | 26.1% / 27.9% / 30.9% |
| word | 1 / 6 / 12 | 3.0 / 18.2 / 36.4 | 15.2% / 30.3% / 48.5% |
| desktop-publishing | 1 / 5 / 10 | 2.9 / 14.3 / 28.6 | 14.3% / 25.7% / 40.0% |
| tagged | 0 / 12 / 12 | 0.0 / 2.6 / 2.6 | 0.9% / 3.4% / 3.4% |
| scanned-ocr | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 0.0% / 0.0% / 0.0% |
| **overall** | **24 / 64 / 97** | **1.8 / 4.8 / 7.3** | **22.5% / 25.5% / 28.0%** |

Assumptions:

- P/L/O target 20/30/36 of the **36 raw-Type1 shorter** LaTeX rows. They
  already reached coverage rather than the planner's missing-decode branch,
  but their name/label agreement, non-MM program structure and charstrings
  still need the new proof. OtherSubrs, metric or identity conflicts reduce
  these counts; a conflict cannot be routed through fallback. Optimistic
  LaTeX additionally targets its one coarse font-unavailable row.
- Credit from the **623** is only **4/34/61**. Chinese 2/8/18 of 51 and
  Japanese 0/3/8 of 25 remain hypotheses for *labelled, name-verifiable*
  mapping/metric cases. Missing labels, nameless CID mappings or unsafe
  Type3 programs do not gain synthetic names or a ToUnicode-only accept.
- Word 1/6/12 of 26 and desktop-publishing 1/5/10 of 28 assume some compatible
  metrics/legacy cases actually retain the required labels and verified
  names. F7 cannot rescue a no-ToUnicode font by AFM presence alone; F14
  cannot bypass glyph identity. Both remain default-off until O1a passes.
  If O0/F1 finds no such eligible subtypes, lower these hypotheses to zero.
- Tagged is **0/12/12** of its **453** coarse refusals: optimistic is capped
  at likely until O0/F1 publishes actual subtype/label/name counts. Category
  acceptance stays **0.9% / 3.4% / 3.4%**. This is a planning cap, not evidence
  twelve eligible cases already exist. No predefined CMap pack is added.
- OCR is **0/0/0**. Enforce §5.2's Tr3/alpha-zero/image-coverage predicate
  and precise refusals for unproven visibility per row, never a category
  blacklist. No fallback can turn a hidden source layer into visible text.

### 7.2 Pillar 2: spacing-only first; corpus credit withheld

Inventory: 208 overflow + 7 reflow-required. Near-term tests target
spacing-only inside the original slot and suffix shift on an **explicit
fixture RegionProof**, together with R6 flush/first-line/hanging proofs and
L1 consumption of those per-line slots. The commissioned indented-paragraph
unit in §4.5 now proves the three-line 24 pt Chinese fixture while preserving
the narrower first slot; this is not a proven corpus region inventory. The
existing seven Chinese line-count mismatches earn no speculative wrap credit.

The saved JSON records original/replacement strings and refusal detail,
**not the encoded advances, per-gap budgets, available slot or ink clearance**.
Thus the number of non-eightfold rows fitting the 2% cap without wrapping is
**unknown**, including Chinese and LaTeX. O0 must publish that count; it is
kept out of the table until then. Zeros below mean **no quantified credit
yet**, not a finding that no row can fit. No surrogate count is inferred
from “longer adds i”, replacement scalar counts or an apparent empty margin.

| Category | Added acceptance credit P / L / O | Gain pp P / L / O | Resulting category acceptance P / L / O |
|---|---:|---:|---|
| chinese | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 46.5% / 46.5% / 46.5% |
| latex | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 26.9% / 26.9% / 26.9% |
| japanese | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 26.1% / 26.1% / 26.1% |
| word | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 12.1% / 12.1% / 12.1% |
| desktop-publishing | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 11.4% / 11.4% / 11.4% |
| tagged | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 0.9% / 0.9% / 0.9% |
| scanned-ocr | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 0.0% / 0.0% / 0.0% |
| **overall** | **0 / 0 / 0** | **0.0 / 0.0 / 0.0** | **20.7% / 20.7% / 20.7%** |

Revised targets and assumptions:

- Chinese has **41 non-eightfold overflow rows** (66 minus 25 deliberate
  expansions); LaTeX has **84** (120 minus 36). These are candidate inventory
  counts only. O0 must measure which, if any, fit spacing-only under the
  unchanged slot, 2% total shrink, per-gap/word-space caps and ink clearance.
  Their likely credited gains are zero pending that measurement, replacing
  the first draft's unsupported 25/55 Chinese/LaTeX gains. No wrap or inferred
  paragraph box contributes to the new likely case.
- Across categories there are **137 non-eightfold overflow rows** and
  **71 known eightfold expansions**. Keep those 71 pinned rows refused in
  the corpus gate in every scenario. Do not claim that every old kind-overflow
  row was refused; use the original-reason + row-key cohort.
- The other non-eightfold inventories are Japanese 7, Word 2, desktop-publishing 2,
  tagged 1 and OCR 0. They likewise earn no count until measured. An
  explicit fixture box proves suffix-shift behavior, not that real corpus
  selections already have such authorized boxes.
- Once O0 is published, replace withheld credit only with identified rows
  that fit without wrap and pass native checks. R6 indent fixture success
  alone is no measured wrap gain: corpus recovery needs its own inventory
  and native gate, never permission to weaken §4.5 or accept deliberate
  eightfold expansions.

### 7.3 Pillar 3: fill-state subset; Form credit pending X1

Inventory: 111 state rows (Japanese 71, Chinese 40) + 14 loosely classified
Form rows (LaTeX). Tr1/Tr2, text clipping, hidden/unproven visibility,
semantic overrides and unknown effects remain refused. Existing MCID-only
and resolved ordinary gs support earns no new credit.

| Category | Added acceptance credit P / L / O | Gain pp P / L / O | Resulting category acceptance P / L / O |
|---|---:|---:|---|
| chinese | 3 / 10 / 18 | 1.0 / 3.2 / 5.7 | 47.5% / 49.7% / 52.2% |
| latex | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 26.9% / 26.9% / 26.9% |
| japanese | 6 / 18 / 32 | 3.6 / 10.9 / 19.4 | 29.7% / 37.0% / 45.5% |
| word | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 12.1% / 12.1% / 12.1% |
| desktop-publishing | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 11.4% / 11.4% / 11.4% |
| tagged | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 0.9% / 0.9% / 0.9% |
| scanned-ocr | 0 / 0 / 0 | 0.0 / 0.0 / 0.0 | 0.0% / 0.0% / 0.0% |
| **overall** | **9 / 28 / 50** | **0.7 / 2.1 / 3.8** | **21.4% / 22.8% / 24.5%** |

Assumptions:

- State-only P/L/O is **9/28/50** of 111, all conditional on ordinary **fill**
  targets whose actual ink is contained in a proven unchanged rectangle.
  Chinese 3/10/18 and Japanese 6/18/32 do not include stroke, arbitrary cm
  CharProcs, semantic text, uncertain visibility or unsupported effects.
  S1/O0 must establish whether enough such targets exist; if not, reduce
  the scenario rather than relaxing bounds. This is not a measured clip split.
- **Forms are 0/0/0**, including pessimistic, until X1 reports how many of
  the 14 selections hit real text-bearing Do invocation paths. Today's
  classifier only establishes “no placed glyphs and some Do”; even an image
  elsewhere can trigger it. It proves neither a matching Form nor a safe
  fixed-slot leaf edit. X1 must publish row IDs, actual path hits, false or
  ambiguous classifications and all font/state/overflow/resource blockers.
- Nested COW/resource-isolation fixtures remain implementation goals with
  no corpus credit. After X1, revise Form credit only for actual eligible
  selections satisfying unchanged-operator resource lookup equivalence,
  complete inherited-chain snapshots and the native isolation gate.

### 7.4 Combined revised credit and stopping criteria

| Category | Added acceptance credit P / L / O | Total accepted P / L / O | Acceptance P / L / O |
|---|---:|---:|---|
| chinese | 5 / 18 / 36 | 151 / 164 / 182 | 48.1% / 52.2% / 58.0% |
| latex | 20 / 30 / 37 | 94 / 104 / 111 | 34.2% / 37.8% / 40.4% |
| japanese | 6 / 21 / 40 | 49 / 64 / 83 | 29.7% / 38.8% / 50.3% |
| word | 1 / 6 / 12 | 5 / 10 / 16 | 15.2% / 30.3% / 48.5% |
| desktop-publishing | 1 / 5 / 10 | 5 / 9 / 14 | 14.3% / 25.7% / 40.0% |
| tagged | 0 / 12 / 12 | 4 / 16 / 16 | 0.9% / 3.4% / 3.4% |
| scanned-ocr | 0 / 0 / 0 | 0 / 0 / 0 | 0.0% / 0.0% / 0.0% |
| **overall** | **33 / 92 / 147** | **308 / 367 / 422** | **23.2% / 27.6% / 31.8%** |

Exact arithmetic:

- Baseline: `(132 + 143) / 1328 = 275 / 1328 = 20.7%` rounded.
- P: `275 + 24 + 0 + 9 = 308`; **+2.5 pp**, **23.2%**, 1,020 still refused.
- L: `275 + 64 + 0 + 28 = 367`; **+6.9 pp**, **27.6%**, 961 still refused.
- O: `275 + 97 + 0 + 50 = 422`; **+11.1 pp**, **31.8%**, 906 still refused.

The combined additions are **33/92/147**, excluding every unmeasured spacing
fit, paragraph wrap and unclassified Form. Tagged optimistic is no greater
than likely; OCR has no new acceptance by its per-target visibility test.
These remain conditional gross gains, with any new baseline refusal deducted
from the final measured net result. No silent corruption is permissible at
any rate.

Disjoint first buckets avoid double counting, not dependency failures: a
parsed font can reveal overflow, safe state can reveal a glyph-identity
conflict, and a matched Form can reveal missing inherited resources. Count
distinct row IDs only after all blockers and native gates clear. Keep the
39 style-change, 11 cross-item and 4 source-mismatch rows out of forecast
credit; explain any incidental movement separately.

A capability is ready only when negative fixtures refuse with precise codes,
new native/E2E checks pass, relevant repository gates pass and the corpus
comparison exposes every regression. A missed target means reporting which
assumption failed. Do not widen boxes, skip interleaved operators, ignore
GID0, accept wrong outlines or drop inherited names to improve a percentage.

## 8. Product policy and architecture notes

The 2026-11-15 product-policy addendum and future matching-font acquisition
design are in [SPEC-stage5-font-download.md](SPEC-stage5-font-download.md).
Jesse approved typographic substitution and full reflow with proved
downward growth; Tr 1/2 stays refused. Download matching font is design-only:
current substitution uses bundled/metric-compatible fonts. This addendum
does not change the Type1 parser invariants, F14 defaults or measured baseline.

The open cross-platform layout engine is selected in §4.9. These notes
record Shiori's own architecture and proof requirements. They are not a
claim about any third-party editor's save behavior.

Shiori keeps parser, mapping, layout, stream writer and renderer as
distinct contracts, with its **own** PDFium renderer, TypeScript compiler
and pdf-lib writer, and validates serialized bytes, as in §6. Nothing
authorizes importing another engine or non-MIT code.

Independent requirements that stay in force:

- §2 keeps glyph identity, Unicode, width and resource identity as
  separate records. F2–F6 prove real Type1 programs rather than treating
  ToUnicode as coverage. The no-source-mutation rule is independent of
  any third-party writer.
- Keep verified source glyphs and use the existing permitted fallback
  path for missing clusters, preserving size and recording the chosen
  resources. Existing fallback permission and shaping guards remain
  required. Do not assume an OS-selected font is exportable.
- Legacy mapping is its own substantial capability. F11–F14 improve only
  proven local mappings; unknown predefined or inherited CMaps remain
  precise refusals. Do not import third-party CMap packs or treat an
  external inventory as evidence for Shiori's tagged/Word category
  distribution.
- R1/R6 retain source line provenance and explicit box geometry; R3 has
  numeric spacing budgets; R7/R8 wrap only within known capacity.
  Fit-in-frame shrink is a separate, documented bounded-frame policy;
  ordinary column text does not shrink. No external heuristic constants
  enter the forecast.
- Add a negative fixture for visually deduplicated text with multiple
  source origins. Retain every contributing address; until all intended
  duplicates can be proved or handled atomically inside the approved
  scope, refuse `ambiguous-match`. Deduplication is not no-overlap proof.
  Stage 5 does not add a duplicate-removal feature or erase independent
  overlapping objects; no forecast credit is assigned.
- X1 records invocation paths; X3/X4 clone the selected spine and patch
  one Do alias. Provenance and scoped resources remain mandatory, as do
  copy-on-write isolation tests. Annotation-appearance editing stays out
  of scope.
- W1 must expose precise localizable outcomes and the actual bounded
  layout/fallback plan when wired later. No UI is changed in this task.

These notes change **unit priority and evidence requirements**, not the
measured Shiori baseline, acceptance arithmetic or refusal-first safety
bar.

## 9. Remaining questions and first next steps

Layout-engine choice and the L1/L2 adapter units are specified in §4.9/§4.8;
the research spike adds no O0 acceptance credit and does not enable reflow.

These do not block implementation of the read-only/schema units:

1. O0/F1/S1 inventory: which exact metric/Unicode/font/state blockers explain
   the 623 coarse font-unavailable and 111 dependent-state rows? In
   particular, how many of the 453 tagged targets have a visible safely
   reusable Type3/legacy font versus opaque/hidden/unplaced text? Until
   answered, the gain tables remain hypotheses.
2. O0/R1 inventory: how many of 208 overflow rows demonstrably fit spacing-only
   inside the original slot under every cap and clearance, particularly
   Chinese's 41 and LaTeX's 84 non-eightfold candidates? This count is unknown
   and withheld from §7. R6 now models indented-paragraph slots, but the seven
   Chinese line-count mismatches still earn no unmeasured wrap credit.
3. X1 inventory: do the 14 loose Form classifications identify actual selected
   text-bearing Do paths or unrelated page XObjects? How many have
   structural/group/resource-chain blockers? All Form gain credit remains
   zero until this report exists; inherited-name lookup equivalence is a
   separate prerequisite after an actual invocation match.
4. O1a: can the native harness expose independent useful Type3 path/proc
   evidence for every accepted CharProc subset? If not, keep those edits
   disabled while retaining diagnostics/parser work. Do not assign GID0
   semantics to a font with no numeric program GIDs.
5. Optional breadth units F5/F10/F12 can be prioritized using observed PS
   idioms, d0 use and cmap formats; their absence means precise refusals,
   not blocked completion of the safe subset. Fonts with unsupported
   shaping/bidi and full Type3 resources stay deferred.
6. Product enablement of explicit bounded reflow and its edit region is W1
   follow-up work; no UI control, localized copy or export wiring is changed
   in this specification task. Fixed-neighbour remains default until that
   work has the same preview/export evidence.
7. The architecture notes in §8 stand. Open runtime and save-policy questions
   do not block this specification or
   justify weakening the compiler's proof/native quality bar.

Start with O0 + F1 + S1/R1's read-only traces, preserve the pinned baseline,
then implement native oracle extensions and the smallest raw-Type1 shorter
edit/AFM cases. The next high-value decision is the measured blocker matrix,
not a speculative wholesale editor rewrite.
