# Corpus r22 results (visual quality, leftover unwritable, exact-tier witnesses)

`feat/pdf-stage5` (this RESULTS commit). Production comes
from five parallel milestones (quality, fonts, match, exact, oracle)
merged after a read-only review, plus two integration commits (official
oracle push mask; hyphen-fold insertion homes). Cache reused; r14–r21
snapshots left intact. Ran `run-corpus-r22.sh` (683.7 s wall, 41 files,
1700 rows). No push. No reset cards.

Survey techniques from `/workspace/research/pdf-edit-survey/SURVEY.md`
were used as notes only. No GPL/AGPL code or survey-tree fonts were
copied. Official Noto KR / Math / Symbols 2 came from notofonts (SIL OFL).

## What landed

### Visual quality (1a / 1b)

- Unchanged later lines keep their original show, start x, baseline and
  string. `gsa-1-0-same-length` no longer prefixes `" REPORT: EXECUTIVE"`
  with a join space. Residual start-x / baseline drift after subtracting
  any push Δ is 0 on that row.
- Overflow can **push** following same-column text and graphics down by
  one Δ, or fall back with an explicit `push-blocked-by-*` reason
  (no shrink, no white cover). `zh-d2l-pytorch-0-longer` pushes
  “Release 2.0.0” by **29.74452 pt**, x unchanged, ink bands disjoint,
  `overflowInkOverlap=false`.
- Form edits still refuse a push in-form (`push-blocked-by-form-context`
  on the saved `arxiv-2611.17052-22` pair).

### Fonts (1c + coverage + vertical check)

- Retypeset substitutes now read Flags / FontWeight / name hints.
  Latin can pick Liberation Regular/Bold/Italic/BoldItalic and
  Serif/Sans/Mono. CJK remains Regular Sans only (no fake bold).
- Official coverage chain: Noto Sans KR Regular (4.4M), Noto Sans Math
  (991K), Noto Sans Symbols 2 (672K), plus the existing SC/JP faces.
  `调` falls through JP → SC; `ℎ` uses Math; `〈`/`〈` (NFC to U+3008)
  is covered by SC. Hangul uses KR, not tofu.
- Vertical writing (Identity-V, WMode 1, vertical CMaps, Type1 WMode 1)
  is **detected and refused** as `unsupported-vertical-writing`. No
  sideways layout, no CID-as-Unicode, no `vrt2` stacked on WMode 1.
  Identity-V emission / `vert` / DW2 is not implemented.

### Leftover unwritable (matcher + verifier)

- Write-verifier compares destinations with a **1e-4 pt** tolerance
  (font and codes stay exact). Tight TJ corrections reach planned
  destinations across mixed text-matrix scales. All 22 rounding
  refusals cleared in replay and in this corpus.
- Reversible compact map (matching only): whitespace, U+00AD, PDFium
  U+0002, and line-end hyphenation. Unmapped Unicode is a wildcard
  scalar, never a CID label. No global NFKC on written text. Five
  U+0002 LaTeX paragraph-match rows now retypeset.
- `arxiv-2611.17332` p.8 (`1e-2` / `7e-3`) remains unwritable:
  form glyph order is reversed vs the UI’s top-to-bottom address.

### Exact-tier grow-down witnesses (survey idea 8)

- Growth leading now needs an explicit TL / T* / `'` / `"` or **two
  agreeing** same-column same-font baseline gaps. A single
  title-to-body gap is not a pitch. One-line measure can borrow two
  nearby same-font edges. The 0-px-outside-mask oracle is unchanged.
- Result: exact-tier did **not** rise. Headline 655/1514 (43.3%) vs
  r21 658/1514 (43.5%); old-def 644/1328 (48.5%) vs 645/1328 (48.6%).
  Three previous exact overflows were lost (stricter single-gap rule);
  there were no measured exact-tier gains.

### Oracle, quality metric, form sample

- Form-walk compare-before ignores inherited invalid Form BBox/Matrix
  across remapped object ids. `gsa-17-0-same-length` now **passes**.
- Report.json keeps the r20/r21 contract and adds `quality` (unchanged
  line residual drift after push Δ; overflow ink overlap).
- Sample saver also keeps the first `arxiv-2611.17052` page-22
  retypeset pair.

## Totals vs r21

