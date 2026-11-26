import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { openPdfium } from '../../../../scripts/pdf-inplace/nativePdfium';
import { inspectRunPage } from '../contentStreamEdit/replaceRunPage';
import { tokenizeContentStream } from '../contentStreamEdit/tokenizer';
import { exportPdf } from '../exportPdf';
import { fixture, model, overlay } from './fixtures.test-support';

const nativeLibrary = 'vendor/pdfium/linux-x64/lib/libpdfium.so';
const nativeTest = test.skipIf(!existsSync(nativeLibrary));

async function pageContent(bytes: Uint8Array) {
  const page = (await PDFDocument.load(bytes)).getPage(0);
  const source = inspectRunPage(page);
  if (!source.ok) throw Error(source.reason);
  return source.bytes;
}

async function shownText(bytes: Uint8Array) {
  const decoder = new TextDecoder();
  return tokenizeContentStream(await pageContent(bytes)).flatMap(op => {
    const operand = op.operands[0];
    const items = op.operator === 'Tj' && operand?.kind === 'string' ? [operand]
      : op.operator === 'TJ' && operand?.kind === 'array' ? operand.items : [];
    return items.flatMap(item => item.kind === 'string' ? [decoder.decode(item.bytes)] : []);
  }).join('');
}

for (const { originalText, text, show, selectedWidth, retainedOrigins, literalSeparator, positionedSpace } of [
  {
    originalText: 'ABC GHI', text: 'AC GI', show: '[(ABC GHI) -1600 (KEEP)] TJ',
    selectedWidth: 42, retainedOrigins: [50, 56, 68, 74], literalSeparator: '',
  },
  {
    originalText: 'ABC GHI', text: 'AC HI', show: '(ABC GHI KEEP) Tj',
    selectedWidth: 42, retainedOrigins: [50, 56, 68, 74], literalSeparator: ' ',
  },
  {
    originalText: 'AB-CD EF-GH', text: 'A-CD E-GH', show: '(AB-CD EF-GH) Tj [-1600 (KEEP)] TJ',
    selectedWidth: 66, retainedOrigins: [50, 56, 62, 68, 80, 86, 92, 98], literalSeparator: '',
  },
  {
    originalText: 'AB-CD EF-GH', text: 'ABCDEF-GH', show: '[(AB-CD EF-GH) -1600 (KEEP)] TJ',
    selectedWidth: 66, retainedOrigins: [50, 56, 62, 68, 74, 80, 86, 92, 98], literalSeparator: '',
  },
  {
    originalText: 'AB-CD EF-GH IJ', text: 'A-CD E-GH J', show: '[(AB-CD EF-GH IJ) -1600 (KEEP)] TJ',
    selectedWidth: 84, retainedOrigins: [50, 56, 62, 68, 80, 86, 92, 98, 110], literalSeparator: '',
  },
  {
    originalText: 'ABC GHI SUFFIX', text: 'AC GI SUFFIX', show: '(ABC GHI SUFFIX KEEP) Tj',
    selectedWidth: 84, retainedOrigins: [50, 56, 68, 74, 86, 92, 98, 104, 110, 116], literalSeparator: ' ',
  },
  {
    originalText: 'ABC GHI', text: 'AC GI', show: '[(ABC) -1600 (GHI) -1600 (KEEP)] TJ',
    selectedWidth: 52, retainedOrigins: [50, 56, 84, 90], literalSeparator: '', positionedSpace: true,
  },
  {
    originalText: 'ABCDEFG', text: 'ACDFG', show: '(ABC) Tj (DEFG) Tj [-1800 (KEEP)] TJ',
    selectedWidth: 42, retainedOrigins: [50, 56, 62, 68, 74], literalSeparator: '',
  },
  {
    originalText: 'ABC GHI', text: 'AC GI', show: '(ABC ) Tj (GHI) Tj [-1600 (KEEP)] TJ',
    selectedWidth: 42, retainedOrigins: [50, 56, 68, 74], literalSeparator: '',
  },
  {
    originalText: 'ABCAADEF', text: 'ACAADF', show: '(ABCA) Tj (ADEF) Tj [-1800 (KEEP)] TJ',
    selectedWidth: 48, retainedOrigins: [50, 56, 62, 68, 74, 80], literalSeparator: '',
  },
]) {
  nativeTest(`deletions in ${show} save ${JSON.stringify(text)} and anchor the following field`, async () => {
    const { doc } = await fixture(`BT /F1 10 Tf 50 100 Td ${show} ET`);
    const source = await doc.save();
    const edit = overlay({ originalText, text, coverRects: [{ x: 49, y: 98, w: selectedWidth + 1, h: 13 }] });
    const result = await exportPdf(source, model([edit]), { mode: 'flatten' });
    const encoded = (value: string) => `${positionedSpace ? value.replace(' ', '') : value}${literalSeparator}KEEP`;

    const pdfium = openPdfium(nativeLibrary);
    try {
      const before = pdfium.inspectPage(source, 0, true);
      const after = pdfium.inspectPage(result.bytes, 0, true);
      const ink = after.glyphs.filter(g => g.text !== ' ');
      expect(before.text).toBe(`${originalText} KEEP`);
      expect(await shownText(source)).toBe(encoded(originalText));
      expect({
        text: after.text,
        origins: ink.slice(0, -4).map(g => g.origin),
        anchor: ink.slice(-4).map(g => [g.text, g.origin]),
        outcome: result.contentTextOutcomes,
      }).toEqual({
        text: `${text} KEEP`,
        origins: retainedOrigins.map(x => [x, 100]),
        anchor: before.glyphs.slice(-4).map(g => [g.text, g.origin]),
        outcome: [{ overlayId: 'edit', pageIndex: 0, mode: 'in-place', fidelity: 'exact' }],
      });
      expect(await shownText(result.bytes)).toBe(encoded(text));
      expect(ink.every(g => g.fontSize === 10 && g.fontHash === before.glyphs[0]!.fontHash)).toBe(true);
    } finally {
      pdfium.close();
    }
  });
}

