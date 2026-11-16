# Opus Round 7 consult (read-only)

- Date: 16 Nov 2026, Europe/London
- Model: claude-opus-5-5
- Session: `cf6aff4f-3685-434e-9045-5e67ce32e267`
- Cost: $1.888
- Turns: 15
- Prompt: `CONSULT-OPUS-r7.md` (gitignored)
- Plan file written by Opus (repo untouched): `/home/box/.claude/plans/round-7-consult-frolicking-muffin.md`

## M0 census (run after the consult; use this, do not redo)

A production occupancy dump of all 71 unique r12 media-blocked pages (`FACTS-r7.md`, gitignored probes) found:

| class | pages | cause |
| --- | --- | --- |
| paint-only | 46 | a single `f` at operator 4: axis-aligned `re` equal to the media box (GSA tagged slide backdrops) |
| unplaced-only | 23 | unplaced shows with `graphics-effect-unsupported: stroked text (Tr 1/2)` stored as media because `occupancy.ts` treats any `s.reason` as unbounding |
| image-only | 2 | `gsa-17` p.195 and p.292: full-page 2550×3300 DeviceRGB JPEG `Im0` |

Zero of those pages were blocked only by unmeasured CFF/Type1/Type3 glyph bounds. CID TrueType `inkBox` already measures the used glyphs. Implementation should start at stroked-text occupancy and backdrop fills (Opus S1 + the census), then column capacity (Opus §5). A new CFF interpreter is not required to move this residual. The gsa-17 JPEG stays conservative. Opus's remaining soundness notes (fontkit seac, header bbox, PDFium veto-only, clip-bounded unknowns) still apply if those paths are touched.

---

# Round 7 consult: per-glyph ink bounds and column-proven one-line capacity

Read-only review of HEAD `e3056da`. Nothing in the repo was edited.

## 0. Verdict

The direction is right: measured ink stays the authority, native data can only veto, and unknown ink keeps blocking. Three corrections:

1. **Start with a blocker census (M0), not measurement.** A page is blocked if *any* occupant contains the MediaBox (`occupancy.ts:103`), and that can be a glyph, a scene op, an annotation or an unplaced show. Several of the most likely causes for the tagged and Chinese rows have nothing to do with charstring parsing:
   - code→GID lookup only covers codes that have a ToUnicode entry;
   - non-`.001` Type3 fonts are dropped before their proof can run;
   - full-page backdrops;
   - one stray unmeasured glyph blocks the whole page.

   We don't know the mix, so the first milestone counts it.
2. **fontkit `cbox` is not enough, and in two places it is unsound** (§3): it skips seac and reads the TrueType header bbox. A proof engine has to fail closed. Write our own CFF Type2 interpreter (with a raw DICT reader for matrices) and keep fontkit as a differential test oracle.
3. **Column-proven capacity helps only short lines.** If most of the 68 LaTeX one-line groups are fragments of justified lines (split by `sourceGapBefore` around math or excluded glyphs), their end is already at the column edge, so the extra capacity is about 0. M0 should measure that slack before M3 is built.

---

## 1. Failure modes in today's hull / occupancy path

### 1a. Why glyphs become `unknown` + media (page blocked)

