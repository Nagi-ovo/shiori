import type {PdfRect,ContentTextOverlay} from '../../model/types';
import type {GlyphPlacement,ShowTextState} from '../contentStreamEdit/textState';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {ContentTextReason} from './outcomes';
export type RetypesetManifest={
 paragraphBox:PdfRect;substituteFont:string|null;lineCount:number;overflowed:boolean;pushed:false;
 // null means all output could reuse the source fonts; no subset was needed.
 /** Original exact-tier refusal, retained even after successful retypeset. */
 reason:ContentTextReason;
};
export type RetypesetGlyph={glyph:GlyphPlacement;state:ShowTextState;text:string|undefined;x:number;y:number};
export type RetypesetLine={glyphs:RetypesetGlyph[];x:number;y:number;right:number};
export type RetypesetGroup={lines:RetypesetLine[];left:number;right:number;pitch:number};
export type RetypesetEdit={overlay:ContentTextOverlay;reason:ContentTextReason;selected:RetypesetGlyph[]};
export type RetypesetCluster={text:string;bytes?:Uint8Array;font?:ResolvedRunFont;home:RetypesetGlyph;hard?:boolean;advance?:number;x?:number;y?:number};
