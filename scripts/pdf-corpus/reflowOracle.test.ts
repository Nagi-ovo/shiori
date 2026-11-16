import {expect,test} from 'bun:test';
import {compareReflowNativePages} from './reflowOracle';
const glyph=(text:string,x:number,y=5)=>({text,origin:[x,y],fontHash:'font',nativePath:[{type:2,point:[1,1],closed:false}],inkPixels:2});
const before={width:10,height:10,text:'ABC',glyphs:[glyph('A',1),glyph('B',2),glyph('C',3)],pixels:Buffer.alloc(1600,255)};
const after={...before,text:'AXC',glyphs:[glyph('A',1),glyph('X',2),glyph('C',3.2)],pixels:Buffer.from(before.pixels)};
const edit={originalText:'B',text:'X',coverRects:[{x:1.9,y:4,w:.2,h:2}]};
const manifest={strategy:'suffix-shift' as const,sourceHash:'source',dependencyHash:'deps',region:{box:{x:1,y:4,w:3,h:2}},
 source:[{unicode:'B',origin:[2,5],fontHash:'font'},{unicode:'C',origin:[3,5],fontHash:'font'}],
 output:[{unicode:'X',origin:[2,5]},{unicode:'C',origin:[3.2,5],oldOrigin:[3,5],fontHash:'font'}]};
test('unowned native origin drift above 0.005 pt is rejected',()=>{
 const moved={...after,glyphs:[glyph('A',1.006),...after.glyphs.slice(1)]};
 expect(()=>compareReflowNativePages(before,moved,edit,manifest)).toThrow('drift');
});
test('manifest regions have no implicit half-point pixel allowance',()=>{
 // Pixel centre (4.25, 5.25) is just outside right=4.
 const pixels=Buffer.from(after.pixels);pixels[(9*20+8)*4]=0;
 expect(()=>compareReflowNativePages(before,{...after,pixels},edit,manifest)).toThrow('outside');
});
test('a proved downward extension permits exact owned destinations inside it',()=>{
 const grown={...manifest,strategy:'wrap' as const,region:{box:{x:1,y:2,w:3,h:4}},output:[manifest.output[0]!,{...manifest.output[1]!,origin:[1,3]}]};
 expect(compareReflowNativePages(before,{...after,glyphs:[...after.glyphs.slice(0,2),glyph('C',1,3)]},edit,grown)).toMatchObject({maxOriginDriftPt:0,changedPixelsOutsideBox:0});
});
test('pixels inside the union bound but outside every glyph mask are rejected',()=>{
 const mask=[{x:1,y:4,w:1.5,h:2},{x:3,y:4,w:1,h:2}];
 const pixels=Buffer.from(after.pixels);pixels[(9*20+5)*4]=0; // (2.75, 5.25), in the hole
 expect(()=>compareReflowNativePages(before,{...after,pixels},edit,{...manifest,region:{...manifest.region,mask}})).toThrow('outside');
 pixels[(9*20+5)*4]=255;pixels[(9*20+4)*4]=0; // inside the first rectangle
 expect(compareReflowNativePages(before,{...after,pixels},edit,{...manifest,region:{...manifest.region,mask}})).toMatchObject({changedPixels:1,changedPixelsOutsideMask:0});
});