| # | Where | What happens | Who it hits |
|---|---|---|---|
| G1 | `reflowInk.ts:161`, `coverage.ts:107-130` | `glyphIds` is filled only while iterating `unicodeMap` (ToUnicode). A shown code with no ToUnicode entry has no GID, so `fallback()` runs, which is `undefined` for CFF. The glyph becomes unknown and blocks the page. Ink does not depend on Unicode, but the lookup is gated on it. | Tagged / CJK with partial ToUnicode (ligatures, PUA, punctuation) |
| G2 | `coverage.ts:90` | A Type0 font with no ToUnicode throws `missing ToUnicode for CID font`, so the whole font has no GIDs. | CJK, opaque CID fonts |
| G3 | `coverage.ts:98` | Predefined CMaps (`UniGB-UCS2-H`, `GBK-EUC-H`, `UniJIS-UCS2-H`, `90ms-RKSJ-H`, …) throw, so there are no GIDs. | Chinese / Japanese |
| G4 | `reflowInk.ts:132` and `occupancy.ts:71` | Any PDF-level `/FontMatrix` other than `.001` causes a `continue`. Only Type3 fonts have one, so **every Type3 font with a non-`.001` matrix never reaches `proveType3Glyph`**, even though that proof already validates scale matrices itself. | Word Type3 (non-embeddable fonts), printer-driver PDFs, matplotlib |
| G5 | `type3Proof.ts:28,39` | Flipped matrices (`m[3]<0`) are refused, and so are empty CharProcs whose label is not whitespace. | dvips / old TeX Type3 |
| G6 | `cffHulls.ts:205-208` | Any FD FontMatrix that is not the default makes the whole font unmeasured. fontkit also *fills in defaults*, so "absent" and "explicit `.001`" look the same. The top-only matrix is right only if FreeType composes top and FD the way the code assumes. A top `[1 0 0 1 0 0]` with an FD `.001` gives a hull **1000× too large**: conservative, but it covers the page. | CID-keyed CFF (InDesign, Adobe CJK fonts, Source Han) |
| G7 | `type1CharString.ts:63-75` | Type1 `seac` sets `hullKnown=false`, so the glyph is unmeasured and blocks the page. | Accented Latin in Type1 (European LaTeX) |
| G8 | `occupancy.ts:85,98`, `evidence:44` | One unmeasured glyph anywhere on the page (a logo, a bullet, a page number) blocks every paragraph. The current clip is ignored, although a clip is a hard bound on glyph ink. | All families |
| G9 | `textState` (vertical → unplaced), `occupancy.ts:81` | Vertical writing (Identity-V / WMode 1) is unplaced. With no usable declared box it becomes media. | Japanese vertical, CJK |
| G10 | `reflowInk.ts:149` | Non-embedded font with no FontBBox: no ink, so media. | Chinese (SimSun etc. not embedded) |

### 1b. Media from the scene, not from glyphs (`reflowScene.ts`)

- **S1: full-page paint below the text.** A white `re f` or a background image painted *before* the text contains media, so the page is blocked. Removing or moving a glyph above a z-lower backdrop only shows or covers the backdrop, which is exactly the source render. Today that never counts as free space. `SceneObstacle` already has a `stationary-backdrop` kind; occupancy doesn't use it.
- **S2: other ops that fall back to the page clip.** `sh`, any operator not in `inert` (check `ID`/`EI` tokenization), `Do` of a missing or non-stream XObject, a non-finite `cm`, a `Q` underflow (`:33`).
- **S3: full-page Form XObjects** (common in InDesign and in imposed or templated pages): bounded by their BBox, which *is* the page.
- **S4: annotations with no usable `/Rect`** (`:79`).

### 1c. Soundness holes (under-bounds, P0/P1) to fix while touching this

