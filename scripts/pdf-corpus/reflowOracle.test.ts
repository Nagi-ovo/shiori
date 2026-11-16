import {expect,test} from 'bun:test';
import {compareReflowNativePages} from './reflowOracle';
const glyph=(text:string,x:number,y=5)=>({text,origin:[x,y],fontHash:'font',nativePath:[{type:2,point:[1,1],closed:false}],inkPixels:2});
const before={width:10,height:10,text:'ABC',glyphs:[glyph('A',1),glyph('B',2),glyph('C',3)],pixels:Buffer.alloc(1600,255)};
const after={...before,text:'AXC',glyphs:[glyph('A',1),glyph('X',2),glyph('C',3.2)],pixels:Buffer.from(before.pixels)};
const edit={originalText:'B',text:'X',coverRects:[{x:1.9,y:4,w:.2,h:2}]};
const box={x:1,y:4,w:3,h:2},oldInk=[{x:1.5,y:4.5,w:2,h:1}];
const manifest={strategy:'suffix-shift' as const,sourceHash:'source',dependencyHash:'deps',region:{box,mask:[box],oldInk},
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
 const box={x:1,y:2,w:3,h:4};
 const grown={...manifest,strategy:'wrap' as const,region:{box,mask:[box],oldInk},output:[manifest.output[0]!,{...manifest.output[1]!,origin:[1,3]}]};
 expect(compareReflowNativePages(before,{...after,glyphs:[...after.glyphs.slice(0,2),glyph('C',1,3)]},edit,grown)).toMatchObject({maxOriginDriftPt:0,changedPixelsOutsideBox:0});
});
test('pixels inside the union bound but outside every glyph mask are rejected',()=>{
 const mask=[{x:1,y:4,w:1.5,h:2},{x:3,y:4,w:1,h:2}];
 const pixels=Buffer.from(after.pixels);pixels[(9*20+5)*4]=0; // (2.75, 5.25), in the hole
 expect(()=>compareReflowNativePages(before,{...after,pixels},edit,{...manifest,region:{...manifest.region,mask}})).toThrow('outside');
 pixels[(9*20+5)*4]=255;pixels[(9*20+4)*4]=0; // inside the first rectangle
 expect(compareReflowNativePages(before,{...after,pixels},edit,{...manifest,region:{...manifest.region,mask}})).toMatchObject({changedPixels:1,changedPixelsOutsideMask:0});
});
const hiddenSpace={unicode:' ',origin:[3.5,5],fontHash:'font'};
const hiddenManifest={...manifest,source:[...manifest.source,hiddenSpace],output:[...manifest.output,{...hiddenSpace,oldOrigin:hiddenSpace.origin}]};
test('a source space absent in both native snapshots may remain unchanged',()=>{
 expect(compareReflowNativePages(before,after,edit,hiddenManifest)).toMatchObject({nativeUnobservableUnchangedSpaces:1,changedPixelsOutsideMask:0});
});
test('a natively unobservable source space cannot move without destination evidence',()=>{
 const output=[...manifest.output,{...hiddenSpace,origin:[3.6,5],oldOrigin:hiddenSpace.origin}];
 expect(()=>compareReflowNativePages(before,after,edit,{...hiddenManifest,output})).toThrow('whitespace count');
});
test('an observed source space cannot disappear from native extraction',()=>{
 const observed={...before,glyphs:[...before.glyphs,glyph(' ',3.5)]};
 expect(()=>compareReflowNativePages(observed,after,edit,hiddenManifest)).toThrow('whitespace count');
});
test('unobservable spaces cannot gain an unverified font change',()=>{
 const output=[...manifest.output,{...hiddenSpace,fontHash:'other',oldOrigin:hiddenSpace.origin}];
 expect(()=>compareReflowNativePages(before,after,edit,{...hiddenManifest,output})).toThrow('whitespace count');
});
test('newly inserted whitespace always needs native destination evidence',()=>{
 const output=[...manifest.output,hiddenSpace];
 expect(()=>compareReflowNativePages(before,after,edit,{...manifest,output})).toThrow('whitespace count');
});
function ligatureSample(unicode='fi'){
 const components=Array.from(unicode).map((s,i)=>({...glyph(s,3),nativePath:[{type:2,point:[i+2,1],closed:false}]}));
 const before={width:10,height:10,text:`Re${unicode}nsZ`,glyphs:[glyph('R',1),glyph('e',2),...components,glyph('n',4),glyph('s',5),glyph('Z',8)],pixels:Buffer.alloc(1600,255)};
 const pixels=Buffer.from(before.pixels);pixels[(9*20+4)*4]=0;
 const after={...before,text:`Xy${unicode}nsZ`,glyphs:[glyph('X',1),glyph('y',2),...components.map((g,i)=>({...g,origin:[3+i*.4,5]})),glyph('n',4.2),glyph('s',5.2),glyph('Z',8)],pixels};
 const box={x:.5,y:4,w:5.5,h:2};
 const manifest={strategy:'suffix-shift' as const,sourceHash:'source',dependencyHash:'deps',region:{box,mask:[box],oldInk:[box]},
  source:[{unicode:'R',origin:[1,5],fontHash:'font'},{unicode:'e',origin:[2,5],fontHash:'font'},{unicode,origin:[3,5],fontHash:'font'},
   {unicode:'n',origin:[4,5],fontHash:'font'},{unicode:'s',origin:[5,5],fontHash:'font'}],
  output:[{unicode:'X',origin:[1,5]},{unicode:'y',origin:[2,5]},...components.map((g,i)=>({unicode:g.text,origin:[3+i*.4,5]})),
   {unicode:'n',origin:[4.2,5],oldOrigin:[4,5],fontHash:'font'},{unicode:'s',origin:[5.2,5],oldOrigin:[5,5],fontHash:'font'}]};
 return {before,after,manifest,edit:{originalText:`Re${unicode}`,text:`Xy${unicode}`,coverRects:[{x:.9,y:4,w:2.2,h:2}]}};
}
for(const unicode of ['fi','ff','fl','ffi','ffl','𝑓i'])test(`manifest ${unicode} source cluster matches native scalars at its recorded origin`,()=>{
 const {before,after,edit,manifest}=ligatureSample(unicode);
 const observed={...before,glyphs:before.glyphs.map((g,i)=>i>=2&&i<2+Array.from(unicode).length?{...g,origin:[3.00003,5]}:g)};
 expect(compareReflowNativePages(observed,after,edit,manifest)).toMatchObject({changedPixels:1,changedPixelsOutsideMask:0,replacementGlyphs:2+Array.from(unicode).length});
});
test('the native suffix after a split source cluster remains unowned and cannot drift',()=>{
 const {before,after,edit,manifest}=ligatureSample();
 const window={...manifest,source:manifest.source.slice(0,3),output:manifest.output.slice(0,4)};
 const saved={...after,glyphs:[...after.glyphs.slice(0,4),...before.glyphs.slice(4)]};
 expect(compareReflowNativePages(before,saved,edit,window)).toMatchObject({changedPixelsOutsideMask:0});
 const moved={...saved,glyphs:saved.glyphs.map((g,i)=>i===4?{...g,origin:[4.006,5]}:g)};
 expect(()=>compareReflowNativePages(before,moved,edit,window)).toThrow('untouched glyph drift');
});
test('an edit can select the last native scalar in a source window containing a cluster',()=>{
 const {before,manifest}=ligatureSample();
 const output=manifest.source.map(e=>e.unicode==='s'?{unicode:'t',origin:e.origin}:{...e,oldOrigin:e.origin});
 const saved={...before,text:'RefintZ',glyphs:before.glyphs.map(g=>g.text==='s'?glyph('t',5):g)};
 const edit={originalText:'s',text:'t',coverRects:[{x:4.9,y:4,w:.2,h:2}]};
 expect(compareReflowNativePages(before,saved,edit,{...manifest,output})).toMatchObject({changedPixelsOutsideMask:0,replacementGlyphs:1});
});
for(const origins of [[3,3.006],[3.006,3.006],[2.996,3.004]])test(`source cluster components are measured from the recorded origin: ${origins}`,()=>{
 const {before,after,edit,manifest}=ligatureSample();
 const observed={...before,glyphs:before.glyphs.map((g,i)=>i===2||i===3?{...g,origin:[origins[i-2]!,5]}:g)};
 if(origins.every(x=>Math.abs(x-3)<=.005))expect(compareReflowNativePages(observed,after,edit,manifest)).toMatchObject({changedPixelsOutsideMask:0});
 else expect(()=>compareReflowNativePages(observed,after,edit,manifest)).toThrow('manifest source sequence/origin differs');
});
for(const texts of [['f','x'],['i','f'],['fi',''],['f','x','i'],['f']])test(`source cluster cannot skip, reorder or group native glyphs: ${texts}`,()=>{
 const {before,after,edit,manifest}=ligatureSample();
 const observed={...before,glyphs:[...before.glyphs.slice(0,2),...texts.map(t=>glyph(t,3)),...before.glyphs.slice(4)]};
 expect(()=>compareReflowNativePages(observed,after,edit,manifest)).toThrow('manifest source sequence/origin differs');
});
test('every source cluster component must match the recorded font',()=>{
 const {before,after,edit,manifest}=ligatureSample();
 const observed={...before,glyphs:before.glyphs.map((g,i)=>i===3?{...g,fontHash:'other'}:g)};
 expect(()=>compareReflowNativePages(observed,after,edit,manifest)).toThrow('manifest source font differs');
});
test('the first source entry may itself be a ligature cluster',()=>{
 const {before,after,manifest}=ligatureSample();
 const window={...manifest,source:manifest.source.slice(2),output:[{unicode:'x',origin:[3,5]},{unicode:'y',origin:[3.4,5]},...manifest.output.slice(4)]};
 const saved={...after,text:'RexynsZ',glyphs:[...before.glyphs.slice(0,2),glyph('x',3),glyph('y',3.4),...after.glyphs.slice(4)]};
 const edit={originalText:'fi',text:'xy',coverRects:[{x:2.9,y:4,w:.2,h:2}]};
 expect(compareReflowNativePages(before,saved,edit,window)).toMatchObject({changedPixelsOutsideMask:0,replacementGlyphs:2});
});
function retainedLigatureSample(){
 const sample=ligatureSample();
 const output=[...sample.manifest.output.slice(0,2),{unicode:'fi',origin:[3.2,5],oldOrigin:[3,5],fontHash:'font'},...sample.manifest.output.slice(4)];
 const glyphs=sample.after.glyphs.map((g,i)=>i===2||i===3?{...g,origin:[3.2,5]}:g);
 return {...sample,after:{...sample.after,glyphs},manifest:{...sample.manifest,output}};
}
test('a retained output cluster keeps each native source component identity',()=>{
 const {before,after,edit,manifest}=retainedLigatureSample();
 expect(compareReflowNativePages(before,after,edit,manifest)).toMatchObject({changedPixelsOutsideMask:0,replacementGlyphs:2,replacementIndices:[0,1]});
 const swapped={...after,glyphs:after.glyphs.map((g,i)=>i===2||i===3?{...g,nativePath:before.glyphs[5-i]!.nativePath}:g)};
 expect(()=>compareReflowNativePages(before,swapped,edit,manifest)).toThrow('owned/untouched outline changed');
 const output=manifest.output.map(e=>({...e,fontHash:undefined}));
 const changed={...after,glyphs:after.glyphs.map((g,i)=>i===3?{...g,fontHash:'other'}:g)};
 expect(()=>compareReflowNativePages(before,changed,edit,{...manifest,output})).toThrow('owned/untouched font program changed');
});
for(const oldOrigin of [[3.02,5],[8,5]])test(`retained cluster identity must come from the owned source window: ${oldOrigin}`,()=>{
 const {before,after,edit,manifest}=retainedLigatureSample();
 const observed={...before,text:'RefinsZfi',glyphs:[...before.glyphs,glyph('f',8),glyph('i',8)]};
 const output=manifest.output.map(e=>e.unicode==='fi'?{...e,oldOrigin}:e);
 const saved={...after,text:'XyfinsZfi',glyphs:[...after.glyphs,...observed.glyphs.slice(-2)]};
 expect(()=>compareReflowNativePages(observed,saved,edit,{...manifest,output})).toThrow('owned output identity missing');
});
for(const index of [2,3])test(`every retained output cluster component checks font and destination (${index})`,()=>{
 const {before,after,edit,manifest}=retainedLigatureSample();
 const font={...after,glyphs:after.glyphs.map((g,i)=>i===index?{...g,fontHash:'other'}:g)};
 expect(()=>compareReflowNativePages(before,font,edit,manifest)).toThrow('manifest output font differs');
 const moved={...after,glyphs:after.glyphs.map((g,i)=>i===index?{...g,origin:[3.206,5]}:g)};
 expect(()=>compareReflowNativePages(before,moved,edit,manifest)).toThrow('destination');
});
test('a replacement output cluster audits each scalar font, destination, path and ink',()=>{
 const {before,after,manifest}=ligatureSample();
 const output=[{unicode:'fl',origin:[1.5,5],fontHash:'substitute'},...manifest.source.slice(3).map(e=>({...e,oldOrigin:e.origin}))];
 const saved={...after,text:'flnsZ',glyphs:[{...glyph('f',1.5),fontHash:'substitute'},{...glyph('l',1.5),fontHash:'substitute'},...before.glyphs.slice(4)]};
 const edit={originalText:'Refi',text:'fl',coverRects:[{x:.9,y:4,w:2.2,h:2}]};
 const replacement={...manifest,output};
 expect(compareReflowNativePages(before,saved,edit,replacement)).toMatchObject({changedPixelsOutsideMask:0,replacementGlyphs:2,replacementIndices:[0,1]});
 for(const [change,message] of [[{fontHash:'other'},'manifest output font differs'],[{origin:[1.506,5]},'destination'],[{nativePath:[]},'replacement path missing'],[{inkPixels:0},'replacement has no ink']] as const){
  const altered={...saved,glyphs:saved.glyphs.map((g,i)=>i===1?{...g,...change}:g)};
  expect(()=>compareReflowNativePages(before,altered,edit,replacement)).toThrow(message);
 }
 const clustered={...saved,glyphs:[{...saved.glyphs[0]!,text:'fl'},...saved.glyphs.slice(2)]};
 expect(()=>compareReflowNativePages(before,clustered,edit,replacement)).toThrow('native glyph count mismatch');
});
