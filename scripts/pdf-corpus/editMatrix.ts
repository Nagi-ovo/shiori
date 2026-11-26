export type CorpusEdit={kind:string;text:string};

const LATIN_PHRASES = [
 'as noted',
 'in this case',
 'with more detail',
 'as described below',
 'with further explanation',
 'with details about this change',
 'with further details shown below',
 'with further details about these changes',
 'with further details and a short explanation',
 'with further details and a short explanation of the results',
 'with further details and a short explanation of the results shown in this section',
] as const;
const HAN_PHRASES = [
 '需要调整',
 '情况如下所示',
 '这需要进一步说明',
 '这种情况需要进一步说明',
 '在这种情况下需要进行适当调整',
 '在这种情况下还需要根据说明进一步调整',
 '如下所示，这种情况还需要根据实际需要进一步调整',
 '在这种情况下还需要进一步说明相关情况，并根据实际需要进行调整',
 '如下所示，这种情况需要进一步说明，并根据实际需要进行适当调整，具体说明如下',
 '在这种情况下需要进一步说明相关内容，并根据实际需要进行调整，具体情况和结果如下所示',
] as const;
const JAPANESE_PHRASES = [
 'についての補足',
 'この場合には調整が必要です',
 'この点については追加の説明が必要です',
 'この場合には調整が必要ですので、以下で説明します',
 'この場合には調整が必要ですので、以下の内容を確認してください',
 'この場合には調整が必要ですので、以下の説明を確認してから変更してください',
 'この場合には調整が必要ですので、以下の内容を確認した上で、必要な部分を見直してください',
 'この場合には調整が必要ですので、以下の内容を確認した上で、必要な部分を見直し、結果をもう一度確認してください',
] as const;

function appendOverflow(original:string,ratio:number):string{
 // Kana takes precedence over Han. Hangul-only lines use ASCII words so this
 // layout case does not introduce a requirement for additional CJK glyphs.
 const phrases=/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(original)?JAPANESE_PHRASES:
  /\p{Script=Han}/u.test(original)?HAN_PHRASES:LATIN_PHRASES;
 const separator=phrases===LATIN_PHRASES&&!/\s$/.test(original)?' ':'';
 const length=Array.from(original).length,target=length*ratio;
 const candidates=phrases.map(phrase=>({suffix:separator+phrase,length:length+Array.from(separator+phrase).length}));
 const inBand=candidates.filter(c=>c.length>=length*1.1&&c.length<=length*1.6);
 // Prefer the band, then proximity to the target. Fixed bank order breaks ties;
 // if even the shortest phrase exceeds +60%, keep that natural phrase intact.
 const chosen=(inBand.length?inBand:candidates).reduce((best,c)=>Math.abs(c.length-target)<Math.abs(best.length-target)?c:best);
 return original+chosen.suffix;
}

export function editMatrix(original:string):CorpusEdit[]{
 const word=/[A-Za-z]{3,}/.exec(original),start=word?.index??0,text=word?.[0]??Array.from(original).slice(0,3).join('');
 if(!text)return[];
 const replace=(next:string)=>original.slice(0,start)+next+original.slice(start+text.length);
 const chars=Array.from(text),rotated=chars.slice(1).join('')+chars[0];
 const swap=rotated!==text?rotated:chars.map(c=>c.toLowerCase()===c?c.toUpperCase():c.toLowerCase()).join('');
 // Stable order: the three overflow variants precede substring; optional CJK is last.
 const result=[{kind:'same-length',text:replace(swap)},{kind:'missing-glyph',text:replace('é'+text.slice(1))},
 {kind:'shorter',text:replace(text.slice(1))},{kind:'longer',text:replace(text+'i')},
 {kind:'overflow',text:appendOverflow(original,1.25)},{kind:'overflow-2',text:appendOverflow(original,1.55)},
 {kind:'overflow-unbreakable',text:replace(text.repeat(8))},{kind:'substring',text:replace(text.slice(0,1)+'i'+text.slice(2))}];
 if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(original))result.push({kind:'cjk',text:original.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,c=>c==='日'?'本':'日')});
 return result.filter(e=>e.text!==original);
}
