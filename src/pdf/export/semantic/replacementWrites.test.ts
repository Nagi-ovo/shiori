import { expect, test } from 'bun:test';
import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { fixture, model, overlay } from '../contentText/fixtures.test-support';
import { exportPdf } from '../exportPdf';

const name = PDFName.of;

test.each(['point in another stream', 'inherited Form resources', 'Type3 glyph resources', 'other page'] as const)(
  'keeps a named property live in %s', async scope => {
    const input = await fixture('/P /Label BDC BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET EMC');
    const { doc, page } = input, ctx = doc.context;
    const root = ctx.nextRef();
    const owner = ctx.register(ctx.obj({ S: 'P', P: root, Pg: page.ref, K: 0 }));
    ctx.assign(root, ctx.obj({ K: owner, ParentTree: { Nums: [9, [owner]] } }));
    doc.catalog.set(name('StructTreeRoot'), root);
    page.node.set(name('StructParents'), ctx.obj(9));
    const resources = page.node.Resources()!;
    const label = ctx.register(ctx.obj({ MCID: 0, E: PDFHexString.fromText('Original label') }));
    resources.set(name('Properties'), ctx.obj({ Label: label }));
    const parts = [page.node.get(name('Contents'))!];
    let pages = model([]).pages;
    if (scope === 'point in another stream') {
      parts.push(ctx.register(ctx.stream('/Span /Label DP')));
    } else if (scope === 'inherited Form resources') {
      resources.set(name('XObject'), ctx.obj({ Form: ctx.register(ctx.stream('/Span /Label DP', {
        Subtype: 'Form', BBox: [0, 0, 300, 200],
      })) }));
      parts.push(ctx.register(ctx.stream('/Form Do')));
    } else if (scope === 'Type3 glyph resources') {
      const glyph = ctx.register(ctx.stream('400 0 d0 /Span /Label DP'));
      resources.lookup(name('Font'), PDFDict).set(name('GlyphFont'), ctx.register(ctx.obj({
        Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 240, 300], FontMatrix: [.001, 0, 0, .001, 0, 0],
        CharProcs: { A: glyph }, Encoding: { Type: 'Encoding', Differences: [65, 'A'] },
        FirstChar: 65, LastChar: 65, Widths: [400],
      })));
      parts.push(ctx.register(ctx.stream('BT /GlyphFont 10 Tf 10 10 Td (A) Tj ET')));
    } else {
      const sibling = doc.addPage([300, 200]);
      sibling.node.set(name('Resources'), resources);
      sibling.node.set(name('Contents'), ctx.register(ctx.stream('/Span /Label DP')));
      pages = [...pages, { ...pages[0]!, id: 'sibling', sourceIndex: 1 }];
    }
    page.node.set(name('Contents'), ctx.obj(parts));
    const result = await exportPdf(await doc.save(), { pages, overlays: [overlay()] });
    expect(result.semanticChanges).toContainEqual(expect.objectContaining({ action: 'updated' }));
    const saved = await PDFDocument.load(result.bytes);
    const propertiesAt = (index: number) => saved.getPage(index).node.Resources()!.lookup(name('Properties'), PDFDict);
    const live = propertiesAt(scope === 'other page' ? 1 : 0).lookup(name('Label'), PDFDict);
    expect(live.lookup(name('E'), PDFHexString).decodeText()).toBe('Original label');
    if (scope === 'other page') expect(propertiesAt(0).has(name('Label'))).toBe(false);
  },
);
