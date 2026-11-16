# Corpus r15 results (Round 9, stamp + cheap tagged holes)

HEAD `a8297ea` on `feat/pdf-stage5`. Ran `run-corpus-r15.sh`. Cache reused; r14 snapshot left intact.

## Totals vs r14 (41.5%)

| | r14 | r15 | delta |
|---|---:|---:|---:|
| Accepted (in-place + fallback-font + substituted + reflowed) | 551/1328 (41.5%) | 553/1328 (41.6%) | +2 (+0.15pp) |
| in-place | 290 | 292 | +2 |
| fallback-font | 206 | 206 | 0 |
| substituted | 50 | 50 | 0 |
| reflowed | 5 | 5 | 0 |
| overlay | 777 | 775 | -2 |

The +2 are InDesign `gsa-17` p.390 `shorter` and `substring` (overlapping trailing-space `ambiguous-match` fix). The other five p.390 kinds left `ambiguous-match` but overflowed.

## Per category

- indesign 15/35 → 17/35 (+2)
- tagged 228/467, latex 97/275, chinese 149/314, japanese 43/165, word 19/33, scanned-ocr 0/39 unchanged

## Residual movement (overflow evidence)

- `missing-line-anchor` 28 → **0**. All 28 reach region proofs; 27 then die at `region-unproved` / analytic no-row-capacity (most `slack:0, witnessGroups:0`); 1 at `Unsupported short-region show, scope or saved Tlm`.
- InDesign `target-state` 3 → **0** (Lang+MCID). Those rows then hit `region-unproved` / media-sized form occupants.
- Tagged `target-state` 39 unchanged (Optional Content / Artifact shows; left refused).
- `ambiguous-match` 7 → **0**.
- `graphics-effect-unsupported` 118 unchanged (Tr 1/2 and invisible OCR; left refused).
- LaTeX `region-unproved` 108 unchanged, including the 68 no-row-capacity class.

This confirms Opus: clearing identity and anchor gates is not enough while `capVisualSlots` still zeros the row. Capacity M1 is the next implementation (in flight).

## Oracle (16 samples)

Passed 12. Failed 4, all **pre-existing from r14**:

- `gsa-17-195-same-length`: untouched whitespace font program changed
- `gsa-2-5-multi-line`, `gsa-1-4-same-length`, `gsa-2-2-missing-glyph`: Poppler extracted text mismatch

The r14 false fails `raster veto: backdrop dependency revision differs` on `gsa-11-0-multi-line` (and the other stamp-mismatch reflows) **now pass**. Script exit status 1 is those four pre-existing fails.

## PNG pairs

`test-artifacts/reflow-r15/renders/` (gitignored):

- `gsa-11-0-multi-line-reflowed.{before,after,pair}.png`
- `gsa-15-0-multi-line-reflowed.{before,after,pair}.png`
- `gsa-2-5-multi-line-reflowed.{before,after,pair}.png`
- `gsa-8-0-multi-line-reflowed.{before,after,pair}.png`
- `zh-d2l-pytorch-597-overflow-reflowed.{before,after,pair}.png`

The two new in-place accepts were not saved as corpus samples (an earlier `gsa-17` in-place sample already existed).

## Commits (no push)

- `51c4852` Fingerprint resource revisions by content, not object IDs
- `a8297ea` Prove inherited Artifact Tm anchors and close cheap tagged holes
