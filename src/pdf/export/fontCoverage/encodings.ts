import { Encodings, Font as StandardFont, FontNames } from '@pdf-lib/standard-fonts';
import glyphData from './glyphList.json';
import standard from './standardEncoding.json';
import macExpert from './MacExpertEncoding.json';
import macRoman from './MacRomanEncoding.json';
import macOs from './macOsRoman.json';
import type { FontInput } from './types';
const glyphs:Record<string,string>=glyphData;
export function glyphUnicode(name:string):string | undefined {
  const stem=name.split('.')[0]!;
  if(stem.includes('_')) {
    const parts=stem.split('_').map(glyphUnicode);return parts.every(x=>x!==undefined)?parts.join(''):undefined;
  }
  if(glyphs[stem])return glyphs[stem];
  if(/^uni(?:[\dA-Fa-f]{4})+$/.test(stem)) {
    const s=(stem.slice(3).match(/.{4}/g) ?? []).map(h=>String.fromCharCode(parseInt(h,16))).join('');
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)?s:undefined;
  }
  if(/^u[\dA-Fa-f]{4,6}$/.test(stem)) {
    const cp=parseInt(stem.slice(1),16);return cp<=0x10ffff && (cp<0xd800 || cp>0xdfff)?String.fromCodePoint(cp):undefined;
  }
}
export const standardNames = new Map(standard.map((name,i)=>[i,name]));
export const macOsNames = new Map(macOs.map((name,i)=>[i,name]));
macOsNames.set(219,'Euro');
const macExtra:Record<number,string>={173:'notequal',176:'infinity',178:'lessequal',179:'greaterequal',182:'partialdiff',183:'summation',184:'product',185:'pi',186:'integral',189:'Omega',195:'radical',197:'approxequal',198:'Delta',215:'lozenge',240:'apple'};
Object.entries(macExtra).forEach(([i,n])=>macOsNames.set(+i,n));
export function encodingNames(name:string):Map<number,string> {
  if(name==='StandardEncoding')return new Map(standardNames);
  if(name==='MacRomanEncoding')return new Map(macRoman.map((n,i)=>[i,n]));
  if(name==='MacExpertEncoding')return new Map(macExpert.map((n,i)=>[i,n]));
  const enc=name==='WinAnsiEncoding'?Encodings.WinAnsi:name==='Symbol'?Encodings.Symbol:name==='ZapfDingbats'?Encodings.ZapfDingbats:undefined;
  if(!enc)throw new Error(`unsupported simple encoding ${name}`);
  return new Map(enc.supportedCodePoints.map(cp=>{const g=enc.encodeUnicodeCodePoint(cp);return [g.code,g.name];}));
}
export function simpleNames(input:FontInput,builtIn?:Map<number,string>):Map<number,string> {
  const enc=input.encoding;
  const base=typeof enc==='string'?enc:enc?.base;
  const names=base?encodingNames(base):new Map(builtIn ?? standardNames);
  if(typeof enc==='object')for(const [code,name] of Object.entries(enc.differences ?? {})) {
    if(+code<0 || +code>255 || !Number.isInteger(+code))throw new Error('invalid Differences code');
    names.set(+code,name);
  }
  return names;
}
export function standardFont(baseFont:string):StandardFont | undefined {
  if(Object.values(FontNames).includes(baseFont as FontNames))return StandardFont.load(baseFont as FontNames);
}
export function standardBuiltIn(baseFont:string):Map<number,string> {
  return encodingNames(baseFont==='Symbol' || baseFont==='ZapfDingbats'?baseFont:'StandardEncoding');
}
