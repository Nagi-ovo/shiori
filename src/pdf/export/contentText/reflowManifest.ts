import type {GlyphPlacement} from '../contentStreamEdit/textState';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import type {ReflowRecipe} from './reflowTypes';
import type {Rect} from './regionProof';
export type ManifestGlyph={unicode:string;origin:readonly number[];oldOrigin?:readonly number[];fontHash?:string};
export type AppliedReflowManifest={sourceHash:string;dependencyHash:string;strategy:ReflowRecipe['layout']['strategy'];
 region:{box:Rect;mask?:readonly Rect[];oldInk?:readonly Rect[];occupancyHash?:string;backdropOps?:readonly number[]};source:readonly ManifestGlyph[];output:readonly ManifestGlyph[]};
/** Serializable saved-PDF oracle evidence. Original source windows and every
 * output destination are recorded; the native oracle independently matches
 * those windows, font programs, outlines, unowned origins and changed pixels. */
export function reflowManifest(r:ReflowRecipe,glyphs:readonly GlyphPlacement[],fonts:readonly ResolvedRunFont[]):AppliedReflowManifest {
 const hashes=new Map(r.clusters.flatMap(t=>t.glyph&&'programHash'in t.glyph?[[t.fontResource,t.glyph.programHash] as const]:[]));
 return {sourceHash:r.proof.sourceHash,dependencyHash:r.proof.dependencyHash,strategy:r.layout.strategy,region:r.proof,
  source:glyphs.filter(g=>g.opIndex>=r.firstOp&&g.opIndex<=r.lastOp).map(g=>({unicode:fonts.find(f=>f.resourceName===g.fontName)!.unicodeByCode.get(g.code)!,
   origin:[g.coreQuad[0].x,g.coreQuad[0].y],fontHash:hashes.get(g.fontName)})),
  output:r.clusters.flatMap((t,i)=>t.source&&t.source.opIndex<r.firstOp?[]:[{unicode:t.unicode,origin:r.layout.origins[i]!,
   ...(t.original?{oldOrigin:[t.original.x,t.original.y]}:{}),fontHash:hashes.get(t.fontResource)}])};
}
