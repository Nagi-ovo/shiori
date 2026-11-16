import {expect,test} from 'bun:test';
import {compareNativePages,expectedPopplerText} from './oracle';
const glyph=(text:string,x:number)=>({text,origin:[x,5],box:[x,4,x+1,6],fontHash:'font',nativePath:[{type:2,point:[1,1],closed:false}],inkPixels:2});
const before={width:10,height:10,text:'ABC',glyphs:[glyph('A',1),glyph('B',2),glyph('C',3)],pixels:Buffer.alloc(1600,255)};
const after={...before,text:'AXC',glyphs:[glyph('A',1),glyph('X',2),glyph('C',3)],pixels:Buffer.from(before.pixels)};
const edit={originalText:'ABC',text:'AXC',coverRects:[{x:0,y:3,w:5,h:4}]};
test('native sample checks expected text and every untouched glyph origin',()=>{
 expect(compareNativePages(before,after,edit)).toMatchObject({maxOriginDriftPt:0,changedPixelsOutsideBox:0,replacementGlyphs:1});
 expect(()=>compareNativePages(before,{...after,glyphs:[...after.glyphs.slice(0,2),glyph('C',3.02)]},edit)).toThrow('drift');
 expect(()=>compareNativePages(before,{...after,text:'ABC'},edit)).toThrow('text');
});
test('native sample rejects a single changed channel outside declared edit boxes',()=>{
 const pixels=Buffer.from(after.pixels);pixels[0]=0;
 expect(()=>compareNativePages(before,{...after,pixels},edit)).toThrow('outside');
});
test('native clusters cannot be indexed as scalar glyphs',()=>{
 const clustered={...before,text:'fiBC',glyphs:[{...before.glyphs[0]!,text:'fi'},...before.glyphs.slice(1)]};
 expect(()=>compareNativePages(clustered,{...after,text:'fxBC',glyphs:[{...after.glyphs[0]!,text:'fx'},...after.glyphs.slice(1)]},{...edit,originalText:'fiBC',text:'fxBC'})).toThrow('scalar');
});
test('native multiline audit preserves unrelated source glyphs between selected lines',()=>{
 const source={...before,text:'ABZCD',glyphs:[glyph('A',1),glyph('B',2),{...glyph('Z',8),origin:[8,7]}, {...glyph('C',1),origin:[1,2]},{...glyph('D',2),origin:[2,2]}]};
 const edited={...source,text:'B AZCD'.replace(' ',''),glyphs:[glyph('B',1),glyph('A',2),...source.glyphs.slice(2)]};
 const multiline={originalText:'AB\nCD',text:'BA\nCD',coverRects:[{x:0,y:4,w:4,h:2},{x:0,y:1,w:4,h:2}]};
 expect(compareNativePages(source,edited,multiline)).toMatchObject({maxOriginDriftPt:0,replacementGlyphs:2});
 expect(()=>compareNativePages(source,{...edited,glyphs:edited.glyphs.map(g=>g.text==='Z'?{...g,origin:[8.02,7]}:g)},multiline)).toThrow('drift');
});

test('Poppler multiline expectation preserves text between separately selected lines',()=>{
 expect(expectedPopplerText('AB Z CD',{originalText:'AB\nCD',text:'BA\nCD'})).toBe('BAZCD');
 expect(()=>expectedPopplerText('AB Z EF',{originalText:'AB\nCD',text:'BA\nCD'})).toThrow('source mismatch');
});
test('an untouched native space must retain its origin even when text and ink are unchanged',()=>{
 const source={...before,text:'A BC',glyphs:[glyph('A',1),{...glyph(' ',1.5),nativePath:[],inkPixels:0},glyph('B',2),glyph('C',3)]};
 const edited={...source,text:'A XC',glyphs:[...source.glyphs.slice(0,2),glyph('X',2),glyph('C',3)]};
 expect(compareNativePages(source,edited,{...edit,originalText:'A BC',text:'A XC'})).toMatchObject({maxOriginDriftPt:0});
 expect(()=>compareNativePages(source,{...edited,glyphs:edited.glyphs.map(g=>g.text===' '?{...g,origin:[1.52,5]}:g)},{...edit,originalText:'A BC',text:'A XC'})).toThrow('drift');
});

test('manifest-aware audit checks owned movement while keeping unowned glyphs strict',async()=>{
 const {compareReflowNativePages}=await import('./reflowOracle');
 const reflowEdit={originalText:'B',text:'X',coverRects:[{x:1.9,y:4,w:.2,h:2}]};
 const box={x:1,y:4,w:4,h:2};
 const manifest={strategy:'suffix-shift' as const,sourceHash:'source',dependencyHash:'deps',region:{box,mask:[box],oldInk:[{x:1.5,y:4.5,w:2,h:1}]},
  source:[{unicode:'B',origin:[2,5],fontHash:'font'},{unicode:'C',origin:[3,5],fontHash:'font'}],
  output:[{unicode:'X',origin:[2,5]},{unicode:'C',origin:[3.2,5],oldOrigin:[3,5],fontHash:'font'}]};
 const moved={...after,glyphs:[glyph('A',1),glyph('X',2),glyph('C',3.2)]};
 expect(()=>compareNativePages(before,moved,reflowEdit)).toThrow('drift');
 expect(compareReflowNativePages(before,moved,reflowEdit,manifest)).toMatchObject({maxOriginDriftPt:0,replacementGlyphs:1});
 expect(()=>compareReflowNativePages(before,{...moved,glyphs:[glyph('A',1.02),...moved.glyphs.slice(1)]},reflowEdit,manifest)).toThrow('drift');
 expect(()=>compareReflowNativePages(before,{...moved,glyphs:[...moved.glyphs.slice(0,2),glyph('C',3.22)]},reflowEdit,manifest)).toThrow('destination');
 expect(()=>compareReflowNativePages(before,{...moved,glyphs:[...moved.glyphs.slice(0,2),{...glyph('C',3.2),fontHash:'other'}]},reflowEdit,manifest)).toThrow('font');
 const pixels=Buffer.from(before.pixels);pixels[0]=0;
 expect(()=>compareReflowNativePages(before,{...moved,pixels},reflowEdit,manifest)).toThrow('outside');
});
