# Round 12 census (no accept-path change; loop stops)

HEAD remains `1eebccd` for production accept paths. r18 rate **48.6%
(645/1328), 28 reflowed** is unchanged. The three workstreams found no
sound production recovery. Corpus r19 was not rerun: it would have
reproduced r18. The 1 pp loop therefore stops.

Grok read-only review of the r11 commits (`68c6a67`, `fdd2388`, `799aee8`)
was already completed in Round 11 and was reconfirmed this round: no P0/P1.
The raster veto, 0.005 pt origin tolerance, typographic floors, clip/ActualText
and Tr 1/2 refusals were not loosened.

## A. grow-down-space-not-proved (78) — no production change

All 78 r18 refusals were inspected (60 distinct source regions). The first
analytic occupant below/in the source's horizontal span is paint in 65 rows
and foreign glyphs/placements in 13. None is bare page bottom or a footnote
with an empty proved tail.

| What lies below | Rows |
| --- | ---: |
| LaTeX running-header rule | 20 |
| GSA title separator | 20 |
| GSA appendix banner | 10 |
| Hans Chinese running-header rule | 12 |
| Following text/placements | 10 |
| GSA table paint | 2 |
| Unmeasured glyph envelopes | 2 |
| D2L chapter-title rule | 1 |
| Cover release line | 1 |

74 rows have `leadingPt=0` (one-line titles/headers), so `proveDownwardSlot`
never runs. The four positive-leading locations meet unowned bibliography,
caption, or next-paragraph occupants in the proposed band. Following
paragraphs and graphic content are outside proven ownership and cannot be
shifted to manufacture a tail. A single paragraph gap is still not pitch.

Added `reflowDownwardSlot.test.ts` to lock the existing boundary (explicit
TL or two agreeing observed gaps may grow into a clear tail; footnotes,
figures, side-column glyphs, rules, unplaced shows, crop/media/clip, and a
lone paragraph gap still refuse).

## B. Japanese 44/165 (26.7%) — no production change

All 121 refusals were reconstructed on 21 sampled pages of digital-jp-1..6.

| Primary class | n | What it actually is |
| --- | ---: | --- |
| clip/graphics/semantic dependent target | 67 | Active rectangular `W*`/`W` clips (page-like but excluding a left-edge sliver of MediaBox/CropBox). Not exact page clips. ExtGState / ActualText / Alt / E / unresolved Properties: **zero**. |
| stroked text (Tr 1/2) | 29 | All **Tr 2** (fill+stroke); also clipped. |
| style-change | 12 | Real mixed physical sizes (e.g. 6.96 pt with 12 pt). |
| overflow / no-region-proof | 12 | 4 interleaved unowned same-baseline; 4 interleaved columns; 4 unsupported short-region show/Tlm. |
| isolated whitespace fragment | 1 | digital-jp-5 p.11 overflow emission, not a kinsoku miss. |

**Vertical writing is absent** on these sampled pages (Identity-H only; no
Identity-V / vertical WMode; no nonhorizontal native glyphs). **CID CMap
holes are not a refusal class** (selected source codes have Unicode labels).
**Kinsoku caused zero refusals** (overflow stops at region proof; the one
accepted Japanese reflow is `fixed`, not wrap). The top class is a real clip
and stays refused. Existing stroke occupancy bounds unchanged source
occupants only; it does not authorize Tr 2 replacements.

## C. layout-refused 46 / plan-null 24 — no production change

All 46 layout-refused rows are `reflow-break-unsupported: no legal measured
break`. The corpus `overflow` edit repeats the first word eight times
*without spaces*. The first legal break is wider than every existing slot
(examples: 1736 pt needed vs 275 pt slot). This is a horizontal break
refusal, not exhausted downward baselines. `proveDownwardSlot` is only
called on `code=overflow`, so growth was not attempted; calling it anyway
on the 16 positive-leading rows still cannot fit the unbreakable span.

All 24 plan-null rows have a successful measured layout (22 `spacing-only`,
2 `wrap`). Every null is `proveGlyphRegion`: 15 stationary placement
intersections with another baseline, and the rest honest row-local / paint /
font refusals. No dropped `ownEnd`, soft-break, or fixed-recovery bug remains.

## Rate vs 48.6%

Unchanged: **645/1328 (48.6%)**, reflowed 28, per-category unchanged,
decline histogram unchanged. No new oracle run, no new PNG pairs.

## Commits (no push)

- `68c6a67` / `fdd2388` / `799aee8` were already on `feat/pdf-stage5` from
  Round 11 (reviewed, no P0/P1).
- This note, plus the downward-slot regression tests, may be checkpointed
  on `feat/pdf-stage5`. No accept-path production commit.

No reset cards. Codex quota after the three Round 12 sessions is reported
in the parent turn.
