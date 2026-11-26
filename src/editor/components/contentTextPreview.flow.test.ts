import { expect, test } from 'bun:test';
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';
import { listSourceImages } from '../../pdf/export/sourceImages';
import type { ContentTextOverlay } from '../../pdf/model/types';
import { buildContentTextPreview } from './contentTextPreview';
import { readFileSync } from 'node:fs';
import { buildFlow } from '../../pdf/export/contentText/flow/linkedFlow.test-support';

const fixture = () => buildFlow({
  first: ['The lift to the archive floor is out of service', 'until the new motor arrives later this month.'],
  second: ['Use the east stair meanwhile.'],
  edit: 'The lift to the archive floor is out of service until the new motor arrives later this month. Boxes heavier than ten kilos go up on the goods hoist by the loading bay.',
}, path => readFileSync(path));

test('the editing preview flows a linked edit into its next frame, as the export does', async () => {
  const f = await fixture(), edit = f.model.overlays[0] as ContentTextOverlay;
  const preview = await buildContentTextPreview(f.bytes, f.model.pages[0]!, [edit], undefined, undefined, { flowChains: f.model.flowChains });
  expect(preview.outcomes).toEqual([expect.objectContaining({ overlayId: edit.id, mode: 'retypeset',
    flow: expect.objectContaining({ framesChanged: ['frame-0', 'frame-1'] }) })]);
  expect(preview.bytes).not.toBeNull();
});

test('the preview reports a refused chain by its reason and shows the source page', async () => {
  const f = await fixture(), edit = { ...(f.model.overlays[0] as ContentTextOverlay), text: `${'Boxes go up on the hoist. '.repeat(40)}` };
  const preview = await buildContentTextPreview(f.bytes, f.model.pages[0]!, [edit], undefined, undefined, { flowChains: f.model.flowChains });
  expect(preview.outcomes).toEqual([expect.objectContaining({ overlayId: edit.id, mode: 'unsupported', reason: 'flow-chain-exhausted' })]);
  expect(preview.bytes).toBeNull();
});

test('the preview refuses a chain into another page by that reason, not as an unknown chain', async () => {
  const f = await fixture(), edit = f.model.overlays[0] as ContentTextOverlay, chain = f.model.flowChains![0]!;
  const crossPage = { ...chain, frames: [chain.frames[0]!, { ...chain.frames[1]!, pageId: 'p2' }] };
  const preview = await buildContentTextPreview(f.bytes, f.model.pages[0]!, [edit], undefined, undefined, { flowChains: [crossPage] });
  expect(preview.outcomes).toEqual([expect.objectContaining({ overlayId: edit.id, mode: 'unsupported', reason: 'flow-cross-page-unsupported' })]);
});

test('preview writes a linked story and an independent source image edit together', async () => {
  const f = await fixture();
  const doc = await PDFDocument.load(f.bytes);
  const source = doc.getPage(0);
  const name = PDFName.of;
  const image = doc.context.register(doc.context.stream(Uint8Array.of(100), {
    Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: 'DeviceGray',
  }));
  source.node.Resources()!.set(name('XObject'), doc.context.obj({ Pic: image }));
  const contents = source.node.lookup(name('Contents'));
  const original = contents instanceof PDFArray ? contents.asArray() : [source.node.get(name('Contents'))!];
  source.node.set(name('Contents'), doc.context.obj([...original, doc.context.register(doc.context.stream(
    'q 10 0 0 10 10 10 cm /Pic Do Q',
  ))]));
  const bytes = await doc.save();
  const [target] = await listSourceImages(bytes, 0);
  const page = f.model.pages[0]!;
  const preview = await buildContentTextPreview(bytes, page, [
    f.model.overlays[0] as ContentTextOverlay,
    { type: 'sourceImageEdit', id: 'image', pageId: page.id, target: target!, delete: true },
  ], undefined, undefined, { flowChains: f.model.flowChains });
  expect(preview.outcomes).toMatchObject([{ mode: 'retypeset', flow: { framesChanged: ['frame-0', 'frame-1'] } }]);
  expect(preview.imageOutcomes).toEqual([{ overlayId: 'image', mode: 'applied' }]);
  expect(await listSourceImages(preview.bytes!, 0)).toEqual([]);
});
