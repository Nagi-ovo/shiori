import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {applyContentTextEdits} from './apply';
import {verticalFixture} from './vertical.fixture.test';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';

// Failure list (Identity-V / WMode 1): source punctuation refused although the
// page already shows its code in the column; punctuation the column never
// shows accepted; nominal kana refused by the substitute's alternate gate;
// a small kana substituted without its alternate; upright Latin refused
// although neither vert nor vrt2 changes it.
const loadFont=(name:string)=>readFile(`src/assets/fonts/${name}`).then(b=>new Uint8Array(b));
async function edit(source:string,text:string){
 const f=await verticalFixture({text:source}),before=inspectRunPage(f.page);
 const result=await applyContentTextEdits(f.page,[{...f.edit,originalText:source,text}],{loadFont});
 return{outcome:result.outcomes[0]!,changed:JSON.stringify(inspectRunPage(f.page))!==JSON.stringify(before)};
}
test('punctuation the source column shows is reused with its own code',async()=>{
 const r=await edit('日本、語かな','本日、語かな');
 expect(r.outcome).toMatchObject({mode:'retypeset'});expect(r.changed).toBe(true);
});
test('a moved source punctuation mark keeps the same code',async()=>{
 const r=await edit('日本、語かな','日本語、かな');expect(r.outcome).toMatchObject({mode:'retypeset'});
});
test('punctuation that no source column shows is refused precisely',async()=>{
 // 。 is encodable by the subset but never appears in this column.
 const f=await verticalFixture({text:'日本語かな。'}),stream=(code:(t:string)=>string)=>`BT /V1 16 Tf 1 0 0 1 210 210 Tm ${code('日本語かな')} Tj ET`;
 const g=await verticalFixture({text:'日本語かな。',stream});void f;
 const result=await applyContentTextEdits(g.page,[{...g.edit,originalText:'日本語かな',text:'日本語かな。'}],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-vertical-writing'});
 expect(result.outcomes[0]?.detail).toContain('has no observed vertical form');
});
test('full-size kana missing from the subset use the substitute nominal glyph',async()=>{
 const r=await edit('日本語かな','日本語かなさ');
 expect(r.outcome.mode).not.toBe('unsupported');
});
test('a small kana missing from the subset still needs its vertical alternate',async()=>{
 const r=await edit('日本語かな','日本語かっな');
 expect(r.outcome).toMatchObject({mode:'unsupported'});expect(r.outcome.detail).toContain('requires a vertical alternate');
});
test('one upright Latin scalar is accepted; a digit pair is refused as tate-chu-yoko',async()=>{
 expect((await edit('日本語かな','日本i語かな')).outcome.mode).not.toBe('unsupported');
 const pair=await edit('日本語かな','日本12かな');
 expect(pair.outcome).toMatchObject({mode:'unsupported'});expect(pair.outcome.detail).toContain('tate-chu-yoko');expect(pair.changed).toBe(false);
});
