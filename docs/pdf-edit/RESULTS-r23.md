# Corpus r23 results (overlap reduction, frame tighten, CJK bold, clip ink)

`feat/pdf-stage5` `59ae20d` (this RESULTS commit). Production comes
from five parallel milestones (push/tighten, form-context push, clip
re-layout, official push-region oracle, CJK Bold) merged after a
read-only review, plus two follow-up fixes (PDFium-safe push emission;
misdeclared CID CFF ink) reviewed the same way and merged before a
second corpus run. Cache reused; r14–r22 and the first r23 snapshot
(`test-artifacts/pdf-corpus-r23`, `4e35ac9`) were left intact. Final
run: `run-corpus-r23-final.sh` on `59ae20d` (726.1 s wall, 41 files,
1700 rows). First production run on `4e35ac9` was 756.3 s. No push.
No reset cards.

Survey techniques from `/workspace/research/pdf-edit-survey/SURVEY.md`
were used as notes only. No GPL/AGPL code or survey-tree fonts were
copied. Official Noto Sans CJK Bold (SC/JP/KR) came from notofonts
(SIL OFL).

## What landed

### In-flow same-column push (1)

- Following same-column text, in-flow rules/paths, and in-flow images
  can move down by one Δ. Page furniture (headers/footers) stays put.
  Column membership uses a modest outset plus a center/majority-width
  rule, not the old ±0.5 pt band.
- Headline successful pushes: **20 → 58**. Every successful push
  reports `overflowInkOverlap=false`.
- Form-local content can be pushed inside a copy-on-write Form
  occurrence (`r23-form`). The r22 `push-blocked-by-form-context`
  overlap bin is **0**.

### Bounded-frame tightening (2)

- When a table cell, box, or background frame bounds the paragraph,
  retypeset first tightens tracking/word spacing, then shrinks font
  size down to a documented **85%** floor, instead of overflowing the
  frame.
- **24** headline rows detected a frame (16 background, 5 cell,
  3 box). **20** fit and no longer overflow. **4** still overflow at
  the floor (`push-blocked-by-bounded-frame`).
- Example: `digital-jp-5` p.8 overflow is a cell fit at sizeScale
  **0.86** (tracking/word 0.03 em), `overflowed=false`.

### Clip and form ink (3)

- Wraps that stay inside a proved rectangular source clip are re-laid
  or pushed there, rather than refused for any clip. The r22
  `push-blocked-by-clip-or-annotation` overlap bin is **0**.
- The 13 `zh-ojs-law` r22 refusals were not tight-frame overflows.
  FT8 is Source Han Serif CFF declared as CIDFontType2/FontFile2.
  Coverage now proves those outlines only when CID, GID, charset and
  CIDToGIDMap agree. All **13** are writable `retypeset` (zh-ojs-law
  headline 45/45). This does not claim they are overlap-free: several
  page-2/6 wraps still report overlap; page-8 overflow is a clean
  **16.08 pt** push.

### Emission and official 17030 (follow-up)

- Wrapping a show in `q/cm/Q` inside BT/ET resets the next
  consecutive show’s x in PDFium. Visible horizontal text is now
  shifted with a temporary, restored `Ts`; graphics still use a
  complete-span `cm` outside text objects.
- The official `arxiv-2611.17030-0-overflow` short edit already
  passed on `4e35ac9` because the planner stops at a gap that absorbs
  Δ (subtitle only, 15.94 pt). A longer email-chain export, which used
  to move the comma to the wrong x, now passes the unchanged official
  native/stream/0-px-outside-mask gate after the `Ts` fix.

### CJK weight

- When the source face is bold/heavy, CJK substitutes use official
  Noto Sans SC/JP/KR Bold. **26** headline rows pick
  `NotoSansSC-Bold.otf` (`zh-ctex-manual-0-same-length` is one).
  No JP/KR Bold rows appeared in this corpus.

## Totals vs r22

| | r22 headline | r23 `4e35ac9` | r23 final `59ae20d` | r23 old-definition |
|---|---:|---:|---:|---:|
| Succeeded without overlay | 1447/1514 (95.6%) | 1447/1514 (95.6%) | **1460/1514 (96.4%)** | 1281/1328 (96.5%) |
| Exact-tier | 655/1514 (43.3%) | 655/1514 (43.3%) | **655/1514 (43.3%)** | 644/1328 (48.5%) |
| in-place | 355 | 355 | 355 | 355 |
| fallback-font | 176 | 176 | 176 | 176 |
| substituted | 97 | 97 | 97 | 86 |
| reflowed | 27 | 27 | 27 | 27 |
| retypeset | 792 | 792 | 805 | 637 |
| unsupported | 67 | 67 | 54 | 47 |

Headline success **+0.8 pp** (the 13 `zh-ojs-law` wraps). Exact-tier
**unchanged**. Final wall 726.1 s (headline compute 563.0 s). The
standing ≥1 pp success bar was not the r23 stop rule; overlap was.

