import type {RunEnvironment} from '../contentStreamEdit/textSafety';
import type {ParagraphInput,SourceAddress,GlyphIdentity,Rect,TextTrace,RegionProof} from './regionProof';
import type {MeasuredCluster,MeasuredReflowResult} from './reflowLayout';

export const reflowDefaults=Object.freeze({enabled:false});
/** An R1/R2 caller supplies actual ink and source break intent. A boolean
 * alone never authorizes treating visual newlines as soft or inventing ink.
 * dependencyHash must be recomputed by that caller from its current revision.
 */
export type ReflowRequest={
 paragraph:ParagraphInput;dependencyHash:string;target:SourceAddress;
 sourceInk:readonly {source:SourceAddress;box:Rect;glyph:GlyphIdentity;proofHash:string}[];
 replacementInk:readonly {unicode:string;code:Uint8Array;box:Rect;proofHash:string}[];
 softBreaks:readonly number[];
};
export type ReflowOptions={stage5Reflow?:boolean;reflowRequest?:ReflowRequest};
export type ContentTextEnvironment=RunEnvironment&ReflowOptions;
export type ReflowCodeCluster=MeasuredCluster&{
 code:Uint8Array;fontResource:string;fontObject:string;
 source?:SourceAddress;glyph?:GlyphIdentity;
};
export type ReflowRecipe={
 proof:RegionProof;request?:ReflowRequest;saved:TextTrace;
 layout:Extract<MeasuredReflowResult,{ok:true}>;
 clusters:readonly ReflowCodeCluster[];
 firstOp:number;lastOp:number;rejoin:TextTrace;
};
