# Retypeset: remove cover/overlay as a content-text edit outcome

Parent: `feat/pdf-stage5` @ `c2dc7e9`. Jesse (pt95u): no mature editor
uses a white-cover + new-text overlay; the target is in-place editing of
original page text. This note is the implementation contract.

## Tiers

1. **Exact (unchanged).** `in-place` | `fallback-font` | `substituted` |
   `reflowed`. Existing proofs and the strict 0-px-outside-mask oracle stay.
   `fidelity: 'exact'`. Do not loosen row-local occupancy, destination
   proofs, or typographic identity to grow this tier.
2. **Approximate.** New mode `retypeset` for every current content-text
   refusal that sits on a page with a text layer (at least one text-showing
   operator / extractable glyph). `fidelity: 'approximate'`.
3. **Unsupported.** Only pages with **no text layer** (no text-showing
   operators). `mode: 'unsupported'`, `reason: 'unsupported-no-text-layer'`.
   Never `overlay`. OCR of scanned images is out of scope; a scanned page
   that already has an OCR text layer is a text layer and must retypeset.

`overlay` is retired as a production content-text outcome. Other overlay
types (new text boxes, callouts, images, highlights) are unchanged — they
are not a fallback for editing original page text.

## Fit policy (documented choice)

Preserve the original font size, fill colour, and stroke. Wrap to the
paragraph / column measure and grow downward. Approximate retypeset now
supports a page-local **same-column push** when added wrap rows occupy the
baseline/ink band of following content. A short last CJK glyph and a
right-aligned subtitle still reserve separate rows even when their ink does
not touch horizontally.

Column x edges come from the existing visual group, not the page margins.
Membership uses complete visual rows (split at observed inter-column gaps),
plus in-column path/image/Form bounds from the existing analytic scene
occupancy. A rule, image or indented row may extend past the text measure by
at most **one source em or one eighth of the column width**, whichever is
smaller. This outset is evidence of a shared column only when the object's
centre and at least half its width remain inside the measure, and its extra
width does not enter the x extent of an observed foreign text row. This
admits small indents and separator endcaps without treating adjacent columns
as one flow. Entire paths/images/rows move; glyphs are not cherry-picked.

A crossing full-width row/graphic ends the band. Only annotations/unknown
occupants intersecting this column can be barriers; an annotation wholly in
another column stays fixed and is still checked against swept destinations.
Items in the outer physical page
margin band (one observed pitch, capped at one tenth of the page height),
page-width graphics, and wide backgrounds already behind the edited line
are furniture, not following flow. A gap beyond **four observed physical
pitches** ends recruitment. Within that locality, stop at the first complete
prefix whose translated ink and swept bounds clear all stationary ink and
the new wrap: an existing gap can absorb Δ without moving a distant footer
or later body. If no such prefix exists, the whole affected band is blocked.
Only following items wholly within the proved local band move. Other columns, earlier content, and headers/footers outside it
retain their coordinates. Moving a Form invocation as a whole is supported;
pushing across an edited Form's own boundary is not.

Every pushed item receives the same physical downward **Δ**, the extra depth
of the changed block. Original text operators/strings remain intact under a
local translation: x, font, codes, and intra-run spacing stay fixed, while
PDF y decreases by Δ. Unchanged later source lines are never re-emitted just
because an earlier line changed. Graphics paths are translated from their
construction through paint; images/Form invocations move as complete objects.

A push is claimed only after these checks:

- Complete row/show ownership prevents moving an outsider in a shared TJ.
- All translated bounds fit both crop and media boxes. Their swept regions
  and destinations avoid stationary/foreign ink, annotations, and obstacles.
- New emitted ink avoids every unpushed occupant and translated destination.
  Outline/declared ink envelopes are used, never core quads as empty-ink proof.
- Rewalking compiled text verifies every untouched glyph at its original
  position, or at exactly `(x, y - Δ)` for the authorized move set. Rewalking
  graphics checks moved and stationary paint envelopes independently.
- Native regression artifacts cover stable unchanged strings/origins, one Δ
  for text and graphics, and nonintersecting wrapped/subtitle ink bands.

When the move cannot be proved, use the **common overflow fallback**:
keep visible overflow at the original size, set `pushed:false`, and attach a
`pushReason` starting with `push-blocked-by-`. Blockers include crop/media
limits, fixed/foreign occupants, annotations, shared shows, active clips,
unknown ink/unplaced text, unsafe graphics spans, rotated push frames, and
interacting edited blocks/streams or already accepted edits. Ordinary column
text **never shrinks**. Never paint a cover or introduce a clipping rectangle
to invent space. If an
inherited source clip (including a Form BBox) would hide new wrap ink, refuse
the transaction precisely (`retypeset-output-outside-source-clip`) and retain
the source bytes instead of reporting a silently clipped edit as success.

### Bounded-frame exception

A fixed cell, box or header banner permits tightening instead of moving the
table or page body. Detection uses existing page geometry: an axis-aligned
rectangle, or four connected horizontal/vertical rule segments enclosing all
changed source glyphs. Thin filled rectangles (at most one eighth of a
source em thick, at least one em long) are rules too. Compound table paths
must have no additional segment crossing the chosen interior. Page-sized
outlines do not authorize shrinking ordinary columns. A filled rectangular
background must precede and contain the edited source, and be shorter than
half the page; a page backdrop is not a text frame. An existing rectangular
clip may bound the visible frame, intersected with both crop and media boxes;
the clip is never extended or rewritten.
Arbitrary/curved path bboxes do not prove a frame.

