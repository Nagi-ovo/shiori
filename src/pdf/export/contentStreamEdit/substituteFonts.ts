/** Whole-run substitution is deliberately separate from missing-cluster fallback. */
export function substituteFontName(baseFont:string,flags:number,text:string):string {
 if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'NotoSansJP-Regular.otf';
 if (/\p{Script=Hangul}/u.test(text)) return 'NotoSansKR-Regular.otf';
 if (/\p{Script=Han}/u.test(text)) return 'NotoSansSC-Regular.otf';
 const base=baseFont.replace(/^[A-Z]{6}\+/u,'');
 let family=/Calibri|Carlito/i.test(base)?'Carlito':/Cambria|Caladea/i.test(base)?'Caladea'
  :/Avant.?Garde|Adventor/i.test(base)?'TeXGyreAdventor'
  :/Courier|Mono|Consolas|CM(?:TT|VTT)|LMMono/i.test(base)?'LiberationMono'
  :/Arial|Helvetica|Heros|CMSS|LMSans/i.test(base)?'LiberationSans'
  :/Times|Serif|Georgia|CM(?:R|BX|B|TI|SL|MI|SY|EX)|LMRoman|LatinModernRoman|Termes/i.test(base)?'LiberationSerif'
  :flags&1?'LiberationMono':flags&2?'LiberationSerif':'LiberationSans';
 // These metric faces have holes in Extended-A. Liberation supplies the full
 // range without adding assets; retain the selected serif/sans class/style.
 if(/[\u0100-\u017f]/u.test(text.normalize('NFC'))){
  if(family==='Caladea')family='LiberationSerif';
  if(family==='TeXGyreAdventor')family='LiberationSans';
 }
 const bold=!!(flags&(1<<18))||/Bold|Black|Heavy|CM(?:BX|B)\d/i.test(base);
 const italic=!!(flags&64)||/Italic|Oblique|Slanted|CM(?:TI|SL|MI)\d/i.test(base);
 return `${family}-${bold?(italic?'BoldItalic':'Bold'):italic?'Italic':'Regular'}.${family==='TeXGyreAdventor'?'otf':'ttf'}`;
}