- **P0: fontkit CFF ignores `endchar` seac** (no seac in its interpreter; `endchar` only checks width). A seac glyph's path comes out empty, `cffHulls.ts:226` returns a **zero box**, and the glyph adds **no ink occupant**. The placement box catches some collisions; a descender from the line above landing on the accent is not caught. If the glyph moves, its new ink is missing from the mask (the raster oracle should catch that, but only late). Distiller-converted CFF keeps seac.
- **P0: fontkit is lenient in general.** Unknown or malformed charstring ops are skipped silently, giving a partial path and a *smaller* hull. "Empty path ⇒ no ink" (`cffHulls.ts:226`, `program.ts:139`) is only valid when the interpreter is known to have run the whole charstring.
- **P1: TrueType `cbox` is the glyf header bbox** (fontkit `TTFGlyph._getCBox` decodes only `GlyfHeader`). It is declared, not computed. Stale or zeroed headers from bad subsetters, and composite headers, can be smaller than the outline.
- **P1: "tricky" TrueType fonts** (MingLiU/PMingLiU, DFKai-SB and other DynaLab CJK faces). FreeType *forces* bytecode hinting for them, and the unhinted outline is not what PDFium paints.
- **P1: a non-embedded font's declared FontBBox** (`reflowInk.ts:136-142`) does not bound the *substitute* font PDFium draws (synthetic bold, wider faces). Treat it as unmeasured, or accept it only with the native veto (M2). This may increase blocking slightly. It is a correctness fix, not a regression.
- **P2: CFF2 / variable fonts.** An OTF with a `CFF2` table goes down the TrueType `inkBox` path (`cff:false`) using `unitsPerEm`, and `isCffProgram` only knows `CFF `. Refuse these explicitly.

---

## 2. Critique of the proposed direction

1. **Per-glyph measurement:** agreed, with three conditions.
   - Every ink proof is a *complete-execution* proof. Any unknown op, overflow, unresolved subr, seac in a CID font, or unproved matrix leaves the glyph unmeasured, never "empty".
   - Matrices are read from **raw DICT bytes**, so that presence is known, not fontkit's defaulted values.
   - code→GID becomes a font-level map over **every shown code**, separate from ToUnicode (G1/G2).
2. **PDFium as veto only:** agreed. The precise rule:
   - native box ⊆ analytic box ⊕ ε (ε = 0.01 pt + 1e-3·size), or the page refuses with `ink-veto`, and the case becomes a fixture.
   - **Never enlarge from the native box.** The only legal fix is a *named analytic rule* (for example "substitute font synthetic bold adds stroke w"). The native box is then re-checked against the enlarged analytic box. The native box never sets a parameter.
   - Practical notes:
     - `reach.rs:259` records that pdfium-render 0.9.4's wasm bridge passes the `FPDFText_GetCharBox` out-pointers in the wrong order. Bind it yourself, or start with the coarser `FPDFPageObj_GetBounds` per text object, which checks against the union of that object's analytic boxes with no char-index matching.
     - PDFium's text page drops or merges characters (fake-bold duplicates, generated spaces). So: a moved glyph without native evidence refuses; a stationary glyph without native evidence is simply not vetoed.
3. **Unmeasurable glyphs stay conservative:** agreed, but **bound them by the current clip, not by media** (G8). The clip is a hard PDF bound. `reflowScene` already tracks it; export it per op. `pageBlocked` then fires only if that clip contains media.
4. **Column capacity:** agreed in principle. §5 tightens "same column" and adds contiguity. Gate it on M0's slack numbers.

Missing from the proposal: **z-ordered backdrops (S1)**. Without them, measurement alone cannot unblock pages with a full-page fill under the text.

---

## 3. Is fontkit `cbox` enough?

**No.** Use fontkit as a test oracle, not as the proof engine.

| Need | fontkit | Decision |
|---|---|---|
| Type2 core ops, subrs/gsubrs with bias, hintmask/cntrmask, flex/hflex/hflex1/flex1 | Yes | Reimplement anyway; it is cheap once the interpreter exists |
| `endchar` seac (base + accent via StandardEncoding → charset) | **No** (P0) | Must implement; refuse seac inside CID fonts |
| Fail closed on unknown/deprecated ops (`callothersubr`, `random`, `put`/`get`, …), stack > 48, subr depth > 10 | No (lenient) | Must implement |
| FDSelect 0/3 → per-FD Private/Subrs | Yes (`fdForGlyph`) | Ours, so the FD index is also known for the matrix |
| Top / FD FontMatrix with presence | Defaults hide presence | Raw DICT reader (op 12 7) |
| CFF2 (blend, vsindex, VariationStore) | Partial | Refuse for now |
| TrueType outline bounds | Header bbox only | ink = header bbox ∪ control hull of decoded unhinted points (composites with their transforms); refuse point-matching composites (`ARGS_ARE_XY_VALUES=0`), `fvar`/`gvar`, and the FreeType tricky list |

