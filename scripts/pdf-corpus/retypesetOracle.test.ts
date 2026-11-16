import {expect,test} from 'bun:test';
import {compareRetypesetNativePages} from './retypesetOracle';

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
 const manifest={paragraphBox:{x:.4,y:4,w:3.2,h:2},substituteFont:null,lineCount:2,overflowed:true,pushed:false as const,reason:'overflow' as const};
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
