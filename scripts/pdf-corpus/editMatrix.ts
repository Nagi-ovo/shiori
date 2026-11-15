export type CorpusEdit={kind:string;text:string};
export function editMatrix(original:string):CorpusEdit[]{
 const word=/[A-Za-z]{3,}/.exec(original),start=word?.index??0,text=word?.[0]??Array.from(original).slice(0,3).join('');
 if(!text)return[];
 const replace=(next:string)=>original.slice(0,start)+next+original.slice(start+text.length);
 const chars=Array.from(text),rotated=chars.slice(1).join('')+chars[0];
 const swap=rotated!==text?rotated:chars.map(c=>c.toLowerCase()===c?c.toUpperCase():c.toLowerCase()).join('');
 const result=[{kind:'same-length',text:replace(swap)},{kind:'missing-glyph',text:replace('é'+text.slice(1))},
 {kind:'shorter',text:replace(text.slice(1))},{kind:'longer',text:replace(text+'i')},
 {kind:'overflow',text:replace(text.repeat(8))},{kind:'substring',text:replace(text.slice(0,1)+'i'+text.slice(2))}];
 if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(original))result.push({kind:'cjk',text:original.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,c=>c==='日'?'本':'日')});
 return result.filter(e=>e.text!==original);
}
