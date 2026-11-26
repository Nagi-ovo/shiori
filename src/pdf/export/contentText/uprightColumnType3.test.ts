import {expect,test} from 'bun:test';
import {applyContentTextEdits} from './apply';
import {substituteSourceFonts} from '../contentStreamEdit/substituteSource';
import {inspectRunPage} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {readRetypesetSource,address} from './retypesetSource';
import {singleGlyphActualText} from './uprightColumnActualText';
import {loadFont,verticalCorpusPage} from './uprightColumn.fixture.test';
import {selectRetypeset} from './retypesetPlan';
import {overlay} from './fixtures.test-support';

// Failure list (browser-printed Type 3 with ToUnicode): y-mirrored Type 3 fonts
// admitted into callers that do not compose the mirror (horizontal paths);
// the page reported as having no text layer; one-glyph ActualText ignored
// so punctuation never matches; the replaced glyph's ActualText left behind
// (extraction would still read the old character); a reused code whose
// ToUnicode differs from the intended scalar extracted wrongly.
test('y-mirrored Type 3 fonts are admitted only on request',async()=>{
 const {page}=await verticalCorpusPage('vert-browser-jp-kumo');
 expect(substituteSourceFonts(page).length).toBe(0);
 const opted=substituteSourceFonts(page,{flippedType3:true});
 expect(opted.length).toBeGreaterThan(0);expect(opted.every(f=>f.glyphFlipY)).toBe(true);
});

function readUprightColumn(page:Awaited<ReturnType<typeof verticalCorpusPage>>['page']){
 const content=inspectRunPage(page);if(!content.ok)throw Error(content.reason);
 const ops=tokenizeContentStream(content.bytes),read=readRetypesetSource(page,ops,{},undefined,{flippedType3:true});
 const labels=singleGlyphActualText(ops,read.glyphs);
 return{labels,read};
}
test('one-glyph ActualText spans label Type 3 punctuation',async()=>{
 const {page}=await verticalCorpusPage('vert-browser-jp-kumo'),{labels,read}=readUprightColumn(page);
 const texts=new Set([...labels.values()].map(l=>l.text));
 expect(texts.has('、')).toBe(true);expect(texts.has('。')).toBe(true);
 expect(read.glyphs.some(g=>labels.has(address(g.glyph))&&g.text!==labels.get(address(g.glyph))!.text)).toBe(true);
});

test('a browser-printed Type 3 vertical column edit is written and extracts the new text',async()=>{
 const {page}=await verticalCorpusPage('vert-browser-jp-kumo'),{read,labels}=readUprightColumn(page);
 // Build the selection from the opted-in walk: the longest stacked column.
 const relabeled=read.glyphs.map(g=>{const l=labels.get(address(g.glyph));return l?{...g,text:l.text}:g;});
 const byX=new Map<number,typeof relabeled>();for(const g of relabeled){const k=Math.round(g.x);byX.set(k,[...(byX.get(k)??[]),g]);}
 const column=[...byX.values()].sort((a,b)=>b.length-a.length)[0]!.sort((a,b)=>b.y-a.y).slice(0,10);
 const covers=column.map(g=>{const xs=g.glyph.quad.map(p=>p.x),ys=g.glyph.quad.map(p=>p.y);return{x:Math.min(...xs)-.8,y:Math.min(...ys)-.8,w:Math.max(...xs)-Math.min(...xs)+1.6,h:Math.max(...ys)-Math.min(...ys)+1.6};});
 const originalText=column.map(g=>g.text).join(''),text=Array.from(originalText).map((c,i,a)=>i===0?a[1]!:i===1?a[0]!:c).join('');
 const edit=overlay({originalText,text,coverRects:covers,rect:covers[0]!,fontSize:13});
 expect(selectRetypeset(relabeled,edit).length).toBeGreaterThan(0);
 const result=await applyContentTextEdits(page,[edit],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'retypeset'});
 const after=readUprightColumn(page),labelOf=(g:typeof after.read.glyphs[number])=>after.labels.get(address(g.glyph))?.text??g.text;
 const x=column[0]!.x,top=column[0]!.y,bottom=column.at(-1)!.y;
 const shown=after.read.glyphs.filter(g=>Math.abs(g.x-x)<1&&g.y<=top+.01&&g.y>=bottom-.01).sort((a,b)=>b.y-a.y);
 expect(shown.map(labelOf).join('').normalize('NFKC')).toBe(text.normalize('NFKC'));
},30_000);

// A vertical-rl multicol page can run columns past the left page edge (an
// earlier generation of this fixture did); an overlay over one has covers
// cut at x=0 and selects no visible column. The refusal stays type3-text
// and names that cause.
test('a Type 3 selection cut at the page edge is refused precisely',async()=>{
 const {page}=await verticalCorpusPage('vert-browser-jp-2col');
 const covers=[0,1,2,3].map(i=>({x:0,y:760-9*i,w:3.7,h:10.5}));
 const edit=overlay({originalText:'の儁才李',text:'儁才の李',coverRects:covers,rect:covers[0]!,fontSize:9});
 const result=await applyContentTextEdits(page,[edit],{loadFont});
 expect(result.outcomes[0]).toMatchObject({mode:'unsupported',reason:'unsupported-unwritable'});
 expect(result.outcomes[0]!.detail).toMatch(/^type3-text: .*cut at the page edge/u);
 // The same selection inside the page keeps the generic column refusal.
 const inside=overlay({originalText:'の儁才李',text:'儁才の李',coverRects:covers.map(r=>({...r,x:300})),rect:{...covers[0]!,x:300},fontSize:9});
 const other=await applyContentTextEdits((await verticalCorpusPage('vert-browser-jp-2col')).page,[inside],{loadFont});
 expect(other.outcomes[0]!.detail??'').not.toContain('page edge');
},30_000);
