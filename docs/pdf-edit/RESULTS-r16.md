# Corpus r16 results (Round 9, row-local occupancy + joinless stroke bounds)

HEAD `eda8ea4` on `feat/pdf-stage5`. Ran `run-corpus-r16.sh`. Cache reused; r14 and r15 snapshots left intact.

Grok read-only review of M1 found no P0/P1. `resourceStamp.ts`, the raster veto, `validTrace` / show-scope, OC/Artifact show eligibility, and Tr 1/2 refusals were unchanged.

## Totals vs r15 (41.6%)

| | r15 | r16 | delta |
|---|---:|---:|---:|
| Accepted (in-place + fallback-font + substituted + reflowed) | 553/1328 (41.6%) | 576/1328 (43.4%) | +23 (+1.73pp) |
| in-place | 292 | 303 | +11 |
| fallback-font | 206 | 206 | 0 |
| substituted | 50 | 61 | +11 |
| reflowed | 5 | 6 | +1 |
| overlay | 775 | 752 | -23 |

No file declined. All 23 new accepts were r15 `overflow` rows whose evidence had been `Analytic occupancy leaves no row capacity`.

The new reflow is tagged `gsa-7` p.24 `longer` (wrap; not a `rowLocal` proof). The other 22 are in-place or substituted once the observed row slot was restored.

Three other former overflows moved to `unsupported-state` (`gsa-6` p.28 `multi-line`; `zh-hans-law` p.9 `overflow` and `multi-line`). They are not accept losses.

## Per category

- tagged 228/467 (48.8%) → 247/467 (52.9%) (+19): in-place 113→120, substituted 30→41, reflowed 3→4
- chinese 149/314 (47.5%) → 153/314 (48.7%) (+4): all in-place on `zh-hans-law` p.4 and p.9 (`same-length`, `cjk`)
- indesign 17/35, latex 97/275 (35.3%), japanese 43/165, word 19/33, scanned-ocr 0/39 unchanged

## Residual movement (overflow evidence)

- `no-region-proof` 358 → 175 (−183). Former no-row-capacity class 217 → 10 remaining (`latex` 68→6, `tagged` 129→3, `chinese` 19→0, `word` 1 unchanged).
- Those 207 cleared occupancy rows went to: 23 accepted; `grow-down-space-not-proved` 16→75; `layout-refused` 8→38; `encode-failed` 26→69 (latex is mostly `type1-ps-unsupported`); `plan-stream-reflow-null-after-layout-ok` 2→24; plus a few `selection-not-in-proof` / `source-text-mismatch` / `unsupported-state`.
- New row-local fail-closed residues: tagged `Row-local occupancy unproved: Missing measured embedded source row` 20; japanese `Interleaved unowned same-baseline placement` 4 (those four were r15 `selection-not-in-proof` on `digital-jp-5`, not accepts).
- Tagged `target-state` 39 unchanged (Optional Content / Artifact shows; left refused).
- `graphics-effect-unsupported` 118 unchanged (Tr 1/2 and invisible OCR; left refused).

LaTeX accepted count is unchanged: occupancy is no longer the main latex stopper, but the 68 former no-row-capacity rows now die later (`encode-failed` 36, `grow-down-space-not-proved` 20, `selection-not-in-proof` 6, still no-region-proof 6). Bounded TJ-kern tightening (Opus M2: floor ≥0.2 em, last glyph unmoved, only proved source TJ glue, inside the already-proved row box) is the next capacity step for the grow-down / slot-overflow cases. Encode-failed Type1/CFF rows are a separate gate.

## Oracle (16 samples)

Passed 12. Failed 4, all **pre-existing from r14/r15**:

- `gsa-17-195-same-length`: untouched whitespace font program changed
- `gsa-2-5-multi-line`, `gsa-1-4-same-length`, `gsa-2-2-missing-glyph`: Poppler extracted text mismatch

The same 16 sample names as r15. `gsa-11-0-multi-line` still passes (stamp fix holds). Script exit status 1 is those four pre-existing fails. No new P0.

## PNG pairs

New reflow only, under `test-artifacts/reflow-r16/renders/` (gitignored):

- `gsa-7-24-longer-reflowed.{before,after,pair}.png`

The five r15 reflows were unchanged and were not re-rendered. New in-place / substituted accepts were not saved as extra sample PNGs.

## Commits (no push)

- `51c4852` Fingerprint resource revisions by content, not object IDs
- `a8297ea` Prove inherited Artifact Tm anchors and close cheap tagged holes
- `2fb983f` Record Round 9 r15 results after the stamp and tagged-hole fixes
- `eda8ea4` Prove row-local occupancy and tighten joinless stroke bounds
