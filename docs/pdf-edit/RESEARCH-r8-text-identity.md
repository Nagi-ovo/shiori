# Round 8 research summary — proven text identity

Full report: `/workspace/research/pdf-text-identity/REPORT.md` (16 Nov 2026, Europe/London). Worktree at the commit that added this file; r13 baseline was `9cae0d5`, 500/1328 = 37.7%.

## Diagnosis

The r13 membership residual (118 `no-member-lines` + 47 `target-not-in-member-lines`, all GSA tagged/Word) is **not** missing published CJK CMaps and **not** BT-based grouping. `reflowEvidence` already groups visually; it drops glyphs whose `unicodeByCode` is empty or contains U+FFFD. Classifier/overflow planning uses `resolveRunFonts`, which often has **zero** labels on pages where `substituteSourceFonts` already has a usable label for every used glyph.

Two mechanisms:

1. **Office ToUnicode dialect.** Simple WinAnsi TrueType fonts ship a 2-byte `<0000> <FFFF>` codespace with 1-byte `bfchar` sources (`<20> <0020>`, …). `runToUnicode(program, 1)` applies the font width to codespace hex, throws, returns null. `recoverRunUnicode` then aborts the whole cascade (Encoding+AGL, cmap) in its `catch`. Example: `gsa-10` p.142, 705/705 glyphs unlabeled in `resolveRunFonts`, 0 unlabeled in `substituteSourceFonts`.
2. **Non-embedded WinAnsi.** `gsa-1` p.2 Times/Arial have a published Encoding and no ToUnicode. Coverage refuses `font program not embedded`. Substitution still installs AGL labels; `resolveRunFonts` does not. Those fonts must stay out of the in-place move set.

The 68 LaTeX no-row-capacity rows are a separate residual and are not in scope.

## What other tools do (learned, not copied)

- **pdf.js** (Apache): §9.10.2 cascade; ToUnicode, then Encoding+AGL (`_simpleFontToUnicode`, `uni`/`u` names); Adobe-*-UCS2 for known ROS; codespaces stored by their own byte width. `IdentityToUnicodeMap` is a viewer fallback — not a Shiori proof. Do not adopt `Gxx`/`Cdd` name guesses.
- **PDFium** (BSD): ToUnicode, `UnicodeFromAdobeName`, CID collection maps, `CPDF_TextPage` line geometry after Unicode is assigned.
- **MuPDF** (AGPL, described only): glyph-name / AGL / system CMaps; stext groups by baseline distance, not BT. CID/GID-as-Unicode flags are extraction-only — refuse them.
- **poppler** (GPL, described only): ToUnicode then encoding+AGL and collection caches; Word/Line/Block/Flow from geometry.
- **US 7,636,885 B2** (PDFlib, not Adobe): per-code cascade; a missing or wrong ToUnicode must not prevent later proven sources.

## Implement (Phase B)

1. Parse ToUnicode codespaces by their own hex width; keep font `bytesPerCode` for `bfchar` sources.
2. If surgical ToUnicode is unparsable, continue the existing recovery cascade instead of aborting.
3. Install Encoding+AGL **source labels** for non-embedded simple fonts (not move-set / `canEncode`).

Recovered identity must stay proven (explicit ToUnicode, published Encoding+AGL, cmap/`post` with presence proof, or a known ROS UCS2 table). Never guess. In-place replacement still requires a ToUnicode proof. 0 pixels outside the proved region. Then corpus r14.

Do not implement shape-hash, CID-as-Unicode, PUA bullet relabeling, or LaTeX capacity in this round.

## Phase B (implemented) and corpus r14

Implemented at `28525e9` (T1–T3) and `38f3322` (Grok P1: shared `codeInCodespace` in `fontCoverage/codespace.ts` for `parseCMap` and `runToUnicode`). Grok re-review of `38f3322` (session `01a1e4da-52c6-7383-9265-490d99dc6470`) was **ready**, no P0/P1. Residual P2s (`substituteSource` overwriting recovered maps; last-wins `parseCMap` vs surgical reject) were left alone.

Corpus r14 at `38f3322`, 16 Nov 2026 Europe/London: **551/1328 = 41.5%** vs r13 **500/1328 = 37.7%** (**+51 rows, +3.8pp**). No previously accepted row was lost. Reflowed **1 → 5**. Membership gates cleared: `no-member-lines` 118→0, `target-not-in-member-lines` 47→0.

| Category | r13 accepted | r14 accepted |
|---|---:|---:|
| tagged | 178/467 (38.1%), all substitutions | 228/467 (48.8%): 113 in-place, 82 fallback, 30 subst, 3 reflowed |
| word | 18/33 (54.5%), all substitutions | 19/33 (57.6%): 11 in-place, 2 fallback, 5 subst, 1 reflowed |
| chinese / latex / japanese / indesign / scanned-ocr | unchanged rates | indesign mix only: more in-place/fallback, fewer subst |

The 51 new accepts are tagged (50) and word (1). 167 previously substituted Office rows moved to in-place, fallback, or reflow once ToUnicode became a real encode proof.

LaTeX no-row-capacity is unchanged (still the bulk of 108 latex `region-unproved`). New tagged residuals after membership: `region-unproved` (including no witnessed column edge), `missing-line-anchor` (28), `target-state` (39 tagged).

Oracle exit 1, 5 sample fails, **none with pixels outside the proved box/mask**. Pre-existing class: `gsa-17-195-same-length` (whitespace font program), `gsa-1-4-same-length` and `gsa-2-2-missing-glyph` / `gsa-2-5-multi-line` (Poppler text). New class: three GSA wrap reflows fail `raster veto: backdrop dependency revision differs` when the oracle reloads the saved before-PDF (`runResourceStamp` ≠ plan-time `dependencyHash`); source hash and proved backdrop ops still match, and a reconstructed backdrop reference measures **0 pixels outside box and mask** (`gsa-11/15/8` p.0 multi-line; `gsa-2` p.5 and `zh-d2l-pytorch` p.597 also 0 outside). PNG pairs: `test-artifacts/reflow-r14/renders/*-{before,after,pair}.png`.

Gain ≥ 1pp, so this line of work does not wrap on the standing rule. Next holes are occupancy/capacity and the oracle resource-stamp mismatch, not identity for the old 165-row pool.
