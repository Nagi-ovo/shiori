import '../../test/setupDom';
import {cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,expect,test} from 'bun:test';
import {useContentTextSourceGeometry} from './useContentTextSourceGeometry';
import type {PdfTextGlyph} from '../../pdf/engine/text';
import {fakePdfDocument,withFakePdfEngine} from '../../test/fakePdfEngine';
const doc=fakePdfDocument(),page={id:'p',sourceIndex:0,widthPt:300,heightPt:200,rotation:0 as const};
let reads=0,glyphs:PdfTextGlyph[]|null=null;
// Proportional advances: A 4, B 8, C 6, D 6, E 6 (pt), as an engine reports them.
const advances=[4,8,6,6,6];
const proportional=():PdfTextGlyph[]=>{let x=50;return [...'ABCDE'].map((text,i)=>{const a=advances[i]!,g={text,fontName:'f',origin:{x,y:100},end:{x:x+a,y:100},quad:[{x,y:98},{x:x+a,y:98},{x:x+a,y:108},{x,y:108}]};x+=a;return g;});};
withFakePdfEngine({pageText:async()=>{reads++;return{content:{items:[{str:'ABCDE',dir:'ltr',transform:[10,0,0,10,50,100],width:30,height:10,fontName:'f',hasEOL:false}],styles:{f:{fontFamily:'monospace',ascent:.8,descent:-.2,vertical:false}},lang:null},glyphs,fontNames:new Map(),faceFamilies:new Map()};}});
afterEach(()=>{cleanup();reads=0;glyphs=null;});
function Probe({enabled=true,scale=1}:{enabled?:boolean;scale?:number}){const geometry=useContentTextSourceGeometry(doc,page,enabled,scale);return <output>{geometry?.select([{x:50*scale,y:90*scale,w:30*scale,h:12*scale}]).map(r=>r.text).join('')??'pending'}</output>;}
test('new-edit geometry reads source text only when enabled and rescales without another read',async()=>{
 const view=render(<Probe enabled={false}/>);expect(reads).toBe(0);view.rerender(<Probe/>);
 await waitFor(()=>expect(view.container.textContent).toBe('ABCDE'));expect(reads).toBe(1);
 view.rerender(<Probe scale={2}/>);await waitFor(()=>expect(view.container.textContent).toBe('ABCDE'));expect(reads).toBe(1);
});

function Cells({scale}:{scale:number}){const geometry=useContentTextSourceGeometry(doc,page,true,scale);const run=geometry?.paragraphs[0]?.lines[0]?.runs[0];const cells=run?geometry!.caretCells(run):null;return <output>{cells?JSON.stringify(cells.map(c=>[c.start,c.end,Math.round(c.rect.x),Math.round(c.rect.w),Math.round(c.from.x),Math.round(c.to.x),c.rtl])):'none'}</output>;}
test('exposes the engine glyph cells of each source run in display space at the current zoom',async()=>{
 glyphs=proportional();
 const view=render(<Cells scale={2}/>);
 await waitFor(()=>expect(view.container.textContent).not.toBe('none'));
 expect(JSON.parse(view.container.textContent!)).toEqual([[0,1,100,8,100,108,false],[1,2,108,16,108,124,false],[2,3,124,12,124,136,false],[3,4,136,12,136,148,false],[4,5,148,12,148,160,false]]);
});
test('a run without mapped glyphs has no cells (callers measure instead)',async()=>{
 const view=render(<Cells scale={1}/>);
 await waitFor(()=>expect(view.container.textContent).toBe('[]'));
});

function ClickedField({ x }: { x: number }) {
 const geometry = useContentTextSourceGeometry(doc, page, true, 1);
 return <output>{geometry?.fieldAtPoint?.({ x, y: 98 })?.lines[0]?.runs[0]?.text ?? 'none'}</output>;
}

test('a click can address one complete horizontal field by its native glyph cells', async () => {
 glyphs = proportional();
 const view = render(<ClickedField x={51} />);
 await waitFor(() => expect(view.container.textContent).toBe('ABCDE'));
 view.rerender(<ClickedField x={43} />);
 expect(view.container.textContent).toBe('none');
});