for (const { show, originalText, text, selectedWidth } of [
  { show: '(ABC) Tj 0 Tc (DEFG) Tj [-1800 (LOCK)] TJ', originalText: 'ABCDEFG', text: 'ACDFG', selectedWidth: 42 },
  { show: '[(ABC) -1600 (GHI) -1600 (LOCK)] TJ', originalText: 'ABC GHI', text: 'ACGI', selectedWidth: 52 },
]) {
  nativeTest(`unproved close-up in ${show} keeps the original text and independent field`, async () => {
    const { doc } = await fixture(`BT /F1 10 Tf 50 100 Td ${show} ET`);
    const source = await doc.save();
    const edit = overlay({ originalText, text, coverRects: [{ x: 49, y: 98, w: selectedWidth + 1, h: 13 }] });
    const result = await exportPdf(source, model([edit]), { mode: 'flatten' });

    const pdfium = openPdfium(nativeLibrary);
    try {
      const before = pdfium.inspectPage(source);
      const after = pdfium.inspectPage(result.bytes);
      expect(before.text).toBe(`${originalText} LOCK`);
      expect({
        text: after.text,
        origins: after.glyphs.map(g => [g.text, g.origin]),
        outcomes: result.contentTextOutcomes?.map(o => [o.mode, o.fidelity]),
        unexcised: result.unexcisedEdits,
      }).toEqual({
        text: before.text,
        origins: before.glyphs.map(g => [g.text, g.origin]),
        outcomes: [['unsupported', undefined]],
        unexcised: 1,
      });
      expect(await pageContent(result.bytes)).toEqual(await pageContent(source));
    } finally {
      pdfium.close();
    }
  });
}

