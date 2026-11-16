# Round 10 M2: bounded suffix word-gap tightening

Written before tests and production changes. Authority: OPUS-r9-capacity.md
§3.3 and Milestone 2. Existing coverage that should catch regressions:
`reflowLayout`, `reflowRowLocal`, `reflowFull`, `reflowOccupancy`, and
`reflowApply`; none currently exercises retained suffix glue.

## Planner failures (pure measured layout)

- No suffix, one word, CJK without word gaps, unproved positioning, or only
  locked boundaries: refuse, never add retained-letter Tc.
- All gaps at/below 0.2 em, too little ink clearance, or code 32 with an
  actual outline: no usable glue. Do not infer a word gap from Unicode.
- Literal one-byte code-32 spaces use advance plus positioning gap. Two-byte
  spaces have no Tw tier; only proved TJ gaps between non-space clusters work.
- Mixed glue: uniformly reduce literal spaces first, then uniformly reduce
  TJ gaps. Stop at each tier's smallest cap; never redistribute around it.
- Each cap is min(0.05 em, 20% of gap, gap minus 0.2 em, adjacent-ink
  clearance minus 0.01 em). Exercise binding limits and keep all four terms.
- Refuse excess over 2% of the proved row width, over total caps, or not
  exactly absorbable by the two uniform tiers. No partial success.
- Keep extraction word breaks at least 0.2 em and ink clearance at least
  0.01 em. A nominally wide gap with overhanging ink is still constrained.
- A leading suffix space measures clearance from the positioned replacement
  in the suffix's delta-shifted frame; overhanging replacement ink must not
  falsely consume that clearance twice.
- Rise/superscript/different-baseline clusters, multiple source lines,
  hard breaks, missing origins, nonfinite measurements, and inverted
  geometry refuse this tactic.
- Suffix shifts monotonically decrease from delta to zero, stay in
  [0, delta], and sum reductions within 1e-7. The last suffix glyph's x is
  exactly its original x, including with many fractional reductions.
- Exact-capacity arithmetic (for example 20.8 - 18 - 0.3) must tolerate
  machine roundoff without expanding a typographic cap by a visible tolerance.

## Solver, scene, and compiler failures

- Try replacement-internal spacing first, suffix glue next, suffix-shift
  only afterward. Preserve replacement spacing limits and PDF advances.
- Only a single-source-row window with rowLocal or a slot ending at its
  observed own end can justify. No borrowed column width; multi-row windows
  cannot acquire this strategy, even if only one row is edited.
- rowLocal still forbids suffix-shift, wrap, and downward growth, including
  explicitly enabled tactics; it may justify inside its existing row slot.
- Refuse a different-baseline unowned segment in the suffix x-range and row
  ink band, including Ts/super/subscripts which do not collide with new ink.
- Refuse movement across foreign/excluded same-row placements, including OC
  and Artifact shows. They remain ineligible and remain obstacles.
- Refuse destinations hitting annotation Rects, paint/image/form boxes,
  unknown paint, or crop/media edges. Keep per-glyph proof and fixed mask.
- Page blocking, group.refusal, bidi, missing measured/embedded glyphs and
  existing CFF/FontBBox refusals remain closed. Do not alter validTrace,
  show scopes, Tr 1/2 eligibility, or resourceStamp.ts.
- Synthetic pdfTeX-style one-line +one-letter edit with several >=0.25 em
  TJ gaps succeeds in the observed box with final glyph fixed. Include a
  literal-space/tagged counterpart, two-byte TJ counterpart, and apply
  outcome identifying row-justify separately from spacing-only.
- Compile/re-walk must agree with planned origins without
  layout-metrics-disagreement. Tighten through TJ numbers only; keep the
  suffix's source Tc/Tw, glyph codes, paint scopes, and rejoin state.

## Validation scope

Run the new tests red before production code, then green, plus existing
focused layout/auto/row-local suites and both complete contentText and
contentStreamEdit suites. Run both requested TypeScript checks, ESLint on
changed files, and git diff --check. Optional synthetic-only native PDFium
oracle; never run the 41-PDF corpus. All changes remain uncommitted on r10-m2.
