import type {PdfRect,ContentTextOverlay} from '../../model/types';
import type {GlyphPlacement,ShowTextState} from '../contentStreamEdit/textState';
import type {ResolvedRunFont,RunUnsafeOperator} from '../contentStreamEdit/replaceRun';
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
 /** Explicit overflow fallback; bounded frames alone permit tightening. */
 pushReason?:string;
 fitStrategy?:'tighten-frame'|'fit-envelope'|'chain-push';
 /** Present only when the in-column fit ladder resolved a row that the push
  * and frame paths left overlapping. */
 envelopeFit?:RetypesetEnvelopeFit;
 frameFit?:{frame:PdfRect;kind:'cell'|'box'|'background';sizeScale:number;floor:number;trackingEm:number;wordReductionEm:number;fits:boolean};
 /** Residual unchanged-line drift after subtracting the applied push Δ. */
 quality:{maxUnchangedLineStartXDriftPt:number;maxUnchangedLineBaselineDriftPt:number;overflowInkOverlap:boolean};

 // null means all output could reuse the source fonts; no subset was needed.
 /** Original exact-tier refusal, retained even after successful retypeset. */
 reason:ContentTextReason;
 /** Diagnostic only: the exact-tier reflow gate behind `reason`, when reflow ran. */
 exactGate?:string;exactGateDetail?:string;substituteGate?:string;
 /** Diagnostic only: the exact-tier refusal text and unsafe operator class behind `reason`. */
 refusalDetail?:string;unsafeOperator?:RunUnsafeOperator;
};
export type RetypesetGlyph={glyph:GlyphPlacement;state:ShowTextState;text:string|undefined;x:number;y:number};
export type RetypesetLine={glyphs:RetypesetGlyph[];x:number;y:number;right:number};
export type RetypesetGroup={lines:RetypesetLine[];left:number;right:number;pitch:number};
export type RetypesetEdit={overlay:ContentTextOverlay;reason:ContentTextReason;exactGate?:string;exactGateDetail?:string;substituteGate?:string;refusalDetail?:string;unsafeOperator?:RunUnsafeOperator;selected:RetypesetGlyph[]};
/** leadingScale defaults to sizeScale; only the envelope ladder sets it. */
export type RetypesetAdjustment={sizeScale:number;trackingEm:number;wordReductionEm:number;leadingScale?:number};
export type RetypesetEnvelopeFit={envelope:PdfRect;step:'rebreak'|'tracking'|'leading'|'shrink';sizeScale:number;trackingEm:number;wordReductionEm:number;leadingScale:number;floor:number;
 /** Present only when no neighbour line witnessed the measure: the line was compacted inside its own ink band. */
 basis?:'own-band'};
/** `size` multiplies the home Tf for a user size request (requested/source
 * size); unlike `fit`, no ladder may change it. */
export type RetypesetCluster={text:string;bytes?:Uint8Array;font?:ResolvedRunFont;home:RetypesetGlyph;hard?:boolean;join?:boolean;inferred?:boolean;advance?:number;x?:number;y?:number;fit?:RetypesetAdjustment;size?:number};
