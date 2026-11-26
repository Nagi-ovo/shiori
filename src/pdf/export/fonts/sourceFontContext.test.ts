import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { tokenizeContentStream } from '../contentStreamEdit/tokenizer';
import { resolveFont } from './fontService';
import { preserveSourceFontPage, sourceFontReader } from './sourceFontContext';

const name = PDFName.of;
const ops = (text: string) => tokenizeContentStream(new TextEncoder().encode(text));

test('reads descendant metrics and the nearest active marked-content language', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage(), ctx = doc.context;
  doc.catalog.set(name('Lang'), PDFString.of('zh-Hant'));
  page.node.set(name('Resources'), ctx.obj({
    Font: {
      F1: { BaseFont: 'ABCDEF+Source', Flags: 16, DescendantFonts: [{
        FontDescriptor: { Flags: ctx.register(ctx.obj(32)), FontWeight: 700 },
        CIDSystemInfo: { Ordering: PDFString.of('Identity') },
      }] },
    },
    Properties: { Inner: ctx.register(ctx.obj({ Lang: PDFHexString.fromText('ko-KR') })) },
  }));
  const read = sourceFontReader(page, ops(
    '/Span << /Lang (ja\\055JP) >> BDC /Span /Inner BDC /Span BMC (a) Tj EMC EMC (b) Tj EMC (c) Tj',
  ));
  expect(read('F1', 3)).toEqual({ baseFont: 'ABCDEF+Source', flags: 32, weight: 700, cidOrdering: 'Identity', lang: 'ko-KR' });
  expect(read('F1', 6).lang).toBe('ja-JP');
  expect(read('F1', 8).lang).toBe('zh-Hant');
});

test('a copied page uses its source page MCID and nearest structure ancestor', async () => {
  const doc = await PDFDocument.create(), first = doc.addPage(), second = doc.addPage(), ctx = doc.context;
  doc.catalog.set(name('Lang'), PDFString.of('zh-CN'));
  const root = ctx.nextRef();
  const parent = ctx.nextRef();
  ctx.assign(parent, ctx.obj({ S: 'Div', P: root, Pg: second.ref, Lang: PDFString.of('ko') }));
  const child = ctx.register(ctx.obj({ S: 'P', P: parent, K: 0 }));
  ctx.lookup(parent, PDFDict).set(name('K'), child);
  const other = ctx.register(ctx.obj({ S: 'P', P: root, Pg: first.ref, K: 0, Lang: PDFString.of('ja') }));
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: [other, parent] }));
  doc.catalog.set(name('StructTreeRoot'), root);

  const output = await PDFDocument.create(), [copy] = await output.copyPages(doc, [1]);
  preserveSourceFontPage(copy!, second);
  const inTag = ops('/P << /MCID 0 >> BDC /Span << /MCID 2 >> BDC (a) Tj EMC EMC (b) Tj');
  expect(sourceFontReader(first, inTag)('F1', 2).lang).toBe('ja');
  expect(sourceFontReader(copy!, inTag)('F1', 2).lang).toBe('ko');
  expect(sourceFontReader(copy!, inTag)('F1', 5).lang).toBe('zh-CN');
});

