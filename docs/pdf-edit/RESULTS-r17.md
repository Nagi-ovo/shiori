# Corpus r17 results (Round 10: Type1 StemSnap, fixed recovery, row-justify)

HEAD `01fcbd3` on `feat/pdf-stage5` (merges of `r10-encode`, `r10-bugs`, `r10-m2`).
Ran `run-corpus-r17.sh`. Cache reused; r14, r15 and r16 snapshots left intact.

Grok read-only review of all three workstreams found no P0/P1 in the diffs.
`resourceStamp.ts`, the raster veto, OC/Artifact show eligibility, and Tr 1/2
refusals were unchanged. Round 4 CFF/FontBBox refusals were unchanged.

## Totals vs r16 (43.4%)

| | r16 | r17 | delta |
|---|---:|---:|---:|
| Accepted (in-place + fallback-font + substituted + reflowed) | 576/1328 (43.4%) | 631/1328 (47.5%) | +55 (+4.14pp) |
| in-place | 303 | 355 | +52 |
| fallback-font | 206 | 176 | −30 |
| substituted | 61 | 84 | +23 |
| reflowed | 6 | 16 | +10 |
| overlay | 752 | 697 | −55 |

No file declined. 37 already-accepted latex/tagged/word rows changed mode
(mostly latex fallback-font → in-place once the source Type1 program parsed;
7 substituted → reflowed `fixed`).

The +55 new accepts are almost all latex (54) plus japanese `digital-jp-5`
p.11 `longer` (`fixed` recovery). Type1 `expected def, got systemdict` is gone
from encode-failed (69 → 28, leftover chinese unverified clusters, unembedded
tagged fonts, and a few missing-glyph names). Many former encode-failed rows
now reach later layout/growth gates or accept.

No corpus row used strategy `row-justify`. New reflows are `fixed` (10) plus
the six pre-existing `wrap`s. `grow-down-space-not-proved` 75 → 78 (encode
rows moving into that gate offset any M2 unlock). `layout-refused` 38 → 46;
`plan-stream-reflow-null-after-layout-ok` stays 24 (those remain genuine
destination-proof refusals). `font-unavailable` 41 → 32.

## Per category

- latex 97/275 (35.3%) → 151/275 (54.9%) (+54): in-place 49→101, fallback-font 40→10, substituted 8→38, reflowed 0→2
- japanese 43/165 (26.1%) → 44/165 (26.7%) (+1): `digital-jp-5` p.11 `longer` reflowed `fixed`
- tagged 247/467 (52.9%), chinese 153/314 (48.7%), indesign 17/35, word 19/33, scanned-ocr 0/39 unchanged in accepted count (some tagged/word substituted rows are now reflowed `fixed`)

## Oracle (16 samples)

Passed 10. Failed 6.

Pre-existing from r14–r16 (same assertions):

- `gsa-17-195-same-length`: untouched whitespace font program changed
- `gsa-2-5-multi-line`, `gsa-1-4-same-length`, `gsa-2-2-missing-glyph`: Poppler extracted text mismatch

New samples in this run's 16 (sampler shifted because of new accepts):

- `digital-jp-5-11-longer` **passes** (the C fixed-recovery case)
- `arxiv-2611.17030-17-same-length` fails Poppler extracted text mismatch. Native probes ran (notdef PDF written). The compact-text diff is significance stars (`∗∗∗`) attaching to different table cells in extraction order, in the same family as the long-standing GSA Poppler fails. Not a new pixels-outside-mask failure.
- `arxiv-2611.17030-0-same-length` (substituted + `fixed`) fails `manifest source sequence/origin differs`. This is a new oracle fail on a new accept and should be investigated; it is not a file-level accept decline.

`gsa-11-0-multi-line` still passes. Script exit status 1 covers the six fails above.

## PNG pairs

New reflows that had saved samples, under `test-artifacts/reflow-r17/renders/` (gitignored):

- `digital-jp-5-11-longer-reflowed.{before,after,pair}.png`
- `arxiv-2611.17030-17-same-length-reflowed.{before,after,pair}.png`
- `gsa-5-4-same-length-reflowed.{before,after,pair}.png`
- `gsa-9-5-same-length-reflowed.{before,after,pair}.png`

Other new `fixed` reflows were not saved as corpus samples (including
`arxiv-2611.17030-17-longer` and several tagged/word same-length mode changes).

## Commits (no push)

Feature commits on side branches, then merged into `feat/pdf-stage5`:

- `f7d5343` Parse Nimbus StemSnapH/V systemdict hint compatibility idioms
- `4d3a273` Accept a proved fixed layout after the byte-span compiler overflows
- `643080c` Add bounded row-justify tightening of proved suffix word gaps
- `2ec60cc` Merge branch `r10-encode` into `feat/pdf-stage5`
- `3e6471d` Merge branch `r10-bugs` into `feat/pdf-stage5`
- `01fcbd3` Merge branch `r10-m2` into `feat/pdf-stage5`

All authored by Jesse Zhang, no co-author.
