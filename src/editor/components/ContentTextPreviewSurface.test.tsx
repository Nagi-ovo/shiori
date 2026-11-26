import '../../test/setupDom';
import '../../i18n';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, afterAll, expect, test } from 'bun:test';
import { useRef } from 'react';
import { PDFArray, PDFDocument, decodePDFRawStream, type PDFRawStream } from 'pdf-lib';
import { ContentTextPreviewSurface } from './ContentTextPreviewSurface';
import { ContentTextWarning } from './overlays/ContentTextWarning';
import { contentTextGlyphsShown, useContentTextPreview } from './contentTextPreviewContext';
import { OverlaySvg } from './overlays/overlaySvg';
import { TextOverlayEditor } from './overlays/TextOverlayEditor';
import { withFakePdfEngine, fakePdfDocument } from '../../test/fakePdfEngine';
import { fixture, model, overlay } from '../../pdf/export/contentText/fixtures.test-support';
import { stripeContent, stripePdf } from './contentTextInput.test-support';
import type { ContentTextOverlay } from '../../pdf/model/types';
import type { ContentTextPreviewOptions } from './contentTextPreview';

// Failure list for the live preview of source-text edits:
// 1. an open edit is shown over a drawn cover instead of the page with its
//    source glyphs excluded (artwork under the glyphs lost);
// 2. the excluded frame drops neighbouring text or artwork;
// 3. every keystroke rebuilds and redraws the page (stale frames race the
//    textarea);
// 4. while editing, refusal/approximation notices stop following the typed
//    text;
// 5. leaving the edit flashes the source glyphs or double prints before the
//    written frame lands;
// 6. a superseded frame lands after a newer one;
// 7. an unsupported edit hides its source text or draws a cover;
// 8. the overlay SVG still paints a cover shape for a source-text edit.
let fail = false, destroyed = 0;
let loads: Uint8Array[] = [], gate: ((index: number) => Promise<void>) | null = null, drawn: unknown[] = [];
const originalContext = window.HTMLCanvasElement.prototype.getContext;
beforeAll(() => { window.HTMLCanvasElement.prototype.getContext = (function (this: HTMLCanvasElement) { return { drawImage: (source: unknown) => { drawn.push(source); } }; }) as unknown as typeof originalContext; });
afterAll(() => { window.HTMLCanvasElement.prototype.getContext = originalContext; });
withFakePdfEngine(() => ({
  load: async (bytes: Uint8Array) => {
    if (fail) throw Error('open failed');
    const index = loads.push(bytes) - 1;
    if (gate) await gate(index);
    return { doc: fakePdfDocument(), bytes: new Uint8Array() };
  },
  renderRegion: () => ({ cancel: () => {}, done: Promise.resolve() }), destroy: async () => { destroyed++; },
}));
afterEach(() => { cleanup(); fail = false; destroyed = 0; loads = []; gate = null; drawn = []; });

function State({ edit }: { edit?: ContentTextOverlay }) {
  const p = useContentTextPreview();
  return <span data-testid="state" data-shown={edit ? String(contentTextGlyphsShown(p, edit)) : ''} data-mode={p.outcomes.find(o => o.overlayId === 'edit')?.mode ?? ''}>{p.accepted.has('edit') ? 'raster' : p.outcomes[0]?.reason ?? 'overlay'}</span>;
}
async function pageText(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes), contents = doc.getPage(0).node.Contents()!;
  const streams = contents instanceof PDFArray ? contents.asArray().map(r => doc.context.lookup(r)) : [contents];
  return streams.map(s => new TextDecoder().decode(decodePDFRawStream(s as PDFRawStream).decode())).join('\n');
}
const artwork = stripeContent().split('\n')[0]!;
const stripeEdit = (text: string) => overlay({ text });
const page = model([]).pages[0]!;
const surface = (bytes: Uint8Array, edit: ContentTextOverlay, editingId: string | null, scale = 1) =>
  <ContentTextPreviewSurface bytes={bytes} page={page} overlays={[edit]} scale={scale} editingId={editingId}><State edit={edit} /></ContentTextPreviewSurface>;
const shown = (view: ReturnType<typeof render>) => view.getByTestId('state').dataset.shown;

test('keeps DOM fallback until PDFium has rendered edited bytes, then releases the document', async () => {
  const { doc } = await fixture(); const view = render(<ContentTextPreviewSurface bytes={await doc.save()} page={page} overlays={[overlay()]} scale={1}><State /></ContentTextPreviewSurface>);
  expect(view.getByTestId('state').textContent).toBe('overlay');
  await waitFor(() => expect(view.getByTestId('state').textContent).toBe('raster'));
  expect(destroyed).toBe(1);
});

