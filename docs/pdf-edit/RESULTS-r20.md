# Corpus r20 results (retypeset; cover overlay retired)

`feat/pdf-stage5` at `75e51fa` plus this write-up. Production parent of the
engine is `f422087`. Cache reused; r14–r19 snapshots left intact. Ran
`run-corpus-r20.sh` (532.0 s, 41 files, 1700 rows). No push. No reset cards.

## Design

Mature editors do not hide original text under a white rectangle. Shiori now:

1. Keeps the exact tier unchanged (`in-place` / `fallback-font` /
   `substituted` / `reflowed`, `fidelity: exact`, strict 0-px-outside-mask
   oracle).
2. Retypesets remaining page-text edits: delete the addressed glyphs from
   the content stream and re-lay out from the first edited line, reusing
   original font/bytes when possible, otherwise an embedded substitute
   subset. Font size is kept; the block may wrap, grow, and **overflow**
   (no font shrink, no same-column push). Approximate edits show
   "Layout may change." (and an overlap notice when overflowed).
3. Leaves these unsupported, never covered: no text layer
   (`unsupported-no-text-layer`), invisible OCR over a visible image
   (`unsupported-image-text`), Form XObject text
   (`unsupported-form-xobject`), and fail-closed unwritable streams
   (`unsupported-unwritable`).

Contract: `docs/pdf-edit/RETYPESET.md`. Opus plan-mode review (session
`1d75cea9-3c88-49a2-9761-091e3d77d9f6`) dropped push from M1, required
glyph-identity deletion, and classified image-text / forms as unsupported.
Grok review of M1 and M2 found no P0/P1.

## Totals vs r19

| | r19 headline | r20 headline | r20 old-definition |
|---|---:|---:|---:|
| Succeeded without overlay | n/a (overlay still existed) | **1069/1514 (70.6%)** | 947/1328 (71.3%) |
| Exact-tier | 658/1514 (43.5%) | **658/1514 (43.5%)** | **645/1328 (48.6%)** |
| in-place | 355 | 355 | 355 |
| fallback-font | 176 | 176 | 176 |
| substituted | 98 | 98 | 86 |
| reflowed | 29 | 29 | 28 |
| retypeset | — | 411 | 302 |
| unsupported / overlay | 856 overlay | 445 unsupported | 381 |

Exact-tier counts match r19 exactly. That is the check that the exact path
and its proofs were not loosened.

Headline unsupported, 445: `unsupported-unwritable` 384, no-text-layer 30,
form-xobject 16, image-text 15. All 45 scanned-ocr rows are in the last two
bins, as designed. If those 45 are removed from the denominator, success
is 1069/1469 (72.8%). The remaining gap to “near 100% minus scanned” is
almost entirely the 384 unwritable rows plus 16 forms.

Unbreakable overflow stress (excluded from headline): 112/186 succeeded
(109 retypeset + 3 exact), 74 unsupported.

## Per category (headline)

| Category | Succeeded without overlay | Exact-tier | Retypeset | Unsupported |
|---|---:|---:|---:|---:|
| chinese | 233/351 (66.4%) | 154/351 (43.9%) | 79 | 118 |
| indesign | 38/40 (95.0%) | 17/40 (42.5%) | 21 | 2 |
| japanese | 92/186 (49.5%) | 44/186 (23.7%) | 48 | 94 |
| latex | 194/315 (61.6%) | 176/315 (55.9%) | 18 | 121 |
| scanned-ocr | 0/45 (0%) | 0/45 | 0 | 45 |
| tagged | 482/539 (89.4%) | 248/539 (46.0%) | 234 | 57 |
| word | 30/38 (78.9%) | 19/38 (50.0%) | 11 | 8 |

## Oracle

Official saved-sample pass: 10/16. Four of the six official retypeset
samples passed the new gate (Chinese, Japanese, tagged, word). Exact-tier
samples keep the old strict veto.

Retypeset passes: `zh-hans-law-4-missing-han`, `digital-jp-1-0-same-length`,
`gsa-10-0-longer`, `gsa-2-2-overflow`.

Retypeset fails:

- `gsa-17-0-same-length` — `qpdf --check` exit 3 with stream-complete
  warnings. The **before** PDF has the same six warnings and the same exit
  code; this is inherited source noise, not a new corrupt write.
- `arxiv-2611.17297-0-longer` — Poppler extracted-character bag does not
  match native after-text (retypeset allows changed reading order but
  still requires the same scalars).

Exact-tier fails, same family as r18/r19:

- `arxiv-2611.17030-0-same-length`, `17030-5-same-length`,
  `gsa-2-5-multi-line` — Poppler text order after the native raster pass
- `gsa-17-195-same-length` — pre-existing `untouched whitespace font
  program changed`

No official fail is a pixels-outside-retypeset-mask or
pixels-outside-proved-region veto. Runner exit 1 is these six official
fails.

## PNG pairs

Under `test-artifacts/retypeset-r20/renders/` (gitignored):

- `gsa-10-0-longer-retypeset.pair.png` — tagged Latin, official pass
- `gsa-2-2-overflow-retypeset.pair.png` — word Latin, official pass
- `arxiv-2611.17332-0-longer-retypeset.pair.png` — latex Latin
- `gsa-12-0-same-length-retypeset.pair.png` — tagged, bold substitute
- `zh-hans-law-4-missing-han-retypeset.pair.png` — Chinese, official pass
- `zh-d2l-pytorch-0-longer-retypeset.pair.png` — Chinese overflow
- `zh-ojs-law-0-same-length-retypeset.pair.png` — Chinese stroked
- `digital-jp-1-0-same-length-retypeset.pair.png` — Japanese, official pass
- `digital-jp-2-0-same-length-retypeset.pair.png` — Japanese stroked
- `digital-jp-5-11-overflow-retypeset.pair.png` — Japanese overflow

## Open issues

- **`unsupported-unwritable` 384/1514**, all
  `user source text does not match addressed paragraph`. The visual
  paragraph and `overlay.originalText` disagree (especially latex 105,
  chinese 118, japanese 94). This is the main obstacle to the
  near-100%-minus-scanned headline.
- **Form XObject copy-on-write** (16 latex rows) is still deferred.
- **Same-column push** remains deferred (overflow/overlap is intentional).
- Tighten the qpdf gate so pre-existing source warnings are not scored as
  a retypeset P0 (`gsa-17-0-same-length`).
- Investigate `arxiv-2611.17297-0-longer` Poppler/native character-bag
  mismatch.
