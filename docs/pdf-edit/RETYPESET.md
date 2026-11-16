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
paragraph / column measure. Grow the block downward. Best-effort: translate
later **text** in the same column down by the extra depth when a simple
y-order + column-band heuristic says it sits below. If that would leave the
media box, hit a full-width footer/image we will not move, or is too
uncertain: **do not shrink the font**; **allow the paragraph to overflow**
its original region (it may visually overlap what follows). Size fidelity
beats fitting. This is approximate; do not invent tier-1 proofs for the
push.

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

## Oracle

- Tier 1: existing native raster veto (0 px outside the proved mask,
  no unexplained original paint) then Poppler, unchanged.
- Retypeset (new gate): PDFium opens and rasterizes the page; the original
  edited span is gone from extracted text; the user's new text extracts;
  no ink remains from the old glyphs (raster difference inside a mask of
  the old glyph coverage); no other text objects were deleted (non-target
  extracted text / glyphs persist); the 0-px-outside-mask rule does **not**
  apply.

## Corpus r20 (later milestone)

Headline **"edits succeeded without overlay"** = every headline kind that
is not `unsupported`, target ≈ 100% minus true no-text-layer scanned
pages. Report the exact-tier rate side by side (r19: 43.5% headline /
48.6% old-definition). Per category. `overflow-unbreakable` stays out of
the headline. PNG pairs for ~10 representative retypeset rows across
Latin, Chinese, Japanese, stroked, and tagged.

## Non-goals

- Do not loosen tier-1 proofs to chase the exact-tier rate.
- Do not OCR images.
- Do not redeem Codex reset cards. No push.

## Review decisions (Opus consult + Grok plan review)

Opus plan: `/workspace/research/pdf-text-identity/OPUS-retypeset-plan.md`
(session `1d75cea9-3c88-49a2-9761-091e3d77d9f6`). Adopted:

1. **No same-column push in M1.** Grow and wrap at the original size; overflow
   / overlap what follows; flag overflow on the manifest and in the notice.
   Pushing other text is optional later and would weaken "other text unchanged".
2. **Retypeset from the first edited line, reuse original font/bytes for
   unedited words** when codes and widths are known. Use the bundled
   substitute only for characters the source font cannot encode. Full
   substitute-font paragraph is the fallback when reuse is impossible.
3. **Delete by glyph identity, not by cover rectangle.** New removal keys
   exact glyphs and reuses the existing rewrite core. Production check:
   every glyph we did not target keeps font, character codes, and position.
4. **Retypeset raster gate:** changed pixels must lie in (old-glyph ink mask
   ∪ new text box). This replaces the tier-1 proved-region mask, rather than
   dropping a mask entirely. Extraction checks are positional (do not require
   the old string to vanish from the whole page). Emitted glyphs must be real
   (no tofu).
5. **Invisible OCR over a still-visible image** is `unsupported-image-text`,
   not retypeset. Painting new visible text on top of the scan is the cover
   behaviour we are retiring; replacing the image is out of scope.
6. **Form XObjects** are `unsupported-form-xobject` in M1 (shown to the user,
   never covered). Copy-on-write of the form stream is a later milestone.
7. Keep the **tier-1 refusal reason** on the retypeset manifest. Multiple
   edits in one paragraph are planned and written in one pass. `fidelity` is
   required on accepted outcomes and is determined by `mode`.
8. r20 headline success is **tier-1 or retypeset, and the applicable oracle
   passed**, not merely "not unsupported".
