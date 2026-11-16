import {expect,test} from 'bun:test';
import {compareReflowNativePages} from './reflowOracle';

const glyph=(text:string,x:number)=>({text,origin:[x,5],fontHash:'font',nativePath:[1],inkPixels:1});
const pixels=()=>Buffer.alloc(20*20*4,255);
const original={width:10,height:10,text:'AB',glyphs:[glyph('A',2),glyph('B',3)],pixels:pixels()};
const after={...original,text:'XB',glyphs:[glyph('X',2),glyph('B',3)],pixels:pixels()};
const edit={originalText:'A',text:'X',coverRects:[{x:1.9,y:4,w:.2,h:2}]};
const oldInk=[{x:1.5,y:4.5,w:1,h:1},{x:2.5,y:4.5,w:1,h:1}];
const manifest={strategy:'suffix-shift' as const,sourceHash:'s',dependencyHash:'d',
 region:{box:{x:1,y:4,w:4,h:2},mask:[{x:1,y:4,w:4,h:2}],oldInk},
 source:[{unicode:'A',origin:[2,5]},{unicode:'B',origin:[3,5]}],
 output:[{unicode:'X',origin:[2,5]},{unicode:'B',origin:[3,5],oldOrigin:[3,5]}]};
function paint(x:number,channel=0,value=0){const p=pixels();p[(9*20+x)*4+channel]=value;return p;}
test('original owned ink inside the fixed mask passes the raster veto',()=>{
 expect(compareReflowNativePages({...original,pixels:paint(4)},after,edit,manifest)).toMatchObject({unexplainedOriginalPixels:0,originalInkPixelsInsideMask:1});
});
for(const value of [0,254])test(`unexplained original paint vetoes even when unchanged in the saved page (${value})`,()=>{
 const p=paint(8,1,value); // centre 4.25, 5.25: inside mask, outside owned old ink
 expect(()=>compareReflowNativePages({...original,pixels:p},{...after,pixels:p},edit,manifest)).toThrow('raster veto');
});
test('raster emptiness cannot supply missing old-ink evidence',()=>{
 expect(()=>compareReflowNativePages(original,after,edit,{...manifest,region:{box:manifest.region.box,mask:manifest.region.mask}})).toThrow('old ink');
});
test('original paint outside the mask is not a raster veto',()=>{
 const p=paint(0);expect(compareReflowNativePages({...original,pixels:p},{...after,pixels:p},edit,manifest)).toMatchObject({unexplainedOriginalPixels:0,originalInkPixelsInsideMask:0});
});
test('a veto never widens the fixed mask',()=>{
 const p=paint(8),saved=structuredClone(manifest);
 try{compareReflowNativePages({...original,pixels:p},{...after,pixels:p},edit,manifest);}catch{/* inspect immutable input below */}
 expect(manifest).toEqual(saved);
});
