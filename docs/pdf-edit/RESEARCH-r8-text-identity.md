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
