<!--
  Claude Opus consult (read-only / plan mode), 16 Nov 2026 Europe/London.
  Model: claude-opus-5-5. Session: 153d5d3d-b8aa-48a9-be72-ce48b9f0927e.
  Cost: $1.998. Turns: 21. Worktree: /workspace/shiori-wt/pdf-stage5 @ 335d36f.
  Account: jz5725@ic.ac.uk (Max). Ran in this worktree (same login as the owner's CLI).
  The body below is the consult text, unedited except for this header.
-->

# Stage 5 reflow region proof: design consult (read-only, `335d36f`)

## Summary

- **The 400-row diagnosis measures the wrong gate.** `scripts/pdf-corpus/classifyEvidence.ts:71` still requires the same BT and the tight `compatible()` check. Production `streamReflowEvidence` (`reflowEvidence.ts:82`) uses `paragraphMember()` and groups lines across BTs. So "no-same-bt-lines: 221" mostly means "the page has many BTs", which production already allows. The classifier also calls `detectParagraphRegion(input)` without `beforeFirst` (`classifyEvidence.ts:110`), so ≥3-line windows that open with a relative `Td` fail for a reason production never hits. Its `declaredBox` also skips the FontFile3/CFF refusals, so it under-counts pages that production blocks with a full-page obstacle. **We don't yet know why production refuses these 400 rows.**
- **Most of the proposal already exists in production.** Lines are grouped by baseline across BTs (`continuations`), and there is an analytic occupancy list (`reflowScene` + non-member glyphs + unplaced strips + glyphs outside the window). What actually blocks reflow, from reading the code:
  1. **Operator grammar.** The window allows only text-state, scope and show ops (`regionProof/operators.ts:121–149`). A `0 g 0 G`, `rg`, `cs/scn`, `cm` or `re W n` between sibling BTs fails with `Unsupported interleaved operator`. Word and many tagged producers emit colour per BT. This is likely a major tagged/Word blocker, but it isn't measured yet.
  2. **Right-edge proof.** `detectParagraphRegion` needs ≥2 non-final lines sharing a right edge within 1 pt (`regionProof.ts:99–103`), so ragged-right Word/tagged body text never proves. `shortStreamRegion` sets `right = ends[0]` (`reflowShortRegion.ts:28`): a one-line region has no room beyond its own end.
  3. **Box shape.** The proof is one union rectangle. Its height comes from the font's declared `ascentEm`/`descentEm` ±0.5 (`reflowEvidence.ts:149–152`), and lines outside the window become synthetic −0.2/+0.8 em boxes. One rectangle has to clear every neighbour, which is the "one-line box hits the next line" symptom. Any different-size glyph on the line (sub/superscript, math) sits inside that rectangle and kills it, even when it is in the unmoved prefix.
  4. **Page-wide obstacles.** A FontFile3/CFF glyph without a proven hull, or an unplaced show without a usable FontBBox, pushes `media` as an obstacle (`reflowEvidence.ts:50, 65, 78`). That refuses the whole page, which is correct.
  5. **Glyphs with no Unicode become obstacles inside the paragraph** (`reflowEvidence.ts:82`). The recurring `badUnicode=32` suggests one font's glyphs scattered through body text.
  6. **No leading for growth.** A Td-only line has no TL, so `proveDownwardSlot` refuses at `!(leadingPt>0)`.
- **There is a latent P1 in code that already ships.** `compileReflowPlan` emits the whole paragraph once, at `firstOp` (`reflowCompile.ts:91–106`). In the passing "Word tagged" test (`reflowRegion.test.ts:21`, MCIDs 0/1/2) every glyph from MCID 1 and 2 ends up inside MCID 0's BDC. Separately, `safetyHash` is the stream fingerprint (`reflowTrace.ts:26`), so membership never compares marked-content scope: an `/Artifact` header and `/P` body are "compatible". Allowing colour ops on top of the current compiler would also paint BT2's glyphs in BT1's colour.

**Recommendation:**
1. Keep proving operators and ownership per BT. Change what a proof is: a set of per-glyph swept ink areas checked against a per-item occupancy index, with capacity taken from a visual-paragraph group.
2. Rewrite sibling BTs in place: each glyph stays in its own operator slot.
3. Raster is a veto only. It never grants empty space.
4. First, make the classifier run the production gate.

---

## 1. Critique of "drop the same-paragraph proof, use a free-space map"

**What's sound**
- **Occupancy is the right core for the pixel constraint.** "0 pixels outside the region" plus "no new overlap" is a free-space question, not a typography question.
- **Group visual lines regardless of BT.** Correct, and `streamReflowEvidence` already does it on the read side.
- **Move sibling BTs of the same visual paragraph rather than treating them as obstacles.** Correct, and also already done for ≥3-line windows whose BTs hold only scope ops between them.
- **Take capacity from geometry, not from line endpoints alone.** This is the real unlock for ragged-right text and short lines.

**What's unsafe as stated**
1. **"Regardless of BT structure" can't extend to rewriting.** Geometry may choose which lines to group. Ownership still needs `proveOperators` (complete string items, Tm/Tlm agreement, TJ boundaries) per BT. Grouping without an operator proof would move bytes you can't rejoin (Tlm damage, a skipped `Td`).
2. **A raster map can't prove space is empty.** It misses:
   - white or background-coloured paint (a white `re f` painted after the text hides new text but looks empty);
   - Tr 3 OCR text, which is invisible but extracted;
   - annotation appearances that are off at render time;
   - ink smaller than a pixel;
   - PDFium's substitute glyphs for non-embedded fonts.

   It can only veto: ink where the analytic map says empty means refuse.
3. **The planner can't depend on a render.** It is synchronous pdf-lib/TS code shared with the web worker (fact 2). Raster belongs in the oracle and harness first.
4. **"Move neighbours with the reflow" must not become "push following paragraphs down".** That is unbounded region growth over unowned content. Growth stays limited to proven-empty bands below the owning group's last line.
5. **Grouping visual paragraphs by geometry alone can't rule out a table or column.** It needs pitch, style, left edge and column-overlap rules plus refusal on interleaved reading order. The spec's §4.5 warning stands.
6. **A free-space map doesn't fix Unicode or ink proofs.** badUnicode, unmeasured CFF and unplaced shows stay obstacles or refusals unless you add a separate opaque-glyph rule (milestone 4).

**What the gate is really failing on (by evidence, ranked)**

| Gate component | Affected rows (inferred) | Fixed by free space? |
|---|---|---|
| Classifier is stale (not a production gate) | all 221 "no-same-bt", part of the 142 | n/a: measure first |
| Operator grammar (colour/`cm`/clip between BTs) | tagged, Word, InDesign, part of the 33 operator rows | No; slot-preserving emission is needed |
| Right edge from line ends (ragged right; one line = own end) | tagged/Word bulk; 1-line LaTeX/CJK | **Yes**: group capacity |
| Single-rectangle region with declared ascent and em-box neighbours | LaTeX/CJK "short-geometry" | **Yes**: per-glyph region |
| Different-size glyph in the target line's rectangle | LaTeX `incompatible` in the thousands | Partly: only when it's in the unmoved prefix |
| Unicode-less glyph inside the paragraph | tagged `badUnicode` | Only with an opaque-glyph rule |
| Unmeasured CFF/FontFile3 → full-page obstacle | rows with `unmeasured=77` | No: font workstream |
| No TL on Td-only text for growth | LaTeX, CJK | Partly: group pitch |

---

## 2. Recommended design

### 2.1 Data structures (new, under `contentText/regionProof/`)

```ts
type OccupantKind = 'glyph'|'placement'|'paint'|'image'|'form'|'annot'|'unplaced'|'unknown';
type Occupant = {
  id: number; kind: OccupantKind; box: Rect;          // user-space, already guard-dilated
  owner?: GlyphKey;                                   // `${op}:${item}:${byte}` for text
  paintOp: number;                                    // stream order, for diagnostics
  measured: boolean;                                  // false → must stay an obstacle
};
type PageOccupancy = {
  items: Occupant[]; grid: Map<number, number[]>;     // 8 pt buckets
  pageBlocked: boolean;                               // any media-sized occupant
  hash: string;                                       // binds to sourceHash+dependencyHash
};
type ScopeKey = string;  // marked-content tag stack without MCID numbers,
                         // e.g. "P>Span" or "Artifact"; properties other than
                         // MCID refuse (OC/ActualText/Alt/E as today)
type VisualGroup = {
  lines: ParagraphLine[];               // existing type, in source order
  style: { em: number; linear: number[]; tz: number; scope: ScopeKey };
  pitchPt: number | null;               // observed baseline pitch, or explicit TL
  left: number; firstLeft: number;      // existing indent rules
  capacityRight: number;                // see 2.3
  column: { x0: number; x1: number };
};
type GlyphRegion = { old: Rect[]; new: Rect[]; mask: Rect[] }; // mask = old ∪ new, dilated
```

`RegionProof` keeps its shape (`lineSlots`, `owned`, `tjBoundaries`, hashes). Change `box: Rect` to a derived bound and add `mask: Rect[]` and `occupancyHash`. The oracle uses `mask`, which is fixed before compiling from the planned origins and never widened after seeing pixels.

### 2.2 Building occupancy: analytic is the authority, raster is a veto

Put this in one builder that `streamReflowEvidence` and the classifier both call:
- **Paint, images, forms and annotations** come from `reflowScene`, unchanged. Unknown → clip or page, as today.
- **Every placed glyph**, for each walk glyph:
  - Measured ink (`streamInkResolver`) dilated by the guard → `glyph`.
  - Its placement box (origin to advance, at that font's declared descent/ascent) → `placement`. This is used only for extraction-overlap checks, not as ink.
  - Unmeasured: keep today's FontBBox transform or `media`. FontFile3/CFF without a proven hull stays `media`.
- **Unplaced shows** keep the current full-width strip or `media`.
- **Guard:** dilate every ink box by `g = 0.5 pt + 1 device px at the oracle dpi` (144 dpi → 1 px = 0.5 pt, so g = 1.0 pt). Antialiasing touches any pixel the hull crosses, so two hulls must be ≥1 px apart to never share a pixel. Keep the existing 0.01 em ink clearance for tightened gaps.
- **Raster veto (milestone 3, oracle/harness only):** render the original page at 144 dpi through native PDFium. Any non-background pixel inside `mask` must lie inside the dilated hull of an owned glyph's *old* ink. Otherwise the plan is wrong (missed paint, substitute-font overhang): fail and file a fixture. Never treat white pixels as permission.
- **Non-embedded fonts in the owned or moved set:** refuse. A FontBBox envelope doesn't bound PDFium's substitute face. Revisit later with the raster veto as proof.

### 2.3 Grouping visual paragraphs, and capacity

Start from the existing `lines` builder (`reflowEvidence.ts:67–116`). Change membership so `safetyHash` is replaced by a per-show `ScopeKey` computed in `traceReflowSource` from the BDC/BMC stack. Then split `lines` into `VisualGroup`s, in source order, at the first of:
- a different `paragraphMember` style or a different `ScopeKey`;
- a baseline that isn't strictly descending;
- a pitch deviation beyond the §4.5 tolerance, which includes paragraph spacing;
- a left edge that violates flush/indent rules;
- no x-overlap with the previous line, or a source/geometry order inversion (column interleave) → refuse.

Grouping never jumps over a line in source order.

Capacity, per slot:
- `left`: today's flush/first-line/hanging rules.
- `right = min(capacityRight, first occupant in that slot's band to the right of the line start)`.
- `capacityRight` is the maximum observed line-end or ink-right over the group. With ≥2 lines this covers ragged right, because some line already reached that extent. A group with one line gets its own end, as today. Milestone 4 adds a column-proven right edge: ≥2 other groups in the same column and style, with no occupant between.
- Capacity never goes past what text in that column has already reached: no gutter or margin borrowing.
- Lift the current rule that the selected span must be in a window of ≥3 lines that share a right edge. Keep ≥2 lines for wrap and ≥1 for in-line suffix shift.

### 2.4 Proof obligations, run in order and failing closed

1. **Operators:** `proveOperators` over `[first owned op … last owned op]`, extended so that:
   - fill/stroke colour ops (`g G rg RG k K cs CS sc SC scn SCN`) are allowed between owned shows, because slot emission keeps each glyph under its original gstate;
   - `cm` is allowed only inside a `q…Q` that encloses whole BTs and keeps the linear part equal. Its translation goes into that slot's CTM.
   - Everything else still refuses: `re`/paths, `W`, `gs`, `Do`, `sh`, unowned `Tm`, quote ops, Tr ≠ 0, WMode 1.
2. **Ownership:** every string item of every line in the chosen window is owned. This is unchanged.
3. **Move set:** the glyphs whose origin changes under the solved layout. Every one of them must:
   - be a `paragraphMember` with measured ink;
   - have Unicode (or be a locked opaque cluster, milestone 4);
   - not be a non-embedded font.

   Non-member glyphs are allowed only when their origin is unchanged, which in practice means the prefix of the target line before the replacement.
4. **Occupancy:** for each moved or replaced glyph, the dilated *new* ink box intersects no `Occupant` except those owned by glyphs in the move set (their old positions are vacated). The *new* placement box intersects no unowned `placement`, which protects extraction.
5. **Mask:** `mask` is the union of dilated old and new ink of the move set plus replaced glyphs. It must lie inside crop and clip. The oracle requires zero changed pixels outside `mask`.
6. **Marked content:** each glyph keeps its BDC slot (2.5). The replaced span must lie inside one MCID. OC/ActualText/Alt/E stay refused. A group never mixes `Artifact` with tagged content.
7. **Recompile and rewalk:** keep the existing `compileReflowPlan` checks (glyph destinations, unplaced-show identity, Tm/Tlm rejoin). Add a marked-content check: for every MCID, the code sequence before and after is equal, except the replacement inside the target MCID.

### 2.5 Rewriting sibling BTs as a unit: slot-preserving emission

Replace "emit the whole paragraph at `firstOp`" in `reflowCompile.ts` with emission per owned op:
- Give every layout cluster a **home op**: its source op for source glyphs, the op of the first replaced glyph for replacement glyphs.
- For each owned show op `i`, in source order, emit `Tm` + `Tf/Tc/Tw` + `TJ` segments for that op's clusters at their solved origins. A home op that straddles two visual lines gets two segments. Then emit `restore(trace.ends.get(i))`.
- Invert the origin through **that op's** CTM and Tm linear part, not `recipe.saved.ctm`.
- Replay non-show ops in the window literally, as today.

What this gives:
- MCID membership is preserved by construction.
- Per-glyph fill colour is preserved, which is what makes allowing colour ops safe.
- Paint order relative to unowned ops is unchanged.
- BT boundaries and Tlm restoration stay local to each BT.
- Glyph order in the stream is unchanged, so the existing `expected` destination check works as-is.

### 2.6 Downward growth and suffix shift

Keep the existing order (fixed → spacing → suffix shift → wrap → grow) with these changes:
- **Suffix shift** uses that slot's occupancy-derived `right`. Each moved suffix glyph is checked one by one (obligation 4), so a ragged line can grow into its own empty tail.
- **Wrap** uses the group's slots. Windows are `[targetLine … group end]` when that is ≤8 lines; otherwise try the smallest window ending at the group end, as today. Lines before the window stay unmoved prefix, not obstacles to their own unchanged ink.
- **Grow** is allowed only below the group's last line:
  - The new baseline is `last − pitch`. Pitch is explicit TL, or an observed group pitch from ≥2 lines; otherwise refuse.
  - The band is the planned new glyphs' dilated ink, with the leading-height band kept as a floor (`proveDownwardSlot`).
  - It must intersect no occupant.
  - Add one slot at a time, never past 8 slots in total.
  - Never displace the next group.

### 2.7 What stays refused

- Tr 1/2/3+ and vertical WMode.
- RTL/bidi.
- OC/ActualText/Alt/E marked content.
- Text inside Form XObjects.
- Any page with a `media`-sized occupant (unmeasured CFF, unknown paint, unbounded `Do`).
- Non-embedded fonts in the move set.
- Moving any glyph that isn't a `paragraphMember` (math, superscripts) and any break inside one.
- More than 8 slots or more than 4,096 clusters.
- Pushing following groups down.
- Column interleaving, tables, captions with one line and no column proof.
- Replaced spans that cross MCIDs.

---

## 3. Row estimate (of the 400 `no-region-proof` rows)

These estimates are low-confidence until milestone 1, step 1 re-classifies the rows with the production gate. Bands count rows that would pass region proof *and* the existing later gates (layout, encode, oracle). The later gates already take 6–7% of overflow rows.

| Category (rows) | Main blockers it removes | Conservative | Likely | Optimistic |
|---|---|---|---|---|
| tagged (211) | colour ops between BTs, ragged right, MCID safety; later opaque badUnicode | 20 | 55 | 100 |
| latex (109) | per-glyph region vs neighbour lines, math in unmoved prefix, group pitch | 8 | 25 | 45 |
| chinese (54) | per-glyph region, ragged final line, one-line growth with pitch | 5 | 14 | 25 |
| japanese (14) | few; operator blockers are likely vertical/ruby | 0 | 2 | 5 |
| word (6) + indesign (6) | colour/`cm` grammar, ragged right | 2 | 5 | 9 |
| **Total** | | **≈35 (+2.6 pt)** | **≈100 (+7.5 pt)** | **≈185 (+14 pt)** |

**Rows this won't unlock:**
- The ~40–80 tagged rows with `unmeasured=77`: the full-page CFF obstacle.
- badUnicode inside the replaced span, or as a break candidate.
- Paragraphs whose tail needs moving math or superscripts.
- Edits more than 8 lines from the end of a long justified paragraph (zero slack until the last line).
- Full-page background images or forms (Chinese hybrids).
- Vertical Japanese and Tr 1/2.
- Single-line headings and captions without a column proof (until milestone 4).
- The 30 non-region overflow gates.

---

## 4. Implementation plan

Each milestone below keeps the native 0-pixel-outside-region oracle. Write the failure list before the tests and code, per AGENTS.md.

**Milestone 1: truthful gate and slot-preserving compile (highest leverage, safe)**
1. Change `streamReflowEvidence` to return a typed refusal `{ok:false, gate, blocker, detail}` at every `return null`; production callers map it to null. Delete the duplicated logic in `classifyEvidence.ts` and call the production function. Add a parity test: on fixtures, the classifier gate equals the production refusal. Re-run the histogram. No behaviour change.
2. Add `ScopeKey` per show in `traceReflowSource` (`safetyHash` stays as the revision hash) and require equal `ScopeKey` in `paragraphMember`. This can only refuse more rows.
3. Slot-preserving emission in `compileReflowPlan`, with a per-op CTM inverse and a per-MCID code-sequence check in the rewalk. This fixes the MCID-rehoming P1 that ships today.
4. Allow fill/stroke colour ops between owned shows in `proveOperators`, which is safe only after step 3.

Expected gain: tagged/Word rows blocked on colour ops. Gate: `bun run verify` plus a native PDFium probe.

**Milestone 2: occupancy index and per-glyph region**
- Add `PageOccupancy` (built from `reflowScene`, walk glyphs and unplaced shows) and `GlyphRegion`.
- Replace the ascent/descent `rasterBox` (`reflowEvidence.ts:149–152`) and the em-box `outside` obstacles with obligations 3–5.
- Allow non-member glyphs in the unmoved prefix.
- `RegionProof.mask` feeds the native oracle's mask.

Expected gain: LaTeX/CJK short-geometry rows.

**Milestone 3: visual groups and capacity**
- Build `VisualGroup`, set `capacityRight` from the group's maximum observed extent for ragged text, and choose windows by group (replacing the brute-force 8→1 loop).
- Group pitch for growth; allow `cm` inside whole-BT `q…Q`.
- Raster veto in the corpus oracle and `scripts/perf/tauri-probe.ts`, with artifacts under `test-artifacts/pdf-stage5/reflow/`.

Expected gain: ragged-right tagged/Word bulk.

**Milestone 4 (optional, separate review): opaque glyphs and column proofs**
- Glyphs with no Unicode but measured advance and ink become locked, unbreakable clusters that move rigidly. The compiler gets an opaque path, and the extraction check compares against PDFium's text *before* the edit rather than `unicodeByCode`. The replaced span still needs a ToUnicode proof.
- A column-proven right edge for one-line groups.

---

## 5. Risks and the tests that must exist before a corpus run

**P0/P1 failure modes**
- **Under-bounded occupancy:** non-embedded substitute fonts, `sh`, inline images, annotation appearances, Type3 glyphs with no ink proof, unmeasured CFF. Mitigations: refuse, `media`, or the raster veto.
- **Treating a neighbour as empty:** white `re f` or Tr 3 text painted later; gutters; the next paragraph. Mitigations: analytic authority, raster only vetoes, capacity capped at the group's observed extent.
- **Moving the wrong BT:** ownership by op/item/byte only, complete-item proof, a group never jumps over a source line, refuse on column interleave.
- **Dropping or rehoming MCIDs:** slot emission, the per-MCID sequence check, `ScopeKey` in membership.
- **Tlm/CTM damage across sibling BTs:** per-op restore and a per-op CTM inverse.
- **Raster vs vector disagreement:** the veto fails the plan and becomes a fixture; the mask is never widened after rendering.

**Regression fixtures (unit tests plus a native probe, written before code)**
1. Word-tagged 3 BT × MCID 0/1/2 with `0 g 0 G` per BT: wraps, and each moved glyph stays inside its own MCID. This replaces the current `reflowRegion.test.ts:21` expectation.
2. Line 2 in blue (`0 0 1 rg`): the moved glyph renders blue natively.
3. Artifact header next to the body at the same style: never grouped.
4. Neighbour paragraph 2 pt below: in-line growth passes, growth into it is refused.
5. Ragged-right paragraph beside a right column across a gutter: capacity never enters the gutter.
6. White rectangle painted after the text over the destination: refused.
7. Non-embedded font in the move set: refused.
8. Superscript before the edit point: allowed. After it: refused.
9. Two paragraphs in one BT separated by paragraph spacing: two groups.
10. Two-column page whose stream interleaves the columns: refused.
11. Replaced span crossing an MCID boundary: refused.
12. Classifier/production parity on all fixtures.
13. Oracle mutation tests: inject one pixel outside the mask, a glyph moved into another MCID, and Tlm drift after the window. The oracle must catch each.
14. Keep the existing Tr 1/2 cross-BT, WMode, missing-ink and occupied-band tests green.

**Corpus protocol:** run milestone 1, step 1 first and record the new subgate histogram as the baseline. After each milestone, publish rows gained per gate, plus every row whose fixed outcome regressed.