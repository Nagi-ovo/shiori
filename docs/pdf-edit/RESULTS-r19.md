# Corpus r19 results (realistic overflow edits)

Harness-only change on `feat/pdf-stage5` from parent `e9e3cab`. Production
accept-path code is unchanged. Ran `run-corpus-r19.sh`. Cache reused;
r14–r18 snapshots left intact.

Codex (sister, `gpt-6.1-sol`, xhigh, fast) implemented the matrix and
reporting in worktree `r19-overflow` (session `01a1e573-1d0e-7af0-9c91-9dec5ed07b0c`).
Grok read-only review of the harness diff found no P0/P1. `summarize(rows)`
is unchanged; headline / unbreakable / old-definition summaries are extra
fields. No reset cards. No push.

The old `overflow` kind (`firstWord.repeat(8)`, no spaces) is now
`overflow-unbreakable` and is excluded from the headline rate. `overflow`
(+25%) and `overflow-2` (+55%) append a deterministic, language-aware
phrase (Latin words with spaces; Chinese or Japanese short clauses from
everyday characters in Noto Sans SC/JP). Hangul-only lines use the Latin
bank so a layout probe does not introduce extra CJK coverage demand.

## Totals

| | r18 (old definition) | r19 old-definition | r19 headline | r19 unbreakable |
|---|---:|---:|---:|---:|
| Accepted | 645/1328 (48.6%) | 645/1328 (48.6%) | 658/1514 (43.5%) | 3/186 (1.6%) |
| in-place | 355 | 355 | 355 | 0 |
| fallback-font | 176 | 176 | 176 | 0 |
| substituted | 86 | 86 | 98 | 2 |
| reflowed | 28 | 28 | 29 | 1 |
| overlay | 683 | 683 | 856 | 183 |

Old-definition matches r18 exactly (same 1,328-kind set, unbreakable in
the old overflow slot). Headline adds the 372 realistic overflow rows
(+16 accepted: 11 `overflow`, 5 `overflow-2`) and drops the 186
unbreakable rows (which still accept the same 3 cases as r18 overflow).
Arithmetic: 645 − 3 + 16 = 658. Wall time 480.0 s. 41 files. 1,700 total
rows including the stress case (`summary.edits === rows.length`).

Headline reflows: 21 `fixed` + 8 `wrap` (29). The two new wraps are
`zh-d2l-pytorch` p.597 `overflow` and `overflow-2`. The unbreakable wrap
on that same line is the r18 overflow reflow, renamed, and is outside the
headline count.

## Per category (headline)

- chinese 154/351 (43.9%); old-definition 153/314 (48.7%, same accepts as r18 plus the renamed unbreakable reflow excluded here)
- indesign 17/40 (42.5%); old-definition 17/35 (48.6%)
- japanese 44/186 (23.7%); old-definition 44/165 (26.7%)
- latex 176/315 (55.9%); old-definition 165/275 (60.0%) — net +11 vs old-definition: 12 realistic-overflow substitutions, minus the one unbreakable latex substitution still counted under old-definition; no new latex reflow
- scanned-ocr 0/45 (0%); old-definition 0/39
- tagged 248/539 (46.0%); old-definition 247/467 (52.9%) — +1 `gsa-1` p.4 overflow substitution in the headline
- word 19/38 (50.0%); old-definition 19/33 (57.6%)

## Realistic overflow outcomes

| Kind | Rows | Accepted | substituted | reflowed | reason=overflow | other refusals |
|---|---:|---:|---:|---:|---:|---:|
| overflow | 186 | 11 | 10 | 1 | 115 | 60 |
| overflow-2 | 186 | 5 | 4 | 1 | 121 | 60 |
| overflow-unbreakable | 186 | 3 | 2 | 1 | 140 | 43 |

Accepted realistic rows are mostly latex substitutions of a short English
clause (`in this case`, `as noted`, …), plus `gsa-1` p.4 (tagged,
substituted) and the `zh-d2l-pytorch` p.597 Chinese wraps.

## Decline histogram (new overflow rows)

Classified `reason=overflow` only. Full by-kind dump:
`test-artifacts/pdf-corpus-r19/overflow-kind-histogram.md`.

**`overflow` (115 classified):** grow-down-space-not-proved 42,
no-region-proof 41, encode-failed 29, plus one each of classifier-error,
source-text-mismatch, mixed-font-or-size. **0 layout-refused.**

**`overflow-2` (121 classified):** no-region-proof 43,
grow-down-space-not-proved 42, encode-failed 33, and the same three
singletons. **0 layout-refused.**

Encode-failed on the new kinds is mostly `no ToUnicode mapping for cluster`
(16 overflow / 18 overflow-2) and `glyph-unavailable: missing or .notdef
glyph space` (11 / 12, all latex — the appended Latin phrase introduces a
space some Type1 encodings lack). Grow-down remains the one-line /
`leading=0` / no column-edge class from r12.

**`overflow-unbreakable` (140 classified):** no-region-proof 50,
**layout-refused 46**, grow-down-space-not-proved 38, encode-failed 3.
The entire r18 layout-refused bin (46, all old `overflow`) now sits on
the unbreakable stress case, as expected: the eight-copy first word still
has no legal measured break. Realistic overflow no longer contributes to
that bin.

## Oracle

Official sample pass: 10 pass / 6 fail, same family as r18. No
pixels-outside-mask on any fail.

Passes include the new `zh-d2l-pytorch-597-overflow` reflow (25,378
changed pixels, 0 outside the mask, 0 unexplained original pixels).

Fails, all after the native raster audit unless noted:

- `gsa-17-195-same-length` — pre-existing `untouched whitespace font program changed`
- `arxiv-2611.17030-0-same-length`, `arxiv-2611.17030-5-same-length`,
  `gsa-2-5-multi-line`, `gsa-1-4-same-length`, `gsa-2-2-missing-glyph` —
  Poppler extracted-text order (two-column / long-standing)

Side audit of the two additional p.597 reflows (re-exported from the
saved before PDF, because the corpus keeps one reflow sample per file):
`overflow-2` and `overflow-unbreakable` also pass, 0 outside mask, 0
unexplained original pixels.

The corpus runner exited 1 solely because of the six official oracle
fails, as in r18.

## PNG pairs

Under `test-artifacts/reflow-r19/renders/` (gitignored):

- `zh-d2l-pytorch-597-overflow-reflowed.pair.png`
- `zh-d2l-pytorch-597-overflow-2-reflowed.pair.png`
- `zh-d2l-pytorch-597-overflow-unbreakable-reflowed.pair.png`

## Review notes (non-blocking)

On very short lines, `overflow` and `overflow-2` can choose the same
shortest phrase (both exceed +60%). Japanese kanji-only lines (no kana)
use the Chinese bank, as specified.
