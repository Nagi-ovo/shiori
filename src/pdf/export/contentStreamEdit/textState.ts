// Text-state interpreter for the glyph-removal export pass: walks tokenized
// content ops tracking CTM + text state, and yields one placement per shown
// glyph — its advance-box quad in content-stream user space plus everything
// the rewrite needs to excise it (string location and the TJ compensation
// that preserves the advance so following text does not shift).
//
// Fail-closed by design: any construct whose geometry we cannot model
// EXACTLY (unresolvable fonts, clipping text render modes, ExtGState font
// overrides, malformed operands — which also catch token-boundary damage
// from /Contents coalescing) aborts the whole walk with { ok: false }. The
// caller must then leave the page untouched. Approximating here would
// silently delete the wrong glyphs.
//
// One exception keeps a single odd font from disabling the whole page: text
// in a font glyphWidths cannot measure (a Standard-14 font without /Widths,
// a vertical or CMap encoding) yields no placements and sets unplacedText,
// so it is never removed. Its advance is unknown, so later shows on the same
// line are unplaced too, until a line operator moves from the line start.
// Stroked text remains uneditable, but known widths still advance tm. Its
// separate placements let callers reject an addressed stroke without making
// unrelated fill text unplaceable.

export type {
  Point,
  GlyphPlacement,
  XObjectUse,
  InlineImageUse,
  TextWalkResult,
  ShowTextState,
  UnplacedShow,
  TextWalkCallbacks,
} from "./textStateTypes";
export { walkTextPlacements } from "./walkTextPlacements";