The effective CID matrix must reproduce FreeType's `cff_subfont_load` composition (top ∘ FD, with its units-per-em normalisation), because PDFium renders through FreeType. Accept only axis-aligned positive scales. Prove it with fixtures (§7) and the M2 veto, not by reading the spec alone.

**Where it lives:** keep it in TypeScript under `src/pdf/export/fontCoverage/`, next to the existing fail-closed Type1 interpreter (`type1CharString.ts`, `type1OtherSubrs.ts`). Proof records (`GlyphIdentity`, `programHash`) are already in TS. Suggested files: `cffIndex.ts` (INDEX/DICT), `cffMatrix.ts`, `cffCharString.ts` (~300 lines, Type2 interpreter), `glyphInk.ts` (a single `GlyphInkProof = {box, complete:true, matrix, fd?, identity}` per format). Each file must stay under the 5,000-token hook. A Rust `skrifa`/`ttf-parser` port would be a second implementation of the same rules; use it as a test oracle at most.

---

## 4. Recommended design (0 pixels outside the region)

```text
code ──(font-level codeToGid, all shown codes; Identity-H/V, embedded CMap,
        CIDToGIDMap, CFF charset; no ToUnicode dependency)──▶ gid
gid ──(format interpreter, complete execution or refuse)──▶ glyph-space control hull
hull ──(proved effective matrix: CFF top∘FD | Type1 .001 | TT 1/upem | Type3 m)──▶ text-space box
box ──(TextTrace linear × size, existing resolver)──▶ user-space ink, dilated by guardPt
        └─ M2: native box ⊆ analytic ⊕ ε, else refuse (never enlarge)
unmeasured ──▶ occupant = current clip ∩ media (page-blocked only if clip ⊇ media)
scene ──▶ solid full-crop fill painted before every owned/destination op ⇒ 'backdrop'
          (not an obstacle, not page-blocking); images/forms/shadings stay obstacles
```

Invariants that do not change:
- Analytic occupancy is the only thing that grants space.
- The mask stays `old ∪ new` dilated ink of the moved and replaced glyphs, fixed before compilation (`glyphRegion.ts`).
- The raster oracle still requires 0 changed pixels outside the mask.
- Moved glyphs still need an embedded font, Unicode and `paragraphMember` status.

Backdrop proof (S1). All of the following must hold:
- the operator is `re`+`f`/`f*`/`F`, or a path whose bbox ⊇ crop;
- the fill colour space is not a Pattern;
- the ExtGState has no SMask, and BM is Normal or absent;
- its `paintOp` is lower than every owned op *and* every op that receives a destination glyph;
- it is not later re-clipped into a region-dependent shape.

Images, forms and `sh` at full page stay blocking; text over a full-page picture is still a layout hazard.

---

## 5. Column-proven one-line capacity (LaTeX)

For a target group with exactly one line, after `buildVisualGroups`:

