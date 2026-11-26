import fontkit from '@pdf-lib/fontkit';
import type {ResolvedRunFont} from '../contentStreamEdit/replaceRun';
import {encodeRun} from '../contentStreamEdit/runEncoding';
import {loadFallbackFont,type FallbackOptions} from '../contentStreamEdit/fallbackFont';
import {columnsOf,type ColumnCell} from './uprightColumnPlan';
import {isTcyUnit} from './uprightColumnTcy';

// Small kana, iteration and prolonged marks sit differently in a column.
const repositioned=/[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿー〜～ゝゞヽヾ゠]/u;
/** Two or more adjacent Latin letters or ASCII digits form a horizontal-in-
 * vertical (tate-chu-yoko) cell, not a stack of upright glyphs. The column
 * compiler lays such a unit only from a cell the page shows
 * (uprightColumnTcy.ts); other callers refuse it by name. */
export function tateChuYokoRun(text:string){return /[A-Za-z0-9\u00c0-\u024f]{2,}/u.exec(text.replace(/\s/gu,''))?.[0];}
export function requiresVerticalAlternate(c:string,parsed:ReturnType<typeof fontkit.create>){
 const gid=parsed.glyphForCodePoint(c.codePointAt(0)!).id;
 return ['vert','vrt2'].some(feature=>{
  const run=parsed.layout(c,[feature]);
  return run.glyphs.length!==1||run.glyphs[0]!.id!==gid;
 });
}
/** Upright CJK whose nominal glyph is already its column form. */
export const uprightNominal=(c:string)=>/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(c)&&!repositioned.test(c);

/** Glyph codes a font already shows inside stacked columns on this page,
 * keyed by NFKC text (a vertical presentation form proves its base scalar).
 * A producer that applied its own vertical alternates proves that code's
 * column form; reusing it repeats exactly what the page already paints. */
export function columnObservations(cells:readonly ColumnCell[]){
 const seen=new Map<string,Map<string,Set<number>>>();
 for(const column of columnsOf(cells)){
  if(column.length<3||column.some((c,i)=>i>0&&column[i-1]!.glyph.y-c.glyph.y<c.em*.5))continue;
  for(const c of column){
   const text=c.glyph.text?.normalize('NFKC');if(!text||Array.from(text).length!==1)continue;
   const byText=seen.get(c.font.resourceName)??new Map<string,Set<number>>();seen.set(c.font.resourceName,byText);
   const codes=byText.get(text)??new Set<number>();codes.add(c.glyph.glyph.code);byText.set(text,codes);
  }
 }
 return seen;
}
const bytesOf=(code:number,font:ResolvedRunFont)=>font.bytesPerCode===1?Uint8Array.of(code):Uint8Array.of(code>>8,code&255);

export type UprightChoice={font:ResolvedRunFont;bytes:Uint8Array}|{fallback:true}|{tcy:true};
/** Per scalar, over the home font and then sibling subsets of the same face:
 * an observed column code; otherwise a nominal glyph when that is the column
 * form; otherwise the upright substitute. */
export async function chooseUprightGlyphs(text:readonly {text:string;font:ResolvedRunFont}[],observed:ReturnType<typeof columnObservations>,siblings:(font:ResolvedRunFont)=>readonly ResolvedRunFont[],options:FallbackOptions){
 const choices:UprightChoice[]=[];
 let reference:ReturnType<typeof fontkit.create>|undefined;
 for(const {text:c,font:home}of text){
  // A tate-chu-yoko unit is laid from an observed cell, not chosen here.
  if(isTcyUnit(c)){choices.push({tcy:true});continue;}
  const faces=[home,...siblings(home).filter(f=>f!==home)];
  let choice:UprightChoice|undefined;
  for(const font of faces){
   const codes=observed.get(font.resourceName)?.get(c.normalize('NFKC'));
   if(codes&&codes.size>1)throw Error(`vertical-glyph: ${JSON.stringify(c)} has several column forms in the source font`);
   if(codes?.size){choice={font,bytes:bytesOf([...codes][0]!,font)};break;}
  }
  if(choice){choices.push(choice);continue;}
  if(Array.from(c).length!==1||/\p{M}/u.test(c))throw Error('vertical-glyph: combining clusters have no column proof');
  for(const font of faces){
   let encoded:ReturnType<typeof encodeRun>|undefined;
   try{encoded=encodeRun(c,font,new Uint8Array());}catch{encoded=undefined;}
   if(encoded?.ok){choice={font,bytes:encoded.bytes};break;}
  }
  if(choice&&!uprightNominal(c)){
   // Keep the established alternate refusal for unobserved source codes.
   // The program selected for new glyphs cannot prove a source code's form.
   reference??=fontkit.create(await loadFallbackFont('NotoSansJP-Regular.otf',options));
   if(requiresVerticalAlternate(c,reference))throw Error(`vertical-glyph: ${JSON.stringify(c)} needs a vertical alternate that no source column shows`);
  }
  choices.push(choice??{fallback:true});
 }
 return choices;
}
