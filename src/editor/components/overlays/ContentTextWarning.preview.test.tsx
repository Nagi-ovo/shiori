import '../../../test/setupDom';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { PDFDict, PDFName } from 'pdf-lib';
import i18n from '../../../i18n';
import type { ContentTextOverlay, PageModel } from '../../../pdf/model/types';
import { fixture, model, overlay } from '../../../pdf/export/contentText/fixtures.test-support';
import { fakePdfDocument, withFakePdfEngine } from '../../../test/fakePdfEngine';
import { ContentTextPreviewSurface } from '../ContentTextPreviewSurface';
import { OverlayDom } from './OverlayDom';

// Production preview path: edited overlays → rebuildPdf outcomes → context →
// the warning beside the edited text. Only the raster engine, the canvas and
// the bundled-font fetch (a file path under bun) are stood in for.
let frames = 0;
let refuseFrame = false;
const originalContext = window.HTMLCanvasElement.prototype.getContext, originalFetch = globalThis.fetch;
beforeAll(async () => {
  await i18n.changeLanguage('en');
  window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => {} })) as unknown as typeof originalContext;
  globalThis.fetch = (async (url: string) => new Response(await Bun.file(String(url)).arrayBuffer())) as typeof fetch;
});
afterAll(() => { window.HTMLCanvasElement.prototype.getContext = originalContext; globalThis.fetch = originalFetch; });
withFakePdfEngine(() => ({ load: async () => {
  frames++;
  if (refuseFrame) throw new Error('Preview load failed');
  return { doc: fakePdfDocument(), bytes: new Uint8Array() };
},
  renderRegion: () => ({ cancel: () => {}, done: Promise.resolve() }), destroy: async () => {} }));
afterEach(() => { cleanup(); frames = 0; refuseFrame = false; });

const page = model([]).pages[0]!;
/** The first-party Courier fixture without a Unicode map: replacements need a whole-run substitute. */
async function unmappedSource() {
  const f = await fixture('BT /F1 10 Tf 50 100 Td (ABCDE) Tj [-1000] TJ (Z) Tj ET');
  const font = f.page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
  font.set(PDFName.of('FontDescriptor'), f.doc.context.obj({ FontBBox: [0, -200, 600, 800], Ascent: 800, Descent: -200 }));
  font.delete(PDFName.of('ToUnicode'));
  return f.doc.save();
}
const sourceWith = async (ink: string) => (await fixture(`BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET ${ink}`)).doc.save();
const edit = (text: string) => overlay({ text, coverRects: [{ x: 49, y: 97, w: 32, h: 14 }] });
function Editor({ bytes, value, editing = false, sourcePage = page }: { bytes: Uint8Array; value: ContentTextOverlay; editing?: boolean; sourcePage?: PageModel }) {
  return <ContentTextPreviewSurface bytes={bytes} page={sourcePage} overlays={[value]} scale={1} editingId={editing ? value.id : null}>
    <OverlayDom overlay={value} page={sourcePage} scale={1} selected editing={editing} interactivePointerEvents="auto"
      onStartEdit={() => undefined} onCommitEdit={() => undefined} onPointerDown={() => undefined}
      onHandlePointerDown={() => undefined} onRotateHandlePointerDown={() => undefined}
      onMaybeSuppressEditDragBlur={() => false} now={0} />
  </ContentTextPreviewSurface>;
}
const settled = async (view: ReturnType<typeof render>, text: string) => {
  await waitFor(() => expect(view.getByRole('status').textContent).toBe(text), { timeout: 5000 });
};

test('a successful whole-run substitution names the face it wrote', async () => {
  const view = render(<Editor bytes={await unmappedSource()} value={edit('éike')} />);
  await settled(view, 'Rewritten in the substitute font LiberationMono-Regular.');
});

test('a missing-glyph fallback names the bundled face that supplied the characters', async () => {
  const bytes = new Uint8Array(await Bun.file('scripts/pdf-inplace/fixtures/subset.pdf').arrayBuffer());
  const value = overlay({ originalText: 'Sans', text: 'Sanr', fontSize: 20, rect: { x: 19, y: 95, w: 50, h: 22 }, coverRects: [{ x: 19, y: 95, w: 50, h: 22 }] });
  const view = render(<Editor bytes={bytes} value={value} />);
  await settled(view, 'Missing characters use the bundled font LiberationSans-Regular.');
});

test('a retypeset that keeps the source font says so and reports the frame, not an overlap', async () => {
  const view = render(<Editor bytes={await sourceWith('0 g 40 60 200 30 re f')} value={overlay({ text: 'AXXXXXCDE' })} />);
  await settled(view, 'Layout may change. · Original font kept. · Text extends past its original frame.');
  expect(view.getByRole('status').textContent).not.toMatch(/substitute|overlap/i);
});

