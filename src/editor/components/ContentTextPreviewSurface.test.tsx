import '../../test/setupDom';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, afterAll, expect, test } from 'bun:test';
import { ContentTextPreviewSurface } from './ContentTextPreviewSurface';
import { useContentTextPreview } from './contentTextPreviewContext';
import { withFakePdfEngine, fakePdfDocument } from '../../test/fakePdfEngine';
import { fixture, model, overlay } from '../../pdf/export/contentText/fixtures.test-support';
let fail=false,destroyed=0;
const originalContext=window.HTMLCanvasElement.prototype.getContext;
beforeAll(()=>{window.HTMLCanvasElement.prototype.getContext=(()=>({drawImage:()=>{}})) as typeof originalContext;});
afterAll(()=>{window.HTMLCanvasElement.prototype.getContext=originalContext;});
withFakePdfEngine(()=>({load:async()=>{if(fail)throw Error('open failed');return{doc:fakePdfDocument(),bytes:new Uint8Array()};},
 renderRegion:()=>({cancel:()=>{},done:Promise.resolve()}),destroy:async()=>{destroyed++;}}));
afterEach(()=>{cleanup();fail=false;destroyed=0;});
function State(){const p=useContentTextPreview();return <span data-testid="state">{p.accepted.has('edit')?'raster':p.outcomes[0]?.reason??'overlay'}</span>;}
test('keeps DOM fallback until PDFium has rendered edited bytes, then releases the document',async()=>{
 const{doc}=await fixture();const view=render(<ContentTextPreviewSurface bytes={await doc.save()} page={model([]).pages[0]!} overlays={[overlay()]} scale={1}><State/></ContentTextPreviewSurface>);
 expect(view.getByTestId('state').textContent).toBe('overlay');
 await waitFor(()=>expect(view.getByTestId('state').textContent).toBe('raster'));
 expect(destroyed).toBe(1);
});
test('an engine open failure retains overlay preview and exposes an explicit reason',async()=>{
 fail=true;const{doc}=await fixture();const view=render(<ContentTextPreviewSurface bytes={await doc.save()} page={model([]).pages[0]!} overlays={[overlay()]} scale={1}><State/></ContentTextPreviewSurface>);
 await waitFor(()=>expect(view.getByTestId('state').textContent).toBe('preview-unavailable'));
});
test('the PDFium raster sits above source text and stays visible while a zoom frame is pending',async()=>{
 const{doc}=await fixture(),bytes=await doc.save(),page=model([]).pages[0]!,overlays=[overlay()];
 const view=render(<ContentTextPreviewSurface bytes={bytes} page={page} overlays={overlays} scale={1}><State/></ContentTextPreviewSurface>);
 await waitFor(()=>expect(view.getByTestId('state').textContent).toBe('raster'));
 const canvas=view.container.querySelector('canvas')!;expect(Number(canvas.style.zIndex)).toBeGreaterThan(1);
 view.rerender(<ContentTextPreviewSurface bytes={bytes} page={page} overlays={overlays} scale={1.2}><State/></ContentTextPreviewSurface>);
 expect(canvas.style.visibility).toBe('visible');
 await waitFor(()=>expect(view.getByTestId('state').textContent).toBe('raster'));
});