test('an engine open failure exposes an explicit unsupported preview reason', async () => {
  fail = true; const { doc } = await fixture(); const view = render(<ContentTextPreviewSurface bytes={await doc.save()} page={page} overlays={[overlay()]} scale={1}><State /></ContentTextPreviewSurface>);
  await waitFor(() => expect(view.getByTestId('state').textContent).toBe('preview-unavailable'));
});

test('the PDFium raster sits above source text and stays visible while a zoom frame is pending', async () => {
  const { doc } = await fixture(), bytes = await doc.save(), overlays = [overlay()];
  const view = render(<ContentTextPreviewSurface bytes={bytes} page={page} overlays={overlays} scale={1}><State /></ContentTextPreviewSurface>);
  await waitFor(() => expect(view.getByTestId('state').textContent).toBe('raster'));
  const canvas = view.container.querySelector('canvas')!; expect(Number(canvas.style.zIndex)).toBeGreaterThan(1);
  view.rerender(<ContentTextPreviewSurface bytes={bytes} page={page} overlays={overlays} scale={1.2}><State /></ContentTextPreviewSurface>);
  expect(canvas.style.visibility).toBe('visible');
  await waitFor(() => expect(view.getByTestId('state').textContent).toBe('raster'));
});

test('the committed surface reuses an equal candidate and clears a raster when strict refuses it', async () => {
  const { doc } = await fixture('/Span <</Alt (Label)>> BDC BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC');
  const bytes = await doc.save();
  const reviewable = (options?: ContentTextPreviewOptions) =>
    <ContentTextPreviewSurface bytes={bytes} page={{ ...page }} overlays={[overlay()]} scale={1} previewOptions={options}>
      <State />
      <ContentTextWarning id="edit" editing={false} overflow={false} missing={0} />
    </ContentTextPreviewSurface>;
  const view = render(reviewable());
  const canvas = view.container.querySelector('canvas')!;
  await waitFor(() => expect(canvas.style.visibility).toBe('visible'));
  expect(view.getByRole('status').textContent).toContain('This edit removes alternate text');
  const firstFrames = loads.length;
  view.rerender(reviewable({ acceptance: 'review' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  expect(loads.length).toBe(firstFrames);

  view.rerender(reviewable({ acceptance: 'strict' }));
  expect(canvas.style.visibility).toBe('hidden');
  await waitFor(() => expect(view.getByTestId('state').textContent).toBe('acceptance-strict'));
  expect(view.getByRole('status').textContent).toContain('Strict export kept the original text.');
  expect(view.getByRole('status').textContent).toContain('This edit removes alternate text');
});

test('an open edit is previewed as the page with its own source glyphs excluded and all artwork kept', async () => {
  const bytes = await stripePdf(), edit = stripeEdit('ABCDE');
  const view = render(surface(bytes, edit, 'edit'));
  expect(shown(view)).toBe('false'); // nothing excluded yet: the page still shows the source glyphs
  await waitFor(() => expect(shown(view)).toBe('true'));
  const content = await pageText(loads.at(-1)!);
  expect(content).toContain(artwork);
  expect(content).toContain('FGHIJ');
  expect(content).not.toMatch(/ABCDE|<4142434445>/);
  expect(drawn.length).toBe(1);
});

test('typing in the open edit neither rebuilds nor redraws the frame, and notices follow the typed text', async () => {
  const bytes = await stripePdf();
  const view = render(surface(bytes, stripeEdit('ABCDE'), 'edit'));
  await waitFor(() => expect(shown(view)).toBe('true'));
  const frames = loads.length, draws = drawn.length;
  // Every store patch stamps localActivityAt; it is bookkeeping, not paint.
  ['ABCD', 'ABC', 'ABCX', 'ABCXY'].forEach((text, i) => view.rerender(surface(bytes, { ...stripeEdit(text), localActivityAt: 1000 + i }, 'edit')));
  expect(shown(view)).toBe('true');
  await waitFor(() => expect(view.getByTestId('state').dataset.mode).toBe('in-place'));
  expect(shown(view)).toBe('true');
  expect(loads.length).toBe(frames);
  expect(drawn.length).toBe(draws);
});

test('leaving the edit keeps the excluded frame and live text until the written frame lands', async () => {
  const bytes = await stripePdf();
  const view = render(surface(bytes, stripeEdit('ABCDE'), 'edit'));
  await waitFor(() => expect(shown(view)).toBe('true'));
  let release!: () => void;
  gate = async () => { await new Promise<void>(r => { release = r; }); };
  view.rerender(surface(bytes, stripeEdit('AB-DE'), null));
  expect(shown(view)).toBe('true'); // DOM text over the excluded frame: no source flash, no double print
  await waitFor(() => expect(release).toBeDefined());
  await act(async () => { release(); });
  await waitFor(() => expect(shown(view)).toBe('false'));
  expect(await pageText(loads.at(-1)!)).toMatch(/<2d>|\(AB-DE\)|<41422d4445>/i);
});

test('a superseded frame never lands over a newer one', async () => {
  const bytes = await stripePdf();
  const releases: Array<() => void> = [];
  gate = (index) => new Promise<void>(r => { releases[index] = r; });
  const view = render(surface(bytes, stripeEdit('ABCDE'), 'edit'));
  await waitFor(() => expect(releases[0]).toBeDefined());
  view.rerender(surface(bytes, stripeEdit('AB-DE'), null));
  await waitFor(() => expect(releases[1]).toBeDefined());
  await act(async () => { releases[1]!(); });
  await waitFor(() => expect(view.getByTestId('state').textContent).toBe('raster'));
  expect(shown(view)).toBe('false');
  const draws = drawn.length;
  await act(async () => { releases[0]!(); await new Promise(r => setTimeout(r, 20)); });
  expect(shown(view)).toBe('false');
  expect(drawn.length).toBe(draws);
});

test('an unsupported edit leaves its original visible and draws no cover', async () => {
  const { doc } = await fixture('0.5 g 0 0 100 100 re f'), edit = overlay();
  const view = render(<ContentTextPreviewSurface bytes={await doc.save()} page={page} overlays={[edit]} scale={1} editingId="edit"><State edit={edit} /><svg><OverlaySvg overlay={edit} page={page} scale={1} selected={false} liveReveals={[]} /></svg></ContentTextPreviewSurface>);
  await waitFor(() => expect(view.getByTestId('state').textContent).toBe('unsupported-no-text-layer'));
  expect(shown(view)).toBe('false');
  expect(view.container.querySelector('svg rect, svg path')).toBeNull();
});

function EditingControl({ edit }: { edit: ContentTextOverlay }) {
  const preview = useContentTextPreview();
  const ref = useRef<HTMLTextAreaElement>(null);
  return <>
    <TextOverlayEditor overlay={edit} textareaRef={ref}
      glyphsHidden={!contentTextGlyphsShown(preview, edit)} onCommitEdit={() => {}}
      onMaybeSuppressEditDragBlur={() => false} />
    <ContentTextWarning id={edit.id} editing overflow={false} missing={0} />
  </>;
}

test('a refused exclusion reveals the same editor with a reason until a supported frame is ready', async () => {
  // Fill-and-clip text controls the stripe painted after it. The writer
  // cannot remove these glyphs without also changing what the stripe paints.
  const line = 'BT /F1 10 Tf 4 Tr 50 100 Td (ABCDE) Tj ET';
  const clipped = await fixture(`q ${line} 0.2 0.5 0.8 rg 48 98 34 15 re f Q`);
  const supported = await fixture(line.replace('4 Tr ', ''));
  const refusedBytes = await clipped.doc.save(), supportedBytes = await supported.doc.save();
  const edit = overlay({ text: 'ABCDE' });
  const editor = (bytes: Uint8Array, current = edit) => (
    <div className="shioriCanvas">
      <ContentTextPreviewSurface bytes={bytes} page={page} overlays={[current]} scale={1} editingId={edit.id}>
        <EditingControl edit={current} />
      </ContentTextPreviewSurface>
    </div>
  );
  const view = render(editor(refusedBytes));
  const field = view.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edited text' });
  const description = () => (field.getAttribute('aria-describedby')?.split(/\s+/) ?? [])
    .map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
  const refusal = 'This text could not be rewritten safely.';
  field.setSelectionRange(1, 3);
  expect(field.style.color).toBe('transparent');
  expect(description()).toBe('Updating preview…');
  await waitFor(() => expect(description()).toContain(refusal));
  expect(field.style.color).not.toBe('transparent');
  expect(document.activeElement).toBe(field);
  expect([field.selectionStart, field.selectionEnd]).toEqual([1, 3]);
  expect(loads).toHaveLength(0);

  const changed = { ...edit, text: 'AXCDE' };
  view.rerender(editor(refusedBytes, changed));
  expect(view.getByRole('textbox')).toBe(field);
  expect(field.value).toBe('AXCDE');
  expect(description()).toContain(refusal);

  view.rerender(editor(supportedBytes, changed));
  await waitFor(() => expect(loads).toHaveLength(1));
  await waitFor(() => expect(field.style.color).toBe('inherit'));
  expect(description()).not.toContain(refusal);
  expect(view.getByRole('textbox')).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('AXCDE');
});