| | r21 headline | r22 headline | r22 old-definition |
|---|---:|---:|---:|
| Succeeded without overlay | 1429/1514 (94.4%) | **1447/1514 (95.6%)** | 1272/1328 (95.8%) |
| Exact-tier | 658/1514 (43.5%) | **655/1514 (43.3%)** | 644/1328 (48.5%) |
| in-place | 355 | 355 | 355 |
| fallback-font | 176 | 176 | 176 |
| substituted | 98 | 97 | 86 |
| reflowed | 29 | 27 | 27 |
| retypeset | 771 | 792 | 628 |
| unsupported | 85 | 67 | 56 |

Headline success **+1.2 pp** (meets the ≥1 pp standing bar). Exact-tier
**−0.2 pp**. Wall 683.7 s (headline compute 540.3 s).

Headline unsupported, 67: no-text-layer 30, image-text 23,
`unsupported-unwritable` **14** (was 32). Of those 14: one form-order
mismatch (`arxiv-2611.17332` p.8) and **13** `zh-ojs-law` wraps that
now refuse with `retypeset-output-outside-source-clip` (new conservative
clip check; these were retypeset in r21). The 22 verifier rows, five
hyphen-match rows, and four coverage rows (`调`, `ℎ`, `〈`) succeeded.

## Quality metric (headline retypeset)

- Unchanged-line residual drift (after subtracting push Δ): measured
  on all **792** retypeset rows; **44** (5.6%) have any residual > 0;
  max **0.0305 pt**; p95 ~ 0. The `gsa-1-0` case is 0.
- Overflow ink overlap: measured on **543** overflowed retypeset rows;
  **411** (75.7%) still report envelope overlap. Push is conservative
  and often blocked; many overflows still collide. The d2l title wrap
  is a clean push (`overlap=false`).

## Official oracle (sampled 16)

The 16-sample set follows the saver policy, so membership shifted
slightly vs r21 (r21 included `17030-5-overflow` and
`zh-d2l-pytorch-597-overflow`; r22 includes `17030-0-overflow` and
`gsa-1-4-same-length`).

**10/16 passed** in this set (r21 was 11/16 on a slightly different
16). New pass: `gsa-17-0-same-length` (5 inherited form errors ignored).
Still failing (same family as r18–r21 unless noted):

- `arxiv-2611.17030-5-same-length`, `arxiv-2611.17030-0-same-length`,
  `gsa-2-5-multi-line`, `gsa-1-4-same-length` — Poppler extracted-text
  order / whitespace.
- `gsa-17-195-same-length` — untouched whitespace font program.
- **New:** `arxiv-2611.17030-0-overflow` — untargeted glyph
  font/codes/position (investigate push / hyphen residual).

`gsa-1-0-same-length` still passes.

## PNG pairs

Under `test-artifacts/retypeset-r22/renders/` (gitignored):

- `gsa-1-0-same-length-retypeset.pair.png` — unchanged “REPORT: EXECUTIVE” no longer shifts right
- `zh-d2l-pytorch-0-longer-retypeset.pair.png` — wrapped `习` and “Release 2.0.0” after a 29.74 pt push
- `arxiv-2611.17052-22-same-length-retypeset.pair.png` — Form XObject retypeset sample
- also `gsa-2-0-same-length`, `zh-ctex-manual-0-same-length`,
  `arxiv-2611.17030-0-overflow`

## Commits (local, not pushed)

Feature: `6ef41f6` exact, `5bd6193` oracle, `47a149c` match,
`112cfd1` fonts, `c71c8a3` quality. Merges into `feat/pdf-stage5`:
`0914df1`, `ce1769c`, `7e41668`, `4b2b09c`, `3d44497`. Integration:
`91b9cd1` official push mask, `cda7f42` hyphen-fold insertion home.
This RESULTS file is the final r22 record.

## Open issues

- Exact-tier still ~43.3%; witnessed leading did not pay for the
  stricter single-gap rule (net −3 exact overflows).
- 75.7% of overflowed retypeset rows still report ink overlap; same-
  column push needs a wider safe set or a better blocked-overlap story.
- 13 `zh-ojs-law` clip-refusal regressions vs r21.
- `arxiv-2611.17332` p.8 paragraph order inside a form.
- Vertical Japanese is detect+refuse only; no Identity-V emission.
- Official 16: one new overflow untargeted-glyph fail; four long-standing
  Poppler / whitespace-font fails remain.
- CJK bold/serif style matching is not bundled.
