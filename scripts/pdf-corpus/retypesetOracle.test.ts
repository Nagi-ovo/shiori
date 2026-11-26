import {expect,test} from 'bun:test';
import {compareRetypesetNativePages,gridColumnOwnership,selectRetypesetSourceSpans} from './retypesetOracle';
import type {RetypesetManifest} from '../../src/pdf/export/contentText/retypesetTypes';

// Failure list: duplicate old/new text elsewhere must not decide the edit;
// retained old text, wrong/missing local replacement, blank/tofu output,
// unrelated deletion/font/code/position changes, and pixels in mask holes or
// outside its one-pixel dilation must fail. Wrapped paragraph text may move.
const path=[{type:2,point:[1,1],closed:false}];
const glyph=(text:string,x:number,y=5)=>({text,origin:[x,y],box:[x,y-.5,x+.5,y+.5],inkBox:[x,y-.5,x+.5,y+.5],fontHash:'font',nativePath:path,inkPixels:2});
const before={width:10,height:10,text:'ABABZ',glyphs:[glyph('A',1),glyph('B',2),glyph('A',7),glyph('B',8),glyph('Z',9)],pixels:Buffer.alloc(1600,255)};
const after={...before,text:'XYABZ',glyphs:[glyph('X',1),glyph('Y',2),...before.glyphs.slice(2)],pixels:Buffer.from(before.pixels)};
const edit={originalText:'AB',text:'XY',coverRects:[{x:.9,y:4,w:1.2,h:2}]};
const pixel=(pixels:Uint8Array,x:number,y:number,value=0)=>{pixels[(Math.floor((10-y)*2)*20+Math.floor(x*2))*4]=value;};

test('retypeset replaces old text by position while an identical phrase elsewhere persists',()=>{
 expect(compareRetypesetNativePages(before,after,edit)).toMatchObject({replacementIndices:[0,1],replacementGlyphs:2,maxOriginDriftPt:0,changedPixelsOutsideRetypesetMask:0});
 expect(()=>compareRetypesetNativePages(before,before,edit)).toThrow('requested');
 const wrongPlace={...after,text:'ABXYZ',glyphs:[...before.glyphs.slice(0,2),glyph('X',7),glyph('Y',8),before.glyphs[4]!]};
 expect(()=>compareRetypesetNativePages(before,wrongPlace,edit)).toThrow('untargeted');
 const retained={...after,text:'ABXYABZ',glyphs:[...before.glyphs.slice(0,2),...after.glyphs]};
 expect(()=>compareRetypesetNativePages(before,retained,edit)).toThrow('requested');
});

test('a retypeset replacement must extract at the edit and have native path and ink',()=>{
 const far={...after,glyphs:[glyph('X',4),glyph('Y',5),...after.glyphs.slice(2)]};
 expect(()=>compareRetypesetNativePages(before,far,edit)).toThrow('anchor');
 expect(()=>compareRetypesetNativePages(before,{...after,text:'ABABZ'},edit)).toThrow('extracted');
 for(const bad of [{nativePath:[]},{inkPixels:0}])expect(()=>compareRetypesetNativePages(before,{...after,glyphs:[{...after.glyphs[0]!,...bad},...after.glyphs.slice(1)]},edit)).toThrow('replacement');
});

test('untargeted neighbour text retains multiplicity, font, outline and roughly the same position',()=>{
 for(const bad of [{fontHash:'other'},{origin:[7.02,5]},{nativePath:[{...path[0]!,point:[2,2]}]}]){
  expect(()=>compareRetypesetNativePages(before,{...after,glyphs:after.glyphs.map((g,i)=>i===2?{...g,...bad}:g)},edit)).toThrow('untargeted');
 }
 expect(()=>compareRetypesetNativePages(before,{...after,text:'XYAB',glyphs:after.glyphs.slice(0,-1)},edit)).toThrow('untargeted');
 expect(compareRetypesetNativePages(before,{...after,glyphs:after.glyphs.map((g,i)=>i===2?{...g,origin:[7.005,5]}:g)},edit)).toMatchObject({replacementGlyphs:2});
});