test('a copied Form resolves its own MCID and named properties in its own resources', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage(), ctx = doc.context;
  doc.catalog.set(name('Lang'), PDFString.of('zh-CN'));
  page.node.set(name('StructParents'), ctx.obj(0));
  const form = ctx.register(ctx.stream('',
    { Type: 'XObject', Subtype: 'Form', StructParents: 11, Resources: { Properties: { P: { MCID: 0 } } } }));
  const another = ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form' }));
  page.node.set(name('Resources'), ctx.obj({
    XObject: { Fx: form, Other: another }, Properties: { P: { MCID: 0, Lang: PDFString.of('ja') } },
  }));
  const root = ctx.nextRef(), parent = ctx.nextRef();
  ctx.assign(parent, ctx.obj({ S: 'Div', Lang: PDFString.of('ko'), Pg: page.ref, P: root }));
  const formElement = ctx.register(ctx.obj({ S: 'P', P: parent, K: { Type: 'MCR', MCID: 0, Stm: form } }));
  const otherElement = ctx.register(ctx.obj({
    S: 'P', P: root, Pg: page.ref, Lang: PDFString.of('ja'), K: { Type: 'MCR', MCID: 0, Stm: another },
  }));
  const pageElement = ctx.register(ctx.obj({ S: 'P', P: root, Pg: page.ref, Lang: PDFString.of('ja'), K: 0 }));
  ctx.assign(root, ctx.obj({
    Type: 'StructTreeRoot', K: [pageElement, otherElement, parent],
    ParentTree: { Kids: [ctx.register(ctx.obj({ Nums: [0, [pageElement], 11, [formElement]] }))] },
  }));
  doc.catalog.set(name('StructTreeRoot'), root);

  const output = await PDFDocument.create(), [copy] = await output.copyPages(doc, [0]);
  preserveSourceFontPage(copy!, page);
  const inTag = ops('/Span /P BDC (a) Tj EMC');
  expect(sourceFontReader(copy!, inTag, { formPath: ['Fx'] })('F1', 1).lang).toBe('ko');

  // With no number tree, the explicit /Stm still addresses the correct Form.
  ctx.lookup(root, PDFDict).delete(name('ParentTree'));
  ctx.lookup(parent, PDFDict).set(name('K'), formElement);
  expect(sourceFontReader(copy!, inTag, { formPath: ['Fx'] })('F1', 1).lang).toBe('ko');
});


test('descriptor names supply style evidence without changing the declared family', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage(), ctx = doc.context;
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: {
    BaseFont: 'ABCDEF+Helvetica',
    FontDescriptor: { Flags: 32, FontName: 'ABCDEF+Cambria-BoldItalic', FontFamily: PDFString.of('Cambria') },
  } } }));
  const metadata = sourceFontReader(page, [])('F1', 0);
  for (const purpose of ['cluster-fallback', 'run-substitute', 'vertical', 'retypeset'] as const) {
    expect(resolveFont({ ...metadata, purpose, text: 'é' })).toMatchObject({
      family: 'LiberationSans', style: 'BoldItalic',
    });
  }
});

test.each([
  ['unknown base with a family hint', 'Unknown', { FontFamily: PDFString.of('Carlito') }, 'é', 'Carlito-Regular.ttf'],
  ['descriptor name without a base name', undefined, { FontName: 'Cambria-Italic' }, 'é', 'Caladea-Italic.ttf'],
  ['family hint missing the requested glyph', 'Unknown', { FontFamily: PDFString.of('Cambria') }, 'Ā', 'LiberationSerif-Regular.ttf'],
  ['base name with priority over a family hint', 'Helvetica', { FontFamily: PDFString.of('Calibri') }, 'é', 'LiberationSans-Regular.ttf'],
] as const)('resolves bundled metrics for %s', async (_label, base, hints, text, expected) => {
  const doc = await PDFDocument.create(), page = doc.addPage(), ctx = doc.context;
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: {
    ...(base ? { BaseFont: base } : {}),
    FontDescriptor: { Flags: 32, ...hints },
  } } }));
  const metadata = sourceFontReader(page, [])('F1', 0);
  expect(metadata.baseFont).toBe(base ?? '');
  expect(resolveFont({ ...metadata, purpose: 'retypeset', text }).name).toBe(expected);
});

test('a descriptor metric hint does not make an unrelated local font eligible', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage(), ctx = doc.context;
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: {
    BaseFont: 'Unclassified',
    FontDescriptor: { Flags: 32, FontFamily: PDFString.of('Carlito') },
  } } }));
  const bytes = await readFile('node_modules/@docx-editor.dev/fonts/assets/Carlito-Regular.ttf');
  const options = { localFonts: [{ name: 'local-carlito.ttf', bytes }] };
  const request = { ...sourceFontReader(page, [])('F1', 0), purpose: 'cluster-fallback', text: 'A' } as const;
  expect(resolveFont({ ...request, baseFont: 'Carlito' }, options).source).toBe('local');
  expect(resolveFont(request, options)).toMatchObject({ name: 'Carlito-Regular.ttf', source: 'bundled' });
});
