import type {PdfRect,ContentTextOverlay} from '../../model/types';
import type {GlyphPlacement,ShowTextState} from '../contentStreamEdit/textState';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {ContentTextReason} from './outcomes';
export type RetypesetManifest={
 paragraphBox:PdfRect;substituteFont:string|null;lineCount:number;overflowed:boolean;pushed:boolean;
 /** Max absolute start-x/baseline drift of unchanged source lines, PDF pt.
  * Baseline drift includes a push; start-x drift must remain zero. */
 unchangedLineDriftPt:number;
 /** Positive physical PDF points downward; zero when no push is applied. */
 pushedDeltaPt:number;
 /** Authorized old/translated following ink regions in page PDF points.
  * Empty for a blocked/no-op push; approximate oracle consumers may use them. */
 pushedRegions:{before:PdfRect;after:PdfRect}[];
 /** Conservative ink-envelope intersection with unpushed page ink. */
 overflowInkOverlap:boolean;
 /** Explicit overflow fallback, never clipping or shrinking. */
 pushReason?:string;
 // null means all output could reuse the source fonts; no subset was needed.
 /** Original exact-tier refusal, retained even after successful retypeset. */
 reason:ContentTextReason;
};
export type RetypesetGlyph={glyph:GlyphPlacement;state:ShowTextState;text:string|undefined;x:number;y:number};
export type RetypesetLine={glyphs:RetypesetGlyph[];x:number;y:number;right:number};
export type RetypesetGroup={lines:RetypesetLine[];left:number;right:number;pitch:number};
export type RetypesetEdit={overlay:ContentTextOverlay;reason:ContentTextReason;selected:RetypesetGlyph[]};
export type RetypesetCluster={text:string;bytes?:Uint8Array;font?:ResolvedRunFont;home:RetypesetGlyph;hard?:boolean;join?:boolean;advance?:number;x?:number;y?:number};
