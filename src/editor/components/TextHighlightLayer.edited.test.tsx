import '../../test/setupDom';
import '../../i18n';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,test} from 'bun:test';
import {TextHighlightLayer} from './TextHighlightLayer';
import {ContentTextPreviewSurface} from './ContentTextPreviewSurface';
import {fixture,model,overlay} from '../../pdf/export/contentText/fixtures.test-support';
import {fakePdfDocument,withFakePdfEngine} from '../../test/fakePdfEngine';
import {useEditorStore} from '../store/store';
const initial=useEditorStore.getState(),original=fakePdfDocument(),derived=fakePdfDocument();
const text=(str:string)=>({content:{items:[{str,dir:'ltr' as const,transform:[10,0,0,10,50,100],width:30,height:10,fontName:'f',hasEOL:false}],styles:{f:{fontFamily:'sans-serif',ascent:.8,descent:-.2,vertical:false}},lang:null},glyphs:null,fontNames:new Map(),faceFamilies:new Map()});
withFakePdfEngine({load:async bytes=>({doc:derived,bytes}),pageText:async doc=>text(doc===original?'ABCDE':'AXCDE'),destroy:async()=>{},renderRegion:()=>({cancel:()=>{},done:Promise.resolve()})});
const context=window.HTMLCanvasElement.prototype.getContext,client=window.Range.prototype.getClientRects,bounding=window.Range.prototype.getBoundingClientRect;
const globals=['Range','Node','DOMRect','Element'] as const;const descriptors=globals.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
beforeEach(()=>{
 globals.forEach(k=>Object.defineProperty(globalThis,k,{configurable:true,value:window[k]}));
 useEditorStore.setState(initial,true);
 window.HTMLCanvasElement.prototype.getContext=(()=>({font:'',measureText:(s:string)=>({width:s.length*6,fontBoundingBoxAscent:8,fontBoundingBoxDescent:2}),drawImage:()=>{}})) as typeof context;
 window.Range.prototype.getClientRects=function(){return [new DOMRect(50,92,30,10)] as unknown as DOMRectList;};
 window.Range.prototype.getBoundingClientRect=()=>new DOMRect(50,92,30,10);
});
afterEach(()=>{cleanup();globals.forEach((k,i)=>{const d=descriptors[i];if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);});window.getSelection()?.removeAllRanges();useEditorStore.setState(initial,true);window.HTMLCanvasElement.prototype.getContext=context;window.Range.prototype.getClientRects=client;window.Range.prototype.getBoundingClientRect=bounding;});
async function mount(tool:'text'|'select'){
 const {doc}=await fixture(),bytes=await doc.save(),page=model([]).pages[0]!,overlays=[overlay()];
 useEditorStore.setState({tool,model:{pages:[page],overlays},opened:{bytes,doc:original,fileName:'test.pdf',fileSize:bytes.length,sourcePages:[page]}});
 const view=render(<div style={{position:'relative'}}><ContentTextPreviewSurface bytes={bytes} page={page} overlays={overlays} scale={1}><TextHighlightLayer doc={original} page={page} pageIndex={0} scale={1} layerScale={1}/></ContentTextPreviewSurface></div>);
 await waitFor(()=>expect(view.container.querySelector('.shioriTextLayer span')).not.toBeNull());
 const root=view.container.querySelector<HTMLElement>('.shioriTextLayer')!;
 root.getBoundingClientRect=()=>new DOMRect(0,0,300,200);
 return{view,root};
}
function select(root:HTMLElement){const range=document.createRange();range.selectNodeContents(root.querySelector('span')!);const s=window.getSelection()!;s.removeAllRanges();s.addRange(range);document.dispatchEvent(new Event('selectionchange'));}
test('the text tool copies edited text while original geometry remains available for a new edit',async()=>{
 const{root}=await mount('text');await waitFor(()=>expect(root.querySelector('span')!.textContent).toBe('AXCDE'));
 act(()=>select(root));expect(window.getSelection()!.isCollapsed).toBe(false);expect(root.contains(window.getSelection()!.anchorNode)).toBe(true);expect(root.contains(window.getSelection()!.focusNode)).toBe(true);expect(window.getSelection()!.getRangeAt(0).intersectsNode(root.querySelector('span')!)).toBe(true);let copied='';const event=new Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{setData:(_type:string,value:string)=>{copied=value;}}});document.dispatchEvent(event);// Happy DOM does not perform the browser's default clipboard write.
 expect(event.defaultPrevented?copied:window.getSelection()!.toString()).toBe('AXCDE');
});
test('find highlight paints above the edited-page canvas outside the text stacking context',async()=>{
 const{view,root}=await mount('select');act(()=>useEditorStore.getState().setSearchMatchHighlight({pageId:'p',charStart:1,charEnd:2}));
 await waitFor(()=>expect(view.container.querySelector('svg rect')).not.toBeNull());
 const svg=view.container.querySelector('svg')!,canvas=view.container.querySelector('canvas[data-content-text-preview]')! as HTMLCanvasElement;
 expect(root.contains(svg)).toBe(false);expect(Number(svg.style.zIndex)).toBeGreaterThan(Number(canvas.style.zIndex));expect(svg.style.pointerEvents).toBe('none');
});
test('text-tool selection paints edited geometry above the preview canvas',async()=>{
 const{view,root}=await mount('text');act(()=>select(root));
 await waitFor(()=>expect(view.container.querySelector('[data-shiori-selection-preview] rect')).not.toBeNull());
 const svg=view.container.querySelector<SVGElement>('[data-shiori-selection-preview]')!,canvas=view.container.querySelector('canvas[data-content-text-preview]')! as HTMLCanvasElement;
 expect(root.contains(svg)).toBe(false);expect(Number(svg.style.zIndex)).toBeGreaterThan(Number(canvas.style.zIndex));expect(svg.style.pointerEvents).toBe('none');
});