for (const [name, show] of [
  ['one string', '(ABCDE) Tj'],
  ['one array', '[(ABC) 0 (DE)] TJ'],
  ['adjacent shows', '(ABC) Tj (DE) Tj'],
] as const) {
  nativeTest(`an internal deletion closes up a word in ${name} and rejoins the shared text object`, async () => {
    const { doc } = await fixture(`BT /F1 10 Tf 50 100 Td ${show} [-1600] TJ (KEEP) Tj T* ET`);
    const source = await doc.save();
    const result = await exportPdf(source, model([overlay({ text: 'ABDE' })]), { mode: 'annotations' });
    expect(result.contentTextOutcomes).toEqual([{ overlayId: 'edit', pageIndex: 0, mode: 'in-place', fidelity: 'exact' }]);

    const pdfium = openPdfium(nativeLibrary);
    try {
      const before = pdfium.inspectPage(source, 0, true);
      const after = pdfium.inspectPage(result.bytes, 0, true);
      expect(after.text).toBe('ABDE KEEP');
      const survivorIndexes = [0, 1, 3, 4, 5, 6, 7, 8];
      const originIndexes = [0, 1, 2, 3, 5, 6, 7, 8];
      expect(after.glyphs.map(g => [g.text, g.fontSize, g.fontHash, g.angle]))
        .toEqual(survivorIndexes.map(i => {
          const g = before.glyphs[i]!;
          return [g.text, g.fontSize, g.fontHash, g.angle];
        }));
      expect(after.glyphs.map(g => g.origin)).toEqual(originIndexes.map(i => before.glyphs[i]!.origin));
    } finally {
      pdfium.close();
    }
  });
}

nativeTest('removing a kerned glyph rejoins at its origin and keeps an unowned field in the same array', async () => {
  const { doc } = await fixture('BT /F1 10 Tf 50 100 Td [(AB) -95 (C) -95 (DE) -1600 (KEEP)] TJ ET');
  const source = await doc.save();
  const result = await exportPdf(source, model([overlay({ text: 'ABDE', coverRects: [{ x: 49, y: 98, w: 34, h: 13 }] })]));

  const pdfium = openPdfium(nativeLibrary);
  try {
    const before = pdfium.inspectPage(source);
    const after = pdfium.inspectPage(result.bytes);
    expect(before.text).toBe('ABCDE KEEP');
    expect(after.text).toBe('ABDE KEEP');
    expect(after.glyphs[2]!.origin).toEqual(before.glyphs[2]!.origin);
    expect(after.glyphs.slice(-4).map(g => g.origin)).toEqual(before.glyphs.slice(-4).map(g => g.origin));
  } finally {
    pdfium.close();
  }
});

nativeTest('closing a word preserves authored character spacing and horizontal scale', async () => {
  const { doc } = await fixture('BT /F1 10 Tf .75 Tc 80 Tz 50 100 Td (ABCDE) Tj [-2400] TJ (KEEP) Tj ET');
  const source = await doc.save();
  const result = await exportPdf(source, model([overlay({ text: 'ABDE' })]));

  const pdfium = openPdfium(nativeLibrary);
  try {
    const before = pdfium.inspectPage(source);
    const after = pdfium.inspectPage(result.bytes);
    expect(after.text).toBe('ABDE KEEP');
    expect(after.glyphs[2]!.origin[0]).toBeCloseTo(before.glyphs[2]!.origin[0], 4);
    expect(after.glyphs[3]!.origin[0]).toBeCloseTo(before.glyphs[3]!.origin[0], 4);
    expect(after.glyphs.slice(-4).map(g => g.origin)).toEqual(before.glyphs.slice(-4).map(g => g.origin));
  } finally {
    pdfium.close();
  }
});

