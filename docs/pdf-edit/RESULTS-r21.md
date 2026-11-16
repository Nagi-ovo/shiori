# Corpus r21 results (addressing, Form XObjects, CJK fonts, oracle gates)

`feat/pdf-stage5` at `9b9f562` plus this write-up. Production comes from
four parallel milestones merged after Grok review (no P0/P1). Cache
reused; r14–r20 snapshots left intact. Ran `run-corpus-r21.sh` (574.1 s,
41 files, 1700 rows). No push. No reset cards.

## Design / root causes

### A. 384 unwritable rows (`user source text does not match addressed paragraph`)

Not a harness `originalText` bug. Cover rects already selected the whole
visual line. Production paragraph addressing then shrunk that line to a
fragment, so the user's string could not be found.

1. Same-baseline joins used ink `coreQuad` right with a 0.1 pt slop.
   Kerning, italic, `f`+vowel and especially stroked (Tr 1/2) letters
   overlap that ink box, splitting a title mid-word (`Similarb` /
   `AUTUMN` group of one letter). Joins now use typographic advance and
   allow modest negative gaps (0.5 em).
2. q / clip / marked-content identity, plus a **monotonic clip counter
   that was never restored on `Q`**, split tagged and CJK lines that
   wrap each phrase. Cover-selected glyphs now stay in the group;
   q/clip/MC remain emission scope, not a membership filter.
3. Secondary: `sourceAtoms` inserts 0.2 em gap spaces that PDFium run
   concatenation omits, and Han line breaks do not get a space while
   `originalText` newlines normalise to one. Matching is now
   whitespace-insensitive, preferring the selected span.

### B. Form XObject text (16 latex headline rows)

Retypeset inside a **copy-on-write** form occurrence (`ShioriFmN`),
even when the source form looks unshared. Other pages and other `Do`
uses are unchanged. Text forms are no longer refused solely for living
in an XObject. Invisible OCR over a visible image stays
`unsupported-image-text`.

### C. Substitute fonts

The picker used only clusters the source could not encode, so a Chinese
`longer` insert of Latin `i` selected LiberationSans. It now sees the
full paragraph: Kana → Noto JP; Han or Hangul → Noto SC; never
Liberation for those scripts. Bundled faces lack ordinary Hangul
syllables; those still **refuse atomically** (no tofu). A retypeset-only
CFF preparation order avoids a fontkit blank-glyph subsetter bug.

### D. Oracle and PNG crop

- qpdf runs on before and after; only new diagnostics or a worse exit
  fail. Inherited InDesign "stream is complete…" warnings are no longer
  a P0.
- `arxiv-2611.17297-0-longer` was not a missing wrapped `i`. Both
  engines add exactly one `i`; PDFium exposes two line-end hyphens as
  U+0002 that Poppler reads as `-`. The retypeset Poppler gate now
  compares signed scalar deltas (Poppler after−before vs native
  after−before). Exact-tier Poppler equality is unchanged.
- Pair crops union after-page native ink of new/moved glyphs with the
  original covers, so wrapped lines are not clipped. The 17297 pair is
  72 px tall (was clipped at 54).

## Totals vs r20

| | r20 headline | r21 headline | r21 old-definition |
|---|---:|---:|---:|
| Succeeded without overlay | 1069/1514 (70.6%) | **1429/1514 (94.4%)** | 1251/1328 (94.2%) |
| Exact-tier | 658/1514 (43.5%) | **658/1514 (43.5%)** | **645/1328 (48.6%)** |
| in-place | 355 | 355 | 355 |
| fallback-font | 176 | 176 | 176 |
| substituted | 98 | 98 | 86 |
| reflowed | 29 | 29 | 28 |
| retypeset | 411 | 771 | 606 |
| unsupported | 445 | 85 | 77 |

Exact-tier counts match r20 exactly. Headline gain is **+23.8 pp**.
Excluding 45 scanned-ocr rows: 1429/1469 (97.3%).

Headline unsupported, 85: `unsupported-unwritable` 32, no-text-layer 30,
image-text 23. **Zero** `unsupported-form-xobject` (r20 had 16).
Scanned-ocr is unchanged (0/45: 30 no-text-layer + 15 image-text). The
extra 8 image-text rows are `arxiv-2611.17280` p20 form OCR, correctly
reclassified rather than covered.

Unbreakable overflow (excluded from headline): 177/186 (95.2%)
succeeded (174 retypeset + 3 exact), 9 unsupported.

## Per category (headline)

