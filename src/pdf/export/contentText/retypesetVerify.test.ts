import {expect,test} from 'bun:test';
import {verifyRetypesetGlyphs} from './retypesetVerify';

const glyph=(x:number,y=100,code=65,fontName='F1')=>({fontName,code,
 coreQuad:[{x,y}],quad:[{x,y},{x:x+6,y},{x:x+6,y:y+10},{x,y:y+10}]});
const destination=(x:number,y=100,code=65,fontName='F1')=>({fontName,code,point:{x,y}});

test('destination and untouched quads tolerate 1e-5 and half-ULP boundary noise',()=>{
 for(const delta of [-1e-5,-5e-6,-1e-11,1e-5,5e-6,1e-11]){
  expect(()=>verifyRetypesetGlyphs([glyph(388.185795+delta)],[],[destination(388.185795)])).not.toThrow();
  expect(()=>verifyRetypesetGlyphs([glyph(388.185795+delta)],[glyph(388.185795)],[])).not.toThrow();
 }
});
test('wrong codes, fonts and a half-point slip refuse, including untouched corners',()=>{
 for(const actual of [glyph(50.5),glyph(50,100.5),glyph(50,100,66),glyph(50,100,65,'F2')])
  expect(()=>verifyRetypesetGlyphs([actual],[],[destination(50)])).toThrow('output glyph font, codes or destination differs');
 const corner=glyph(50);corner.quad[2]!.y+=.5;
 expect(()=>verifyRetypesetGlyphs([corner],[glyph(50)],[])).toThrow('untargeted glyph');
 expect(()=>verifyRetypesetGlyphs([glyph(50.001)],[],[destination(50)])).toThrow();
});
test('matching consumes identities once and refuses missing or extra glyphs',()=>{
 expect(()=>verifyRetypesetGlyphs([glyph(50)],[],[destination(50),destination(50)])).toThrow();
 expect(()=>verifyRetypesetGlyphs([glyph(50),glyph(50)],[],[destination(50),destination(50)])).not.toThrow();
 expect(()=>verifyRetypesetGlyphs([glyph(50),glyph(60)],[],[destination(50)])).toThrow('glyph count');
 expect(()=>verifyRetypesetGlyphs([glyph(50)],[glyph(50)],[destination(50)])).toThrow();
});