1. **Witness lines.** Lines in *other* groups, with no `refusal`, whose style passes `paragraphMember(…, target style)` (same size, frame and scope) and whose left lies within `leftTolerance` of a common x₀. The target's left must be in [x₀ − tol, x₀ + 2.5 em] to allow `\parindent`.
2. **Edge R.** An end value reached, within 0.25 pt, by lines from **≥2 distinct groups** (all of one group's lines count as one witness). Take the largest such cluster. Ragged-right columns have none, so they refuse.
3. **Contiguity.**
   - The nearest witness is within 4 pitches above or below the target.
   - The strip x ∈ [x₀, R], between the target band and that witness, holds only text lines whose left is x₀ (± indent) and whose end is ≤ R + tol. Any image, form, paint, annotation or unknown occupant there refuses.
   - This rules out side-by-side minipages and full-width floats.
4. **Grant.** `capacityRight = max(own end, R)`, then the existing `capVisualSlots` occupancy cap. R must also lie inside crop and clip. Nothing past R: no gutter or margin.
5. **Diagnostics.** Record `slack = R − end` and whether the group starts with `sourceGapBefore`.

What it unlocks is mostly **in-line suffix shift** for short lines (last lines of paragraphs, one-line paragraphs, list items). Growing downward from a one-line group is usually blocked by the next line anyway.

Fragments split by inline math (`sourceGapBefore`) end at R already, so they gain nothing here. Their real fix is to treat measured-but-excluded glyphs as stationary in-line obstacles instead of group boundaries, which is a separate change outside this round.

---

## 6. Estimates (these are estimates; M0 replaces them with counts)

| Bucket | Rows | Clears the page block (M1+M2) | Likely accepted afterwards | Stays refused |
|---|---|---|---|---|
| Tagged | 153 | ~60–95 (GID decoupling, Type3 matrix, seac, clip-local unknowns, backdrops) | ~25–50 | non-embedded fonts with no bbox, full-page forms/images, `sh`/unknown ops at page clip, annotations with no Rect; later gates (boundary, capacity) |
| Chinese | 50 | ~15–30 | ~8–18 | predefined CMaps (G3) unless CMap tables are bundled, non-embedded SimSun etc., tricky fonts, scanned page + Tr 3 OCR text |
| Japanese | 8 | ~2–4 (horizontal only) | ~1–3 | vertical writing (G9) |
| InDesign | 3 | ~1–2 (FD matrix, backdrop) | 0–1 | full-page Form XObjects (no form recursion) |
| LaTeX one-line | 68 | capacity gate: ~15–35, depending on the share of short lines vs fragments | ~10–25 | fragments (slack ≈ 0), ragged-right, headings, single-witness columns |

Overall the realistic corpus gain is a few percentage points of acceptance, not a jump. Several unblocked pages will hit the next gate.

---

## 7. Milestones

### M0: blocker census (no behaviour change; about a day)
- Add `reason` to `Occupant`, kept out of the occupancy hash. Values:
  - glyph: `no-program`, `no-gid`, `coverage:<msg>`, `cff-fd-matrix`, `type3-skip`, `type3:<failure>`, `seac`, `hull-throw`;
  - scene: `op:<name>`, `do-unresolved`, `q-underflow`, `fullpage-fill-before`, `fullpage-fill-after`, `fullpage-form`, `fullpage-image`;
  - `annot-no-rect`, `unplaced:vertical`, `unplaced:no-bbox`.
- The corpus report counts *every* blocker per page and the **sole-blocker class** (pages that unblock if exactly one class is fixed).
- LaTeX rows: `slack`, `sourceGapBefore`, number of witnesses.
- Go/no-go: order M1's sub-items by sole-blocker counts.

### M1: fail-closed measurement
1. Font-level `codeToGid` over all shown codes, independent of ToUnicode (G1/G2). Ink lookup uses it; encodability keeps using `coverage`.
2. Remove the Type3 early-out at `reflowInk.ts:132`; `proveType3Glyph` already validates the matrix (G4). Keep the declared-box skip in `occupancy.ts:71`.
3. CFF: raw DICT/INDEX reader, effective top∘FD matrix with presence (G6), own Type2 interpreter with seac (P0) and fail-closed rules. "Empty" only after complete execution. Explicit refusal of CFF2. fontkit stays in tests as a differential oracle for non-seac glyphs.
4. TrueType: header bbox ∪ decoded-point hull, plus refusals for point-matching composites, `fvar`, and tricky fonts (P1).
5. Type1 seac hull = base hull ∪ accent hull translated by the seac offset, following FreeType `t1_decoder` (G7).
6. Unmeasured glyphs and unplaced shows are bounded by the current clip, not media (G8).
7. Non-embedded declared FontBBox no longer counts as ink until M2 can veto it (P1).

Gates: `bun run verify`. Add `bun run test:core` if anything in `crates/` changes.

### M2: native veto + backdrops
1. Native per-glyph or per-text-object bounds through `appPdfEngine` (fix or bypass the `FPDFText_GetCharBox` wasm pointer order). Rule: native ⊆ analytic ⊕ ε, else refuse. Moved glyphs need native evidence. Never enlarge.
2. Restore the non-embedded FontBBox envelope only behind that veto.
3. `backdrop` occupant kind (S1), excluded from `pageBlocked` and from ink checks.

### M3: column-proven one-line capacity
Implement §5 in `regionProof/visualGroups.ts` plus the cap in `reflowEvidence.ts`. Ship only if M0's slack data shows short lines are a meaningful share.

---

## 8. Fixtures that must exist before a corpus run (write them first)

Measurement (unit tests plus a native probe comparing against PDFium boxes):
1. CFF non-CID glyph with seac (Distiller-style): hull = base ∪ accent; current fontkit gives an empty path. **Red today.**
2. CID-keyed CFF, top `[1 0 0 1 0 0]` + FD `.001` explicit; and top absent + FD absent. Effective matrix and box match PDFium's char box within ε.
3. CID-keyed CFF with two FDs carrying different Private Subrs, glyph using `callsubr` from FD 1. Correct hull.
4. Charstring with an unknown op, overflow, or truncated subr: unmeasured, never empty.
5. Type0 Identity-H where shown codes are missing from ToUnicode: ink measured, glyph stays opaque (not movable). **Red today.**
6. Type3 with FontMatrix `[0.01 0 0 0.01 0 0]`: measured. **Red today.** Flipped matrix: refused.
7. Type1 seac glyph: measured, equal to the native box. **Red today.**
8. TrueType glyph whose glyf header bbox is smaller than its points: box = point hull. Composite with a scaled component: covered.
9. Tricky-font name (for example `MingLiU`): unmeasured.
10. CFF2 OTF program: refused.
11. Non-embedded font with FontBBox: unmeasured in M1, allowed in M2 only behind the veto.
12. Unmeasured glyph inside a `W n` clip box: occupant = clip, page not blocked. The same glyph with no clip: page blocked.
13. Native veto: analytic box shrunk by test injection, so native sticks out and the page refuses with `ink-veto`.

Scene:
14. White full-page `re f` before BT: backdrop, edit proceeds, 0 pixels outside the mask.
15. The same fill *after* the text: blocked.
16. Full-page image or Form XObject before the text: still blocked.
17. Pattern-filled full-page rect: blocked.

Column capacity:
18. Two-column LaTeX page: a short last line borrows R shared by ≥2 paragraphs in its column; never the gutter.
19. Only one witness group: refused.
20. Side-by-side minipages sharing x₀ with the main text: refused by contiguity.
21. Full-width float between the target and its witnesses: refused.
22. Ragged-right column: refused.
23. Justified fragment (slack 0): no change in outcome.

Existing `OPUS-reflow-consult.md` §5 fixtures 1–11 must stay green. Every new refusal class needs an E2E artifact under `test-artifacts/reflow-r7/` (native render + mask diff), produced by the documented probe command.

---

## Verification for the eventual implementation
- Unit: fixtures above, run with `bun run test`. Red-first for 1, 5, 6, 7 and 12.
- Native: the probe compares analytic and PDFium boxes on fixtures 1–3, 6–8 (web wasm and desktop native).
- Corpus: re-run r12 → r13. Report the blocker census delta and the accepted-row delta. Any `ink-veto` becomes a fixture before the next run.
- `bun run verify`, plus `bun run test:core` if the engine binding changes.