| Category | Succeeded without overlay | Exact-tier | Retypeset | Unsupported |
|---|---:|---:|---:|---:|
| chinese | 349/351 (99.4%) | 154/351 (43.9%) | 195 | 2 |
| indesign | 40/40 (100%) | 17/40 (42.5%) | 23 | 0 |
| japanese | 184/186 (98.9%) | 44/186 (23.7%) | 140 | 2 |
| latex | 287/315 (91.1%) | 176/315 (55.9%) | 111 | 28 |
| scanned-ocr | 0/45 (0%) | 0/45 | 0 | 45 |
| tagged | 531/539 (98.5%) | 248/539 (46.0%) | 283 | 8 |
| word | 38/38 (100%) | 19/38 (50.0%) | 19 | 0 |

Exact-tier rates per category also match r20.

Form XObjects: `arxiv-2611.17052` p22 all 8 headline edits (plus
unbreakable) are `retypeset`. `arxiv-2611.17332` p8 is mixed exact /
retypeset, with one remaining multi-line unwritable. `arxiv-2611.17280`
p20 is `unsupported-image-text` as designed.

Chinese retypeset substitutes are Noto SC or reused source fonts, never
Liberation. Japanese Liberation rows are Latin-only lines in those PDFs
(e.g. "Public Data License").

## Oracle

Official saved-sample pass: **11/16** (r20: 10/16). Runner exit 1 is
the five official fails. Four are the same exact-tier family as r18–r20:

- `arxiv-2611.17030-0-same-length`, `17030-5-same-length`,
  `gsa-2-5-multi-line` — Poppler text order
- `gsa-17-195-same-length` — pre-existing `untouched whitespace font
  program changed`

New official retypeset fail: `gsa-17-0-same-length` —
`retypeset source walk failed`. The production edit **succeeded**
(`mode: retypeset`). `readRetypesetStreams` reports five `invalid Form
BBox/Matrix` errors on uninvolved InDesign forms; the **before** PDF
has the same five errors (object numbers shift after the write). The
page-stream walk itself is fine. This is an over-strict oracle assert
(`streams.errors.length === 0`), not a corrupt write. qpdf warnings
remain inherited (exit 3 both sides) and no longer fail the qpdf gate.

New official retypeset passes include previously unwritable rows
(`gsa-1-0-same-length`, `gsa-2-0-same-length`, `digital-jp-1-0-same-length`)
and `arxiv-2611.17030-5-overflow`. `zh-hans-law-4-missing-han` still
passes. `arxiv-2611.17297-0-longer` was not re-selected this round; its
Poppler bag issue is fixed in the gate.

No official fail is a pixels-outside-retypeset-mask or
pixels-outside-proved-region veto.

## PNG pairs

Under `test-artifacts/retypeset-r21/renders/` (gitignored):

- `gsa-1-0-same-length-retypeset.pair.png` — tagged, was unwritable, official PASS
- `gsa-2-0-same-length-retypeset.pair.png` — word, was unwritable, official PASS
- `digital-jp-1-0-same-length-retypeset.pair.png` — Japanese, official PASS
- `zh-ctex-manual-0-same-length-retypeset.pair.png` — CTeX logo addressing
- `zh-d2l-pytorch-0-longer-retypeset.pair.png` — Chinese, Noto SC, overflowed
- `arxiv-2611.17297-0-longer-retypeset.pair.png` — wrapped `i` fully visible
- `zh-hans-law-4-missing-han-retypeset.pair.png` — Chinese, official PASS
- `arxiv-2611.17030-5-overflow-retypeset.pair.png` — latex overflow, official PASS
- `zh-ojs-law-0-same-length-retypeset.pair.png` — Chinese stroked
- `gsa-10-0-longer-retypeset.pair.png` — tagged longer / overflow crop

The corpus sampler still keeps only the first retypeset sample per file,
so no official 17052 p22 form-XObject pair was saved.

## Open issues

- **32 headline `unsupported-unwritable`**, down from 384:
  - 22 `output glyph font, codes or destination differs` — a 1e-5
    position-key rounding abort in `writeRetypeset` (measured on the
    arXiv title overflow-2 as expected x 38818579 vs emitted 38818580).
    Ten-decimal TJ serialization was added for forms but does not
    cover every case.
  - 6 still `user source text does not match addressed paragraph`,
    often multi-line latex with U+0002 / soft-hyphen markers in
    `originalText`.
  - 4 substitute coverage refusals: `调` (2 Chinese), `ℎ`, `〈`.
- Official `gsa-17-0-same-length` walk assert should ignore inherited,
  uninvolved Form BBox/Matrix errors (compare-before, like qpdf).
- Same-column push remains deferred.
- Ordinary Hangul syllables cannot be substituted with bundled Noto SC/JP;
  the write refuses rather than tofu.
- Exact-tier Poppler-order and whitespace-font official fails are
  unchanged from r18–r20.