The fit search measures the actual emitted font ink, including overhang and
stroke guard. Keep the original anchor. Try character and word spacing
reductions of **0.01, 0.02, then 0.03 source em** at the original size first.
If those fail, reduce each source run's font size in one-percent steps to a
hard **85% floor** (`RETYPESET_FRAME_SIZE_FLOOR = 0.85`), retaining the mild
spacing reductions. Wrapped baseline pitch scales by the same size factor;
unchanged source lines never enter this layout. Use the bounded interior's
width, reserving the measured right overhang.

A fit is accepted only when every emitted ink envelope is measurable,
contained in the frame, and clear of other text and graphics. Paint belonging
to the frame (including a containing background behind its border) remains
stationary and is exempted from overlap only when all output is contained.
When the floor still fails, retain visible overflow, never push the table or
body, and report `push-blocked-by-bounded-frame` with the measured
`overflowInkOverlap`. An unresolved envelope intersection stays true.

Applied tightening reports `fitStrategy: 'tighten-frame'` and `frameFit`:
frame rectangle/kind, `sizeScale`, `floor: 0.85`, `trackingEm`,
`wordReductionEm`, and `fits`. Spacing reductions are relative to each run's
source size, before its text matrix/CTM; measurement and emission share that
same effective state. A contained fit needs no grow-down mask. This exception
changes only approximate retypeset; the exact-tier **0-px-outside-mask** oracle
and its masks remain unchanged.

Production per-edit diagnostics use PDF points: `unchangedLineDriftPt` is the
maximum absolute start-x/baseline drift over unchanged source lines; it is
zero without a push, and includes an intentional baseline move when pushed.
`pushedDeltaPt` is positive downward (zero without a push); x drift is always
zero. `pushedRegions` supplies old/translated following ink rectangles in page
PDF points for a future approximate oracle consumer (empty without a push). `overflowInkOverlap` is a conservative boolean for emitted overflow
intersecting unpushed ink envelopes, not a raster score or new headline rate;
unknown bounds are treated conservatively. These fields do not grant exact
tier eligibility.

Any approximate push raster mask must be **old line boxes ∪ new text ∪ old
and translated following region**, never an enlarged exact-tier mask. The
exact-tier 0-px-outside-mask rule and grow-down proofs are unchanged. The
existing corpus/oracle mask plumbing is not modified here; a push-aware
consumer must use its explicit translation region before auditing that edit.

## Surgery

Reuse visual-group / paragraph detection and `removeCoveredGlyphs` /
stream rewrite. Retypeset the **whole paragraph** containing the selection
when its Unicode can be reconstructed; always apply the user's
`originalText` → `text` replacement to the edited span. Missing ToUnicode
on the original font must not block: the user's new text is known Unicode
and is encoded in a bundled substitute (Noto Sans / Serif / SC / JP, same
loader as fallback-font). Unedited neighbour glyphs keep their extracted
text when we have it.

Delete the paragraph's text-showing operators from the content stream
(actually gone, not covered). Do not delete other text objects. Embed a
subset of the substitute font. Emit new show ops at the paragraph origin,
same size, same fill, same Tr (0 / 1 / 2 — stroked stays stroked, with
stroke colour and width when present). Prefer emitting inside the same
`q/Q`, clip (`W`/`W*`), and marked-content (OC / Artifact / BMC/BDC)
group; do **not** refuse OC-hidden or Artifact text — edit within the
group. Tr 1/2 is no longer a path to cover/overlay; if tier 1 still
refuses stroked text, retypeset handles it.

Form XObjects that contain a text layer: edit the form's content stream
when we can; do not fall back to covering the page. Rotated / non-identity
`Tm`: keep the original text matrix when measurable. Mixed-style
paragraphs may collapse to the majority run's style (approximate).

If the stream is unparseable or a write would risk a corrupt page, leave
the page bytes unchanged and emit `unsupported` with a specific reason
(`unsupported-unwritable`). This hatch must stay rare and is **not** a
cover. Never white-rectangle + redraw original page text.

## API and UI

```ts
type ContentTextOutcome = {
  overlayId: string;
  mode: 'in-place'|'fallback-font'|'substituted'|'reflowed'|'retypeset'|'unsupported';
  fidelity?: 'exact'|'approximate'; // exact iff tier 1; approximate iff retypeset
  reason?: ContentTextReason; // includes 'unsupported-no-text-layer'
  detail?: string;
  reflow?: AppliedReflowManifest;
  retypeset?: RetypesetManifest; // paragraph box, font, lines, overflowed?, pushed?
};
```

`ContentTextWarning`: if `mode === 'retypeset'` (or `fidelity === 'approximate'`),
show a short "Layout may change." notice. Keep existing substituted/reflowed
notices. Update en/zh/ja, including any reason string that still says a
change "requires an overlay".

## Wiring

`applyContentTextEdits` keeps today's tier-1 plan + `applyFontSubstitutions`.
Every not-accepted content-text edit then goes to retypeset, or to
`unsupported-no-text-layer` if the page has no show ops. `remaining`
content-text passed to `rebuildPdf` must not be cover-drawn:
`redactContentTextCoverRects` + `drawContentText` (white `backgroundColor`
rects + new text) are not a fallback for original-text edits. Do not land
"remove the cover" in a commit that cannot yet retypeset — otherwise
refused edits silently vanish.

## Export verification

- Exact edits require an unchanged raster outside the proved mask and
  independent text extraction.
- Retypeset edits require the new text and ink at the emitted positions.
  The old glyphs must disappear at their original addresses. Non-target
  text, font, codes and positions must agree with the edit manifest.
  Raster changes must stay within the union of the old glyph ink and the
  new text box.
- Report exact edits and retypeset edits by category. Count an edit as
  successful after it passes the applicable export checks.

Invisible text over a scan stays unsupported when editing would require
changing the image. Preserve the exact-tier refusal reason when retypesetting
succeeds. Plan and write all edits owned by a paragraph together, and record
the fidelity of accepted edits in the outcome.
