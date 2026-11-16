import fontkit from '@pdf-lib/fontkit';
import type {PDFDocument} from 'pdf-lib';
import {prepareFallback,type FallbackOptions} from '../contentStreamEdit/fallbackFont';
import {loadBundledFallbackFont} from '../contentStreamEdit/fallbackAssets';

type CidCff={isCIDFont:boolean;fdForGlyph:(gid:number)=>number};

/** fontkit's CID CFF subsetter assigns a revisited private dictionary to the
 * most recently added dictionary. Keep each dictionary's glyphs contiguous,
 * including the automatically included GID 0. Only subset preparation order
 * changes: the writer still encodes and emits clusters in paragraph order.
 * Confine this workaround to retypeset; exact-tier preparation is unchanged. */
export async function prepareRetypesetFallback(doc:PDFDocument,resource:string,name:string,clusters:readonly string[],options:FallbackOptions){
 const data=await(options.loadFont??loadBundledFallbackFont)(name);
 const parsed=fontkit.create(data) as ReturnType<typeof fontkit.create>&{'CFF '?:CidCff};
 const cff=parsed['CFF '];
 if(cff?.isCIDFont){
  const notdef=cff.fdForGlyph(0);
  const dictionary=(cluster:string)=>{
   const fd=cff.fdForGlyph(parsed.glyphForCodePoint(cluster.normalize('NFC').codePointAt(0)!).id);
   return fd===notdef?-1:fd;
  };
  clusters=clusters.toSorted((a,b)=>dictionary(a)-dictionary(b));
 }
 return prepareFallback(doc,resource,name,clusters,{loadFont:async()=>data});
}
