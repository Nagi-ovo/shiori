import type {RunEnvironment} from '../contentStreamEdit/textSafety';
import type {ParagraphInput,SourceAddress,GlyphIdentity,Rect,TextTrace,RegionProof} from './regionProof';
import type {MeasuredCluster,MeasuredReflowResult} from './reflowLayout';

export const reflowDefaults=Object.freeze({enabled:true});
/** Corpus/CLI hosts may force off globally. Browsers use the explicit export
 * option; no mutable global policy is installed in the app. */
export function reflowEnabled(explicit?:boolean):boolean{
 const host=globalThis as {process?:{env?:Record<string,string|undefined>}};
 return host.process?.env?.SHIORI_STAGE5_REFLOW!=='0'&&(explicit??reflowDefaults.enabled);
}
/** An R1/R2 caller supplies actual ink and source break intent. A boolean
 * alone never authorizes treating visual newlines as soft or inventing ink.
 * dependencyHash must be recomputed by that caller from its current revision.
 */
export type ReflowRequest={
 paragraph:ParagraphInput;dependencyHash:string;target:SourceAddress;
 sourceInk:readonly {source:SourceAddress;box:Rect;glyph:GlyphIdentity;proofHash:string}[];
 replacementInk:readonly {unicode:string;code:Uint8Array;box:Rect;proofHash:string}[];
 /** A measured, already resolved/installed Type0 substitute resource. Its
  * PDF widths and replacement ink are required just like the source font. */
 replacementFontResource?:string;
 softBreaks:readonly number[];
};
export type ReflowOptions={stage5Reflow?:boolean;reflowRequest?:ReflowRequest};
export type ContentTextEnvironment=RunEnvironment&ReflowOptions;
export type ReflowCodeCluster=MeasuredCluster&{
 code:Uint8Array;fontResource:string;fontObject:string;
 source?:SourceAddress;glyph?:GlyphIdentity;
 /** Replacement clusters inherit the first replaced glyph's operator slot. */
 homeOp?:number;
 /** Original per-show metrics; replacements inherit their addressed show. */
 metrics?:Pick<TextTrace,'size'|'tc'|'tw'>;
};
export type ReflowRecipe={
 substituted?:boolean;
 proof:RegionProof;request?:ReflowRequest;saved:TextTrace;
 layout:Extract<MeasuredReflowResult,{ok:true}>;
 clusters:readonly ReflowCodeCluster[];
 firstOp:number;lastOp:number;rejoin:TextTrace;
};