Headline unsupported, 54: no-text-layer 30, image-text 23,
`unsupported-unwritable` **1** (was 14). The remaining unwritable row
is still `arxiv-2611.17332` p.8 (form glyph order vs the UI address).

## Quality metric (headline retypeset, production)

These are producer fields from `report.json`, not a replay classifier.

| | r22 | r23 `4e35ac9` | r23 final |
|---|---:|---:|---:|
| Overflowed retypeset | 543 | 523 | 537 |
| Overlap defects | 411 | 318 | 326 |
| Overlap rate | 75.7% | 60.8% | **60.7%** |
| Successful pushes | 20 | 54 | 58 |
| Tighten absorbed (no overflow) | 0 | 20 | 20 |

Overlap rate **−15.0 pp** vs r22 (**−85** defect rows). The first r23
run did almost all of that (push + tighten + clip/form). The ink fix
then made 13 more wraps writable; eight of the new overflowed zh-ojs
rows still report overlap, which is why the final overflowed/overlap
counts ticked up slightly while the **rate** stayed ~60.7%.

Remaining overlap by `pushReason` (final vs r22):

| pushReason | r22 | r23 final | Δ |
|---|---:|---:|---:|
| `push-blocked-by-foreign-column-or-obstacle` | 258 | 199 | −59 |
| `push-blocked-by-fixed-or-foreign-obstacle` | 96 | 82 | −14 |
| `push-blocked-by-unpushable-ink` | 32 | 33 | +1 |
| `push-blocked-by-destination-overlap` | 8 | 8 | 0 |
| `push-blocked-by-bounded-frame` | 0 | 4 | +4 |
| `push-blocked-by-clip-or-annotation` | 13 | 0 | −13 |
| `push-blocked-by-form-context` | 4 | 0 | −4 |

Unchanged-line residual drift (push Δ excluded): measured on all
**805** retypeset rows; **50** (6.2%) have any residual > 0; max
**0.0305 pt**; p95 ~ 0.

## Official oracle (sampled 16)

Same saver-policy 16 as r22. **11/16 passed** (r22 was 10/16).

New pass: `arxiv-2611.17030-0-overflow` (claimed 15.94 pt subtitle
push; 0 px outside the existing mask). Still failing, same family as
r18–r22:

- `arxiv-2611.17030-5-same-length`, `arxiv-2611.17030-0-same-length`,
  `gsa-2-5-multi-line`, `gsa-1-4-same-length` — Poppler extracted-text
  order / whitespace.
- `gsa-17-195-same-length` — untouched whitespace font program.

`gsa-1-0-same-length` still passes. No per-row corpus-wide raster
oracle is inferred from these samples.

## PNG pairs

Under `test-artifacts/retypeset-r23/renders/` (gitignored):

- `arxiv-2611.17030-0-overflow-retypeset.pair.png` — overflow wrap;
  following subtitle/authors pushed 15.94 pt
- `zh-d2l-pytorch-0-longer-retypeset.pair.png` — wrapped `习`;
  “Release 2.0.0” pushed 29.74 pt
- `gsa-2-0-same-length-retypeset.pair.png` — 39.12 pt same-column push
- `digital-jp-5-8-overflow-retypeset.pair.png` — table-cell tighten at
  86% size, text stays in the cell
- `zh-ctex-manual-0-same-length-retypeset.pair.png` — CJK Bold
  (`NotoSansSC-Bold.otf`)
- `zh-ojs-law-8-overflow-retypeset.pair.png` — previously unwritable
  wrap; now retypeset with a 16.08 pt push, overlap false

## Commits (local, not pushed)

Feature: `df6577a` push/tighten, `d985b34` form, `6c748ef` clip,
`b958f31` oracle, `eac86b1` CJK Bold, `8c7fc45` Ts emission,
`cd56d22` misdeclared CFF ink. Merges into `feat/pdf-stage5`:
`34af2ae`, `6db6fae`, `bc41bb6`, `6441a3a`, `0882d6b`, plus
integration `4e35ac9`, then `b96c7c7` (emit) and `59ae20d` (ink).
This RESULTS file is the final r23 record.

## Open issues

- Exact-tier is still 43.3%; r23 did not target it.
- 60.7% of overflowed retypeset rows still report ink overlap. The
  dominant remainder is `foreign-column-or-obstacle` / `fixed-or-
  foreign-obstacle`. Some newly writable zh-ojs wraps are in that set.
- Four bounded frames still overflow at the 85% floor.
- `arxiv-2611.17332` p.8 paragraph order inside a form (the last
  headline unwritable row).
- Vertical Japanese is detect+refuse only; no Identity-V emission.
- Official 16: five long-standing Poppler / whitespace-font fails
  remain.
- Noto JP/KR Bold are bundled but unused in this corpus.