nativeTest('clearing a multi-line selection removes its source spaces and keeps the next line', async () => {
  const { doc } = await fixture('BT /F1 10 Tf 50 100 Td (AB CD) Tj 0 -20 Td [(FG) 0 (HIJ)] TJ 0 -20 Td (KEEP) Tj ET');
  const source = await doc.save();
  const edit = overlay({
    originalText: 'AB CD\nFGHIJ',
    text: '',
    coverRects: [{ x: 49, y: 98, w: 32, h: 13 }, { x: 49, y: 78, w: 32, h: 13 }],
  });
  const result = await exportPdf(source, model([edit]), { mode: 'annotations' });
  expect(result.contentTextOutcomes).toEqual([{ overlayId: 'edit', pageIndex: 0, mode: 'in-place', fidelity: 'exact' }]);

  const pdfium = openPdfium(nativeLibrary);
  try {
    const before = pdfium.inspectPage(source);
    const after = pdfium.inspectPage(result.bytes);
    expect(after.text).toBe('KEEP');
    expect(after.glyphs.map(g => g.origin)).toEqual(before.glyphs.slice(-4).map(g => g.origin));
  } finally {
    pdfium.close();
  }
});

for (const { name, show, originalText, text, coverWidth } of [
  { name: 'leading glyph', show: '(ABCDE) Tj', originalText: 'ABCDE', text: 'BCDE', coverWidth: 32 },
  { name: 'punctuation mark', show: '(AB-CD) Tj', originalText: 'AB-CD', text: 'ABCD', coverWidth: 32 },
  { name: 'literal space', show: '(AB CD) Tj', originalText: 'AB CD', text: 'ABCD', coverWidth: 32 },
  { name: 'literal space beside an inferred space', show: '(AB CD) Tj', originalText: 'AB CD KEEP', text: 'ABCD KEEP', coverWidth: 72 },
  { name: 'glyph before another owned word', show: '(ABC D) Tj', originalText: 'ABC D', text: 'AB D', coverWidth: 32 },
]) {
  nativeTest(`deleting a ${name} closes the selected run and keeps the field anchored`, async () => {
    const { doc } = await fixture(`BT /F1 10 Tf 50 100 Td ${show} [-1600] TJ (KEEP) Tj ET`);
    const source = await doc.save();
    const edit = overlay({ originalText, text, coverRects: [{ x: 49, y: 98, w: coverWidth, h: 13 }] });
    const result = await exportPdf(source, model([edit]), { mode: 'flatten' });

    const pdfium = openPdfium(nativeLibrary);
    try {
      const before = pdfium.inspectPage(source, 0, true);
      const after = pdfium.inspectPage(result.bytes, 0, true);
      expect(after.text).toBe(text.endsWith('KEEP') ? text : `${text} KEEP`);
      expect(after.glyphs.slice(0, 4).map(g => g.origin[0])).toEqual([50, 56, 62, 68]);
      expect(after.glyphs.slice(-4).map(g => g.origin)).toEqual(before.glyphs.slice(-4).map(g => g.origin));
      expect(after.glyphs.every(g => g.fontSize === 10 && g.fontHash === before.glyphs[0]!.fontHash)).toBe(true);
      expect(result.contentTextOutcomes).toMatchObject([{ mode: 'in-place', fidelity: 'exact' }]);
    } finally {
      pdfium.close();
    }
  });
}

nativeTest('an inferred space between fields cannot authorize movement or glyph removal', async () => {
  const { doc } = await fixture('BT /F1 10 Tf 50 100 Td [(AB) -1600 (CD)] TJ ET');
  const source = await doc.save();
  const edit = overlay({ originalText: 'AB CD', text: 'ABCD', coverRects: [{ x: 49, y: 98, w: 42, h: 13 }] });
  const result = await exportPdf(source, model([edit]), { mode: 'flatten' });

  const pdfium = openPdfium(nativeLibrary);
  try {
    const before = pdfium.inspectPage(source);
    const after = pdfium.inspectPage(result.bytes);
    expect(after.text).toBe('AB CD');
    expect(after.glyphs.map(g => g.origin)).toEqual(before.glyphs.map(g => g.origin));
    expect(result.contentTextOutcomes).toMatchObject([{ mode: 'unsupported' }]);
  } finally {
    pdfium.close();
  }
});
