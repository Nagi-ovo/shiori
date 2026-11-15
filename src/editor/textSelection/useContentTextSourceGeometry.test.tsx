import '../../test/setupDom';
import {cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,expect,test} from 'bun:test';
import {useContentTextSourceGeometry} from './useContentTextSourceGeometry';
import {fakePdfDocument,withFakePdfEngine} from '../../test/fakePdfEngine';
const doc=fakePdfDocument(),page={id:'p',sourceIndex:0,widthPt:300,heightPt:200,rotation:0 as const};
let reads=0;
withFakePdfEngine({pageText:async()=>{reads++;return{content:{items:[{str:'ABCDE',dir:'ltr',transform:[10,0,0,10,50,100],width:30,height:10,fontName:'f',hasEOL:false}],styles:{f:{fontFamily:'monospace',ascent:.8,descent:-.2,vertical:false}},lang:null},glyphs:null,fontNames:new Map(),faceFamilies:new Map()};}});
afterEach(()=>{cleanup();reads=0;});
function Probe({enabled=true,scale=1}:{enabled?:boolean;scale?:number}){const geometry=useContentTextSourceGeometry(doc,page,enabled,scale);return <output>{geometry?.select([{x:50*scale,y:90*scale,w:30*scale,h:12*scale}]).map(r=>r.text).join('')??'pending'}</output>;}
test('new-edit geometry reads source text only when enabled and rescales without another read',async()=>{
 const view=render(<Probe enabled={false}/>);expect(reads).toBe(0);view.rerender(<Probe/>);
 await waitFor(()=>expect(view.container.textContent).toBe('ABCDE'));expect(reads).toBe(1);
 view.rerender(<Probe scale={2}/>);await waitFor(()=>expect(view.container.textContent).toBe('ABCDE'));expect(reads).toBe(1);
});
