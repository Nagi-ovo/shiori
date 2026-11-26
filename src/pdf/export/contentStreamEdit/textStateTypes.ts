import type { ContentFontInfo, UnsupportedFont } from "./glyphWidths";
import type { TextGraphicsState as GraphicsState } from './textGraphicsState';

export type Point = { x: number; y: number };

export type GlyphPlacement = {
  // Where the glyph's bytes live: ops[opIndex].operands — for TJ the
  // arrayItemIndex-th item of the array operand, for Tj/'/" the string
  // operand itself (arrayItemIndex = -1).
  opIndex: number;
  arrayItemIndex: number;
  byteOffset: number;
  byteLength: 1 | 2;
  code: number;
  // The /Font resource name the glyph was shown with — lets the export reuse
  // the SAME font for replacement text when its glyphs suffice.
  fontName: string;
  // Pen position before the vertical origin vector is subtracted.
  pen?: Point;
  // Advance-box corners in content-stream user space, order: origin,
  // origin+advance, top+advance, top. A degenerate box (zero advance) is
  // still emitted — the removal pass decides how to treat it.
  quad: [Point, Point, Point, Point];
  // Same advance, but only from the baseline up to CORE_TOP_EM (or the
  // ascent, if lower): the part of the glyph any cover built for its line
  // contains. Editor covers come from ink bounds or a band normalized to one
  // em, both shorter than many fonts' FontDescriptor box, so the removal
  // pass tests this band, not `quad`, for "fully covered".
  coreQuad: [Point, Point, Point, Point];
  // Op indices of the BMC/BDC operators whose marked-content spans enclose
  // the glyph, outermost first — where its /ActualText or /Alt would live.
  markedContent: readonly number[];
  // TJ number that reproduces this glyph's whole displacement (advance width
  // + char/word spacing) when the glyph bytes are removed: insert
  // -tjCompensation at the glyph's position. Units: thousandths of text
  // space at the glyph's font size (exactly what TJ expects).
  tjCompensation: number;
};

export type XObjectUse = {
  opIndex: number;
  name: string;
  // CTM in effect at the Do — the transform an XObject-recursive pass must
  // seed its own walk with.
  ctm: [number, number, number, number, number, number];
};

// An inline image (BI…EI) paints the unit square under the CTM in effect.
export type InlineImageUse = {
  opIndex: number;
  ctm: [number, number, number, number, number, number];
};

export type TextWalkResult =
  | {
      ok: true;
      glyphs: GlyphPlacement[];
      xobjects: XObjectUse[];
      inlineImages: InlineImageUse[];
      // Some text was shown where the walk cannot place it; no cover rect
      // can be proven free of it.
      unplacedText: boolean;
    }
  | { ok: false; reason: string };

export type ShowTextState = {
  opIndex: number; arrayItemIndex: number; fontName: string;
  fontSizePt?: number;
  fontSize: number; charSpacing: number; wordSpacing: number;
  origin: Point; advanceVector: Point;
  renderMode?: number;
  // Snapshots used only by approximate retypesetting. The strict callers
  // retain their original walk and refusal policy.
  textMatrix?: readonly number[]; lineMatrix?: readonly number[]; ctm?: readonly number[];
  horizontalScale?: number; leading?: number; rise?: number;
};

export type UnplacedShow = {
  fontName?: string;
  opIndex: number; arrayItemIndex: number; origin: Point | null; fontSizePt: number;
  advanceKnown: boolean; reason?: string;
  // Measured but uneditable glyphs, never candidates for glyph removal.
  glyphs?: readonly GlyphPlacement[];
};

export type TextWalkCallbacks = {
  // Read-only inventory can observe clipping text and keep placements
  // preceding an unreadable operator. Writers use the strict walk.
  inspection?: {
    inheritedFont?: ContentFontInfo | UnsupportedFont;
    onGlyph: (glyph: GlyphPlacement) => void;
    onForm: (use: XObjectUse, state: GraphicsState, font: ContentFontInfo | UnsupportedFont | null) => void;
  };
  // Opt-in for the approximate Form walker; strict callers retain defaults.
  initialState?: GraphicsState;
  onXObject?: (use:XObjectUse,state:GraphicsState)=>void;
  includeStroked?: boolean;
  onTextOpEnd?: (opIndex:number,matrices:{textMatrix:readonly number[];lineMatrix:readonly number[]})=>void;
  // Exact state at a source string, including empty shows.
  onShow?: (state: ShowTextState) => void;
  onUnplaced?: (state: UnplacedShow)=>void;
  // Resolve a /Font resource name. Null (unresolvable) aborts the walk; an
  // unsupported font leaves its text unplaced.
  resolveFont: (name: string) => ContentFontInfo | UnsupportedFont | null;
  // Whether an /ExtGState resource contains a /Font entry. Return null when
  // unknown — the walk then assumes it might and taints the current font.
  extGStateSetsFont?: (name: string) => boolean | null;
};