test('raster changes use old glyph ink union new text box, with exactly one pixel dilation',()=>{
 const source={...before,pixels:Buffer.from(before.pixels)};pixel(source.pixels,2.25,5.25);
 const output={...after,glyphs:[glyph('X',1),glyph('Y',1,3),...after.glyphs.slice(2)],pixels:Buffer.from(source.pixels)};
 pixel(output.pixels,2.25,5.25,255);pixel(output.pixels,1.25,3.25);
 expect(compareRetypesetNativePages(source,output,edit)).toMatchObject({changedPixels:2,changedPixelsOutsideRetypesetMask:0,maskDilationPx:1});
 const allowed=Buffer.from(output.pixels);pixel(allowed,2.75,5.25);
 expect(compareRetypesetNativePages(source,{...output,pixels:allowed},edit)).toMatchObject({changedPixelsOutsideRetypesetMask:0});
 for(const [x,y]of [[3.25,5.25],[2.25,3.25],[.25,.25]]){
  const pixels=Buffer.from(output.pixels);pixel(pixels,x!,y!);
  expect(()=>compareRetypesetNativePages(source,{...output,pixels},edit)).toThrow('outside retypeset mask');
 }
});

test('paragraph retypesetting preserves logical neighbours while allowing wrapping and new fonts',()=>{
 const source={...before,text:'CABDABZ',glyphs:[glyph('C',.5),...before.glyphs.slice(0,2),glyph('D',3),...before.glyphs.slice(2)]};
 const output={...after,text:'CXYDABZ',glyphs:[glyph('C',.5),glyph('X',1),glyph('Y',1,3),{...glyph('D',2,3),fontHash:'substitute'},...before.glyphs.slice(2)]};
 const manifest:RetypesetManifest={paragraphBox:{x:.4,y:4,w:3.2,h:2},substituteFont:null,lineCount:2,overflowed:true,pushed:false,pushedDeltaPt:0,pushedRegions:[],
  unchangedLineDriftPt:0,overflowInkOverlap:false,quality:{maxUnchangedLineStartXDriftPt:0,maxUnchangedLineBaselineDriftPt:0,overflowInkOverlap:false},reason:'overflow'};
 const ownership=source.glyphs.slice(0,4);
 expect(compareRetypesetNativePages(source,output,edit,manifest,ownership)).toMatchObject({replacementGlyphs:4});
 expect(()=>compareRetypesetNativePages(source,{...output,text:'CXYABZ',glyphs:output.glyphs.filter(g=>g.text!=='D')},edit,manifest,ownership)).toThrow('requested');
 expect(()=>compareRetypesetNativePages(source,output,edit,manifest)).toThrow('untargeted');
});

test('missing rasters and changed page dimensions fail closed',()=>{
 expect(()=>compareRetypesetNativePages(before,{...after,pixels:undefined},edit)).toThrow('raster');
 expect(()=>compareRetypesetNativePages(before,{...after,width:11},edit)).toThrow('width');
});

test('multiline positional selection disambiguates repeated source lines and keeps intervening objects',()=>{
 const source={...before,text:'ABZAB',glyphs:[glyph('A',1),glyph('B',2),glyph('Z',8,8),glyph('A',1,2),glyph('B',2,2)]};
 const edit={originalText:'AB\nAB',text:'XY\nAB',coverRects:[{x:.9,y:4,w:1.2,h:2},{x:.9,y:1,w:1.2,h:2}]};
 const output={...source,text:'XYZAB',glyphs:[glyph('X',1),glyph('Y',2),...source.glyphs.slice(2)]};
 expect(compareRetypesetNativePages(source,output,edit)).toMatchObject({replacementGlyphs:2,untargetedGlyphs:3});
 const joined={...output,text:'XYZ',glyphs:output.glyphs.slice(0,3)};
 expect(compareRetypesetNativePages(source,joined,{...edit,text:'XY'},undefined,[...source.glyphs.slice(0,2),...source.glyphs.slice(3)])).toMatchObject({replacementGlyphs:2,untargetedGlyphs:1});
});

