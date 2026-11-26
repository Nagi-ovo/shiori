import {expect,test} from 'bun:test';
import {type1RegionPage} from './reflowRegion.test-support';
import {inspectRunPage,resolveRunFonts} from '../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream} from '../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../contentStreamEdit/textState';
import {planStreamReflow} from './reflowAuto';
import {compileReflowPlan} from './reflowCompile';
import {overlay} from './fixtures.test-support';

async function fixture(){
 const f=await type1RegionPage('BT /F1 10 Tf 14 TL 50 150 Td (AB AB AB ) Tj ET '+
  'BT /F1 10 Tf 14 TL 50 136 Td (AB AB AB ) Tj ET '+
  'BT /F1 10 Tf 14 TL 50 122 Td (AB) Tj ( ) Tj ET');
 const s=inspectRunPage(f.page);if(!s.ok)throw Error(s.reason);
 const fonts=resolveRunFonts(f.page),edit=overlay({originalText:'AB AB AB \nAB AB AB ',text:'BA AB AB \nAB AB AB ',coverRects:[{x:49.5,y:135.5,w:46,h:22}]}),
  plan=planStreamReflow(f.page,s.bytes,fonts,edit);
 if(!plan?.reflow)throw Error('missing multiline wrap');
 const glyphs=(content:Uint8Array)=>{
  const w=walkTextPlacements(tokenizeContentStream(content),{resolveFont:name=>{
   const f=fonts.find(f=>f.resourceName===name);return f?{...f,ok:true,appliesWordSpacing:f.bytesPerCode===1}:null;
  }});if(!w.ok)throw Error(w.reason);
  return w.glyphs.map(g=>({code:g.code,font:g.fontName,quad:g.coreQuad}));
 };
 return {...f,s,fonts,plan,glyphs};
}
test('a multiline wrap retains an untouched trailing row including its isolated source space',async()=>{
 const f=await fixture(),out=compileReflowPlan(f.s.bytes,f.fonts,f.plan);
 expect(out.ok).toBe(true);if(!out.ok)throw Error(out.reason);
 expect(f.plan.reflow.layout.strategy).toBe('wrap');
 const before=f.glyphs(f.s.bytes),after=f.glyphs(out.bytes);
 expect(after.map(g=>g.code)).toEqual([...'BA AB AB AB AB AB AB '].map(c=>c.charCodeAt(0)));
 expect(after.slice(-3)).toEqual(before.slice(-3));
});
test('an isolated source space still refuses when its destination moves',async()=>{
 const f=await fixture(),r=f.plan.reflow,i=r.clusters.length-1;
 const origins=r.layout.origins.map((p,n)=>n===i?[p[0]+1,p[1]] as [number,number]:p);
 const out=compileReflowPlan(f.s.bytes,f.fonts,{...f.plan,reflow:{...r,layout:{...r.layout,origins}}});
 expect(out).toMatchObject({ok:false,bytes:f.s.bytes});
});
test('preserved source slots cannot bypass the independent output code walk',async()=>{
 const f=await fixture(),r=f.plan.reflow;
 const clusters=r.clusters.map((c,i)=>i===r.clusters.length-1?{...c,unicode:'A',code:Uint8Array.of(65)}:c);
 const out=compileReflowPlan(f.s.bytes,f.fonts,{...f.plan,reflow:{...r,clusters}});
 expect(out).toMatchObject({ok:false,bytes:f.s.bytes});
});
