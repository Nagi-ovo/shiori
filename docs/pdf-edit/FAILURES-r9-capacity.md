# Round 9 Milestone 1 — row-local occupancy failure list

Existing coverage: `reflowOccupancy.test.ts` checks analytic obstacles and
placement overlap, but uses 14 pt leading and never exercises a guard-only
collision with the adjacent row. Stroke tests cover text outlines, not a
joinless page rule. The regressions below cover those missing shapes.

Write and run these tests before changing production code:

- A 10 pt k/g row at 9.9 pt pitch loses its entire slot to the adjacent row's
  guard. Identical/shorter replacement ink inside the observed row must pass;
  retained glyphs and the observed right edge stay fixed.
- A title near an open `m l S` rule must not inherit a miter-sized obstacle.
  Dash patterns, butt/round/square caps and an affine non-conformal `cm` must
  bound the entire stroke. Multiple subpaths/segments, `re S`, `h`, implicit
  closure, curves, malformed path/width, hairlines and unknown ExtGState LW
  keep the old miter/clip bound; graphics-state restoration must still work.
  Square caps under non-conformal transforms require special care: at 45°
  with CTM `[100 0 0 1]`, width .1 needs 7.071 pt x padding while the proposed
  Frobenius disk gives only 5.000 pt. Keep the miter bound in this case.
- Row-local authority requires one source row, an unblocked page, an ordered
  group, complete measured embedded source glyphs, and no foreign same-baseline
  placement crossing the owned horizontal interval. Same-row excluded glyphs
  wholly outside a split fragment are obstacles, not invented capacity.
  Interior excluded/Artifact/OC glyphs and interleaved columns still refuse.
- Count-two windows retain the coarse cap; they cannot acquire this fallback.
- Replacement ink and pen end cannot exceed the observed right edge or cross
  an unowned same-baseline placement. Ink cannot move left of the row or above
  or below its source ink band (including a taller accented replacement).
- Ink-on-ink with any stationary glyph, annotation, form, image or paint always
  refuses. The guard-ring intersection may only occupy the union of undilated
  vacated source ink. A protruding sliver, a hole between old boxes, overlapping
  covers and complete multi-box coverage exercise exact rectangle subtraction.
- Placement overlap, changed/new and changed/stationary ink overlap, crop/media
  containment, unembedded/unmeasured fonts, stale occupancy and unsafe shows
  retain their existing refusals. The old/new guard-dilated mask remains fixed
  before compile. No Round 4 CFF/FontBBox exception is introduced.
- A row-local proof must disable suffix movement and wrapping even when the
  caller explicitly enables them, and must never grow downward. Ordinary
  non-row-local proofs keep their current behavior.

No suffix glue tightening, Tw/TJ policy change, corpus run or resource-stamp
change belongs to this milestone. Validation commands and red/green results
are recorded in `/workspace/research/pdf-text-identity/STATUS-r9-capacity.md`.