// Claimed-push failures: a positive bearing puts the origin outside tight ink;
// old/new small-mark pixels are authorized, never an outsider or a wrong delta.
test('claimed pushed ink may exclude its glyph origin and still preserves outsider identity',()=>{
 const mark={...glyph('1',7,3),box:[7,2.5,8,4],inkBox:[7.5,3,8,4]};
 const source={...before,text:'AB1Z',glyphs:[...before.glyphs.slice(0,2),mark,glyph('Z',9,8)],pixels:Buffer.from(before.pixels)};
 pixel(source.pixels,7.75,3.75);pixel(source.pixels,6.25,3.75);
 const moved={...mark,origin:[7,1],box:[7,.5,8,2],inkBox:[7.5,1,8,2]};
 const output={...source,text:'XY1Z',glyphs:[...after.glyphs.slice(0,2),moved,source.glyphs[3]!],pixels:Buffer.from(source.pixels)};
 pixel(output.pixels,7.75,3.75,255);pixel(output.pixels,7.75,1.75);
 pixel(output.pixels,6.25,3.75,255);pixel(output.pixels,6.25,1.75);
 const manifest:RetypesetManifest={paragraphBox:{x:.9,y:4,w:1.2,h:2},substituteFont:null,lineCount:2,overflowed:true,pushed:true,pushedDeltaPt:2,
  pushedRegions:[{before:{x:7.5,y:3,w:.5,h:1},after:{x:7.5,y:1,w:.5,h:1}},{before:{x:6,y:3.5,w:.5,h:.5},after:{x:6,y:1.5,w:.5,h:.5}}],
  unchangedLineDriftPt:2,overflowInkOverlap:false,quality:{maxUnchangedLineStartXDriftPt:0,maxUnchangedLineBaselineDriftPt:0,overflowInkOverlap:false},reason:'overflow'};
 expect(compareRetypesetNativePages(source,output,edit,manifest)).toMatchObject({untargetedGlyphs:2,maxOriginDriftPt:0,changedPixels:4,changedPixelsOutsideRetypesetMask:0});
 expect(()=>compareRetypesetNativePages(source,output,edit)).toThrow('untargeted');
 for(const bad of [{origin:[7,1.02]},{fontHash:'wrong'},{nativePath:[]}])
  expect(()=>compareRetypesetNativePages(source,{...output,glyphs:[...output.glyphs.slice(0,2),{...moved,...bad},output.glyphs[3]!]},edit,manifest)).toThrow('untargeted');
 const outsider={...output,glyphs:[...output.glyphs.slice(0,3),glyph('Z',8.8,8)]};
 expect(()=>compareRetypesetNativePages(source,outsider,edit,manifest)).toThrow('untargeted');
 const pixels=Buffer.from(output.pixels);pixel(pixels,4.25,3.75);
 expect(()=>compareRetypesetNativePages(source,{...output,pixels},edit,manifest)).toThrow('outside retypeset mask');
 expect(()=>compareRetypesetNativePages(source,output,edit,{...manifest,pushedRegions:manifest.pushedRegions.slice(0,1)})).toThrow('outside retypeset mask');
});

// A column flow translates a region sideways too (into the next column); the
// glyph must land at exactly that translation, never at its old x.
test('a claimed pushed region may translate sideways',()=>{
 const mark={...glyph('1',7,3),box:[7,2.5,8,4],inkBox:[7.5,3,8,4]};
 const source={...before,text:'AB1Z',glyphs:[...before.glyphs.slice(0,2),mark,glyph('Z',9,8)],pixels:Buffer.from(before.pixels)};
 pixel(source.pixels,7.75,3.75);
 const moved={...mark,origin:[5,1],box:[5,.5,6,2],inkBox:[5.5,1,6,2]};
 const output={...source,text:'XY1Z',glyphs:[...after.glyphs.slice(0,2),moved,source.glyphs[3]!],pixels:Buffer.from(source.pixels)};
 pixel(output.pixels,7.75,3.75,255);pixel(output.pixels,5.75,1.75);
 const manifest:RetypesetManifest={paragraphBox:{x:.9,y:4,w:1.2,h:2},substituteFont:null,lineCount:2,overflowed:true,pushed:true,pushedDeltaPt:2,
  pushedRegions:[{before:{x:7.5,y:3,w:.5,h:1},after:{x:5.5,y:1,w:.5,h:1}}],
  unchangedLineDriftPt:2,overflowInkOverlap:false,quality:{maxUnchangedLineStartXDriftPt:0,maxUnchangedLineBaselineDriftPt:0,overflowInkOverlap:false},reason:'overflow'};
 expect(compareRetypesetNativePages(source,output,edit,manifest)).toMatchObject({untargetedGlyphs:2,maxOriginDriftPt:0});
 for(const origin of [[5.02,1],[7,1]])
  expect(()=>compareRetypesetNativePages(source,{...output,glyphs:[...output.glyphs.slice(0,2),{...moved,origin},output.glyphs[3]!]},edit,manifest)).toThrow('untargeted');
});

