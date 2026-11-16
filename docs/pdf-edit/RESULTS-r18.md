# Corpus r18 results (Round 11: ligature oracle walk, Type1 hvcurveto ink, encode labels)

HEAD `df2665d` on `feat/pdf-stage5` (merges of `r11-oracle`, `r11-ink`, `r11-zh`).
Ran `run-corpus-r18.sh`. Cache reused; r14–r17 snapshots left intact.

Grok read-only review found no P0/P1 in the merged diffs. The raster veto,
origin tolerance, typographic row-justify floors, and OC/Artifact show
refusals were not loosened.

## Blocking oracle (r17 `arxiv-2611.17030-0-same-length`)

Root cause: **harness, not production painting**. The original Type1 page
records a `/fi` (and on other new accepts `/ff`) ligature as one cluster
with two Unicode scalars. PDFium emits two scalar glyphs at the same origin.
`reflowOracle.ts` walked native glyphs 1:1, so the audit died on
`manifest source sequence/origin differs` before raster.

Independent raster on the saved r17 pair was already clean: 12,039 changed
pixels, 0 outside the box, 0 outside the mask, 0 unexplained original
pixels. Twelve new r17 accepts shared the ligature class (two saved).

The harness now expands multi-scalar manifest clusters against a native
cursor (`sourceEnd`), and keeps per-component font/outline identity.
After this fix, `arxiv-2611.17030-0-same-length` no longer fails the
sequence check. In r18 it only fails the long-standing Poppler extraction
order check (two-column abstract interleaving), *after* the native
PDFium + raster audit has already passed.

Sampling the other saved new r17 accepts then exposed a **separate, real**
Type1 measurement bug (below), not shared with the ligature walk.

## Totals vs r17 (47.5%)

| | r17 | r18 | delta |
|---|---:|---:|---:|
| Accepted (in-place + fallback-font + substituted + reflowed) | 631/1328 (47.5%) | 645/1328 (48.6%) | +14 (+1.05pp) |
| in-place | 355 | 355 | 0 |
| fallback-font | 176 | 176 | 0 |
| substituted | 84 | 86 | +2 |
| reflowed | 16 | 28 | +12 |
| overlay | 697 | 683 | −14 |

No previously accepted row declined. Nine already-accepted latex rows
changed mode (substituted → reflowed `fixed`) once corrected Type1 ink
bounds let the source font prove the destination. Overflow refusals
353 → 339. Wall time 328.6 s.

No corpus row used strategy `row-justify` (0). New/mode-changed reflows
are `fixed` (21, was 10) plus `wrap` (7, was 6). The new wrap is
`arxiv-2611.17280-15-multi-line`.

## Per category

- latex 151/275 (54.9%) → 165/275 (60.0%) (+14): substituted 38→40, reflowed 2→14
- tagged 247/467 (52.9%), chinese 153/314 (48.7%), japanese 44/165 (26.7%),
  indesign 17/35, word 19/33, scanned-ocr 0/39 unchanged in accepted count

## Overflow-histogram delta

- no-region-proof 155 → 144 (latex 26 → 15)
- selection-not-in-proof 9 → 6
- grow-down-space-not-proved 78 (unchanged)
- layout-refused 46, plan-stream-reflow-null-after-layout-ok 24 (unchanged)
- encode-failed 28 (unchanged); the 19 Chinese rows now report
  `no ToUnicode mapping for cluster` instead of the generic fallback

## Type1 hvcurveto (why four r17 substituted+fixed samples failed the veto)

`type1CharString.ts` built the `hvcurveto` (op 31) control hull correctly
as `dx1 0 dx2 dy2 0 dy3`, but advanced the current point by
`(dx1+dy2, dx2+dy3)` instead of `(dx1+dx2, dy2+dy3)`. Later path segments,
including those in reachable Subrs, started at a false origin, so analytic
ink for letters such as `c`/`e` undershot the rasterized top. Destination
masks then covered owned original paint that dilated `oldInk` (already
`inkGuardPt = 1` pt) did not include. `vhcurveto` was already correct.

Correcting the endpoint cleared the raster veto on the four saved samples
(17107, 17280, 17320, 17332): 0 changed pixels outside the mask, 0
unexplained original pixels, independently re-audited. That is the source
of the +14 latex accepts / +12 reflows.

## Other workstreams (no yield)

- **row-justify gating:** no sound fix. Census of remaining one-line
  grow-down rows: planner calls had zero eligible TJ/word-space capacity;
  most also exceeded the 2% row-width budget; the few within budget had an
  empty suffix or a lone trailing space.
- **Chinese encode-failed (19):** still not encodable. The requested longer /
  missing-han clusters have no ToUnicode label to verify. Diagnostic reason
  only; no identity-guessing encode path was added.
- **tagged target-state (39):** no change. Census plus a native visibility
  probe: a named Background OC group hides the selected text in PDFium
  (3,991 changed pixels) without changing the content stream or extracted
  text. OC is not paint-neutral; existing refusals stay.

## Oracle (16 samples)

Passed 10. Failed 6.

Native PDFium + raster (including the mask and unexplained-paint veto) runs
before Poppler. Every r18 fail below is after that native audit, except the
pre-existing whitespace-font case.

Pre-existing from r14–r17 (same assertions):

- `gsa-17-195-same-length`: untouched whitespace font program changed
- `gsa-2-5-multi-line`, `gsa-1-4-same-length`, `gsa-2-2-missing-glyph`:
  Poppler extracted text mismatch

New or shifted in this run's 16:

- `arxiv-2611.17030-0-same-length` no longer fails
  `manifest source sequence/origin differs`. It now fails only Poppler
  extraction order (two-column abstract interleaving), same family as the
  long-standing GSA Poppler fails. Not a pixels-outside-mask failure.
- `arxiv-2611.17030-5-same-length` (new sampler entry, substituted→reflowed
  `fixed`) fails Poppler extracted text mismatch in the same family
  (table/column order). Not a pixels-outside-mask failure.

Script exit status 1 covers the six fails above.

## PNG pairs

New reflows that had saved samples, under `test-artifacts/reflow-r18/renders/`
(gitignored):

- `arxiv-2611.17030-5-same-length-reflowed.{before,after,pair}.png`
- `arxiv-2611.17053-15-same-length-reflowed.{before,after,pair}.png`
- `arxiv-2611.17107-0-same-length-reflowed.{before,after,pair}.png`
- `arxiv-2611.17280-10-longer-reflowed.{before,after,pair}.png`

Other new `fixed`/`wrap` reflows were not saved as corpus samples
(including `arxiv-2611.17280-15-multi-line` wrap).

## Commits (no push)

Feature commits on side branches, then merged into `feat/pdf-stage5`:

- `68c6a67` Audit PDFium-split ligature clusters in the reflow oracle
- `04f95a7` Merge branch `r11-oracle` into `feat/pdf-stage5`
- `fdd2388` Correct Type1 hvcurveto endpoint used by later path segments
- `3b3e4da` Merge branch `r11-ink` into `feat/pdf-stage5`
- `799aee8` Label encode misses by missing ToUnicode or font-encoding mapping
- `df2665d` Merge branch `r11-zh` into `feat/pdf-stage5`

No reset cards. Codex quota after the five sessions: 35% used, 65% left;
window resets Fri 20 Nov 18:13 Europe/London.