test('an updated result moves from a fitted retypeset to a reported overlap', async () => {
  const bytes = await sourceWith('BT /F1 10 Tf 50 88 Td (QQQQQQQQ) Tj ET 0 g 0 0 300 85 re f');
  const view = render(<Editor bytes={bytes} value={overlay({ text: 'AXXXXXCDE' })} />);
  await settled(view, 'Layout may change. · Original font kept.');
  view.rerender(<Editor bytes={bytes} value={overlay({ text: 'AXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXCDE' })} />);
  await settled(view, 'Layout may change. · Original font kept. · Text extends past its original frame. · Text may overlap nearby content.');
});

const frameOverflow = 'Layout may change. · Original font kept. · Text extends past its original frame.';
const pending = 'Updating preview…';
const longDraft = overlay({ text: 'AXXXXXCDE' });
const offPage = 'The original text stays on the page. You can edit your draft here.';
const previewUnavailable = 'The edited PDF preview is unavailable.';

function descriptions(view: ReturnType<typeof render>) {
  const ids = view.getByRole('textbox').getAttribute('aria-describedby')?.split(/\s+/) ?? [];
  return ids.flatMap(id => document.getElementById(id)?.textContent || []);
}

function describedStatus(view: ReturnType<typeof render>) {
  const field = view.getByRole('textbox');
  const description = document.getElementById(field.getAttribute('aria-describedby') ?? '');
  expect(description).toBe(view.getByRole('status'));
  return description?.textContent;
}

test('the active notice follows the typed text while the same exclusion frame stays visible', async () => {
  const bytes = await sourceWith('0 g 40 60 200 30 re f');
  const view = render(<Editor bytes={bytes} value={longDraft} editing />);
  await settled(view, frameOverflow);
  const field = view.getByRole<HTMLTextAreaElement>('textbox');
  expect(field.style.color).toBe('inherit');
  expect(describedStatus(view)).toBe(frameOverflow);
  const painted = frames;

  view.rerender(<Editor bytes={bytes} value={overlay({ text: 'AXCDE' })} editing />);
  expect(field.value).toBe('AXCDE');
  expect(field.style.color).toBe('inherit');
  expect(describedStatus(view)).toBe(pending);
  await waitFor(() => expect(view.queryByRole('status')?.textContent).toBeUndefined());
  expect(frames).toBe(painted);

  view.rerender(<Editor bytes={bytes} value={longDraft} editing />);
  expect(describedStatus(view)).toBe(pending);
  await settled(view, frameOverflow);
  expect(frames).toBe(painted);
});

test('a reused edit ID clears its result when the source page, document, or active edit changes', async () => {
  const bytes = await sourceWith('0 g 40 60 200 30 re f');
  const view = render(<Editor bytes={bytes} value={longDraft} editing />);
  await settled(view, frameOverflow);

  const otherPage = { ...page, id: 'other-page' };
  const otherPageDraft = { ...longDraft, pageId: otherPage.id };
  view.rerender(<Editor bytes={bytes} sourcePage={otherPage} value={otherPageDraft} editing />);
  expect(describedStatus(view)).toBe(pending);
  await settled(view, frameOverflow);

  view.rerender(<Editor bytes={bytes} sourcePage={otherPage} value={otherPageDraft} />);
  await settled(view, frameOverflow);
  view.rerender(<Editor bytes={bytes} sourcePage={otherPage} value={otherPageDraft} editing />);
  expect(describedStatus(view)).toBe(pending);
  await settled(view, frameOverflow);

  const imageOnly = await (await fixture('0.5 g 0 0 100 100 re f')).doc.save();
  view.rerender(<Editor bytes={imageOnly} sourcePage={otherPage} value={otherPageDraft} editing />);
  expect(describedStatus(view)).toBe(pending);
  await settled(view, `${offPage} This page has no editable text layer. Add a note or open a text-based PDF to edit the text.`);
  expect(view.getByRole('textbox').style.color).not.toBe('transparent');
});

test('a rejected draft preview replaces its pending notice with an accessible refusal', async () => {
  const view = render(<Editor bytes={new Uint8Array([0, 1, 2])} value={longDraft} editing />);
  expect(describedStatus(view)).toBe(pending);
  await settled(view, `${offPage} ${previewUnavailable}`);
  expect(descriptions(view)).toEqual([`${offPage} ${previewUnavailable}`]);
});

test('a refused exclusion frame keeps the real draft outcome available', async () => {
  refuseFrame = true;
  const bytes = await sourceWith('0 g 40 60 200 30 re f');
  const view = render(<Editor bytes={bytes} value={longDraft} editing />);
  await waitFor(() => expect(descriptions(view)).toEqual([`${offPage} ${previewUnavailable}`, frameOverflow]));
  expect(view.getByRole('textbox').style.color).not.toBe('transparent');
  expect(view.getByText(frameOverflow).closest('.shioriContentTextDraft.is-refused')).toBeTruthy();
});