// A row-built overlay over staggered columns holds single cells of the next
// columns; the oracle groups columns from native origins and owns only the
// dominant column, and only when the strays' characters stay in place.
test('an interleaved column overlay owns its column, never the stray cells',()=>{
 const column=Array.from('善い事をした').map((t,i)=>glyph(t,8,9-i*.5)),stray=glyph('の',6,7.6);
 const glyphs=[...column.slice(0,4),stray,...column.slice(4)].sort((a,b)=>b.origin[1]!-a.origin[1]!||a.origin[0]!-b.origin[0]!);
 const covers=[{x:5.5,y:5.5,w:3,h:4}],edit2={originalText:'善い事をの した',text:'善い日をの した',coverRects:covers};
 const spans=selectRetypesetSourceSpans(glyphs,edit2);
 expect(spans).toHaveLength(1);expect(spans[0]!.glyphs).toEqual(column);expect(spans[0]!.text).toBe('善い日をした');
 expect(()=>selectRetypesetSourceSpans(glyphs,{...edit2,text:'善い事を日した'})).toThrow('positional');
});

// Stray-column recovery answers a missing positional source only: a covered
// set that reads as one column plus a single neighbouring cell still fails
// closed when the source text sits at two positions in it.
test('two positional solutions stay ambiguous even when the cover looks like a column with a stray cell',()=>{
 const column=Array.from('善い事善い事').map((t,i)=>glyph(t,8,9-i*.5)),stray=glyph('の',6,9.2);
 const glyphs=[stray,...column],covers=[{x:5.5,y:5.5,w:3,h:4}];
 expect(()=>selectRetypesetSourceSpans(glyphs,{originalText:'善い事',text:'善い日',coverRects:covers})).toThrow('ambiguous');
 expect(()=>selectRetypesetSourceSpans(glyphs,{originalText:'の善い事善い事',text:'の善い日善い事',coverRects:covers})).not.toThrow();
});

// A row-built overlay over three staggered columns with no dominant one: the
// oracle owns the one column the edit changes, never the others, and an edit
// across two columns has no owner.
test('an overlay over several interleaved columns owns only the column its edit changes',()=>{
 const a=Array.from('よる︒本').map((t,i)=>glyph(t,6,9-i*.5)),b=Array.from('利用し').map((t,i)=>glyph(t,7,9-i*.5)),c=glyph('文',8,8);
 // Content order is column by column, right to left, as LuaTeX-ja writes it.
 const glyphs=[c,...b,...a];
 const covers=[{x:5.5,y:6.5,w:3,h:3}],edit={originalText:'よ 利る 用︒ し 文本',text:'日 利る 用︒ し 文本',coverRects:covers};
 const spans=selectRetypesetSourceSpans(glyphs,edit);
 expect(spans).toHaveLength(1);expect(spans[0]!.glyphs).toEqual(a);expect(spans[0]!.text).toBe('日る︒本');
 expect(selectRetypesetSourceSpans(glyphs,{...edit,text:'よ 利る 日︒ し 文本'})[0]!.glyphs).toEqual(b);
 expect(()=>selectRetypesetSourceSpans(glyphs,{...edit,text:' 利よる 用︒ し 文本'})).toThrow('positional');
});

// Failure list for the oracle's short-column reading: horizontal line starts
// owned as a column; an isolated pair owned without a three-glyph run; a run
// on other rows or at another pitch counted; a nearer row glyph ignored.
test('a two-glyph column is owned only beside a stacked run on its rows',()=>{
 const col=(text:string,x:number)=>Array.from(text).map((t,i)=>glyph(t,x,30-i));
 const pair=col('王維',10),right=col('竹里館',11.7),far=col('獨坐幽篁裏',8.3);
 expect(gridColumnOwnership(pair,[...right,...pair,...far])?.pitch).toBe(1);
 expect(gridColumnOwnership(pair,pair)).toBeUndefined();
 expect(gridColumnOwnership(pair,[...pair,...col('竹里',11.7)])).toBeUndefined();
 expect(gridColumnOwnership(pair,[...pair,...Array.from('竹里館').map((t,i)=>glyph(t,11.7,29.5-i))])).toBeUndefined();
 expect(gridColumnOwnership(pair,[...pair,...right,glyph('a',10.8,30)])).toBeUndefined();
 // Lines one unit apart whose glyphs are one unit apart: stacked line starts.
 const lines=[0,1,2].flatMap(r=>Array.from('abcd').map((t,i)=>glyph(t,10+i,30-r)));
 expect(gridColumnOwnership(lines.filter(g=>g.origin[0]===10).slice(0,2),lines)).toBeUndefined();
});
