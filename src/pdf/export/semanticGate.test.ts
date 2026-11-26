import { expect, test } from 'bun:test';
import { PDFDocument, PDFHexString, PDFName, PDFNull, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import { inventorySemantics } from './semanticGate';
import { createSemanticInspector } from './semantic/inspection';

const name = PDFName.of;

test('resolves inherited properties, distinct MCID owners and coverage of each Form invocation', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 350]);
  page.setCropBox(30, 40, 350, 300);
  page.setRotation({ type: 'degrees', angle: 90 });
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Courier);
  const outer = ctx.nextRef();
  const leaf = ctx.register(ctx.stream(
    '/Span /N#61med BDC BT /F 10 Tf 1 0 0 1 10 20 Tm (AB) Tj ET EMC',
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 50, 50], Matrix: [0, 2, -2, 0, 50, 0], StructParents: 42 },
  ));
  ctx.assign(outer, ctx.stream('q 1 0 0 1 0 5 cm /Leaf Do Q', {
    Type: 'XObject', Subtype: 'Form', BBox: [-100, -100, 100, 100],
    Resources: { Font: { F: font.ref }, XObject: { Leaf: leaf }, Properties: {
      Named: { MCID: 0, ActualText: PDFString.of('line\\\\end\\(\\)\\200'), E: PDFHexString.of('EFBBBF636166C3A9') },
    } },
  }));
  const resources = ctx.obj({ Font: { F: font.ref }, XObject: { Outer: outer } });
  page.node.Parent()!.set(name('Resources'), resources);
  page.node.delete(name('Resources'));
  page.node.set(name('StructParents'), ctx.obj(41));
  page.node.set(name('Contents'), ctx.obj([
    ctx.register(ctx.stream(String.raw`/P << /MCID 0 /ActualText (Esc\(ape\)\040` + '\\'.repeat(3) + '\r\n' + 'next) /Alt <FEFF65E5672C> >> BDC')),
    ctx.register(ctx.stream([
      'BT /F 10 Tf 1 0 0 1 42 80 Tm (ZX) Tj ET EMC',
      '/Span << /Alt (Both) >> BDC /Sect BMC',
      'q 1 0 0 1 80 100 cm /Outer Do Q q 1 0 0 1 180 100 cm /Outer Do Q',
      'EMC EMC',
    ].join('\n'))),
  ]));
  const tree = ctx.nextRef();
  const group = ctx.nextRef();
  const pageOwner = ctx.register(ctx.obj({ S: 'P', P: group, K: 0 }));
  const formOwner = ctx.register(ctx.obj({ S: 'Span', P: group,
    K: { Type: 'MCR', Stm: leaf, StmOwn: outer, MCID: 0 } }));
  ctx.assign(group, ctx.obj({
    S: 'Sect', P: tree, Pg: page.ref, K: [pageOwner, formOwner], Alt: PDFString.of('Combined section'),
  }));
  ctx.assign(tree, ctx.obj({ Type: 'StructTreeRoot', K: group, ParentTree: {
    Kids: [
      ctx.register(ctx.obj({ Limits: [41, 41], Nums: [41, ctx.register(ctx.obj([pageOwner]))] })),
      ctx.register(ctx.obj({ Limits: [42, 42], Nums: [42, [formOwner]] })),
    ],
  } }));
  doc.catalog.set(name('StructTreeRoot'), tree);

  const bytes = await doc.save();
  const rows = await inventorySemantics(bytes, 0);
  expect(rows.filter(row => row.kind === 'mcid').map(row => [row.mcid, row.stream, row.structElem]))
    .toEqual([[0, 'page', pageOwner.toString()], [0, leaf.toString(), formOwner.toString()]]);
  expect(rows).toContainEqual(expect.objectContaining({ kind: 'mcr-stm', stream: leaf.toString() }));
  expect(rows).toContainEqual(expect.objectContaining({ kind: 'actual-text', text: 'Esc(ape) \\next' }));
  expect(rows).toContainEqual(expect.objectContaining({ kind: 'alt', text: '日本' }));
  expect(rows).toContainEqual(expect.objectContaining({ kind: 'actual-text', text: 'line\\end()•', source: 'properties' }));
  expect(rows).toContainEqual(expect.objectContaining({ kind: 'expansion', text: 'café' }));
  const inherited = rows.find(row => row.text === 'Combined section')!;
  expect(inherited.structElem).toBe(group.toString());
  expect(inherited.bbox!.x).toBeCloseTo(12);
  expect(rows.find(row => row.text === 'Both')!.bbox!.w).toBeGreaterThan(100);

  const inspection = createSemanticInspector(await PDFDocument.load(bytes)).inspectPage(0)!;
  const glyphs = inspection.occurrences.filter(entry => entry.stream === leaf.toString()).map(entry => entry.glyphs);
  expect(glyphs.map(g => g.length)).toEqual([2, 2]);
  expect(glyphs[0]![0]!.placement.coreQuad[0]).toEqual({ x: 60, y: 85 });
  expect(glyphs[0]![0]!.placement.coreQuad[1]).toEqual({ x: 60, y: 97 });
  expect(glyphs[1]![0]!.placement.coreQuad[0]).toEqual({ x: 160, y: 85 });
  expect(glyphs[0]![0]!.spans.map(span => span.tag)).toEqual(['Span', 'Sect', 'Span']);
  expect(inspection.issues).toEqual([]);
});

test('localizes malformed names, duplicate IDs, broken owners and cycles to relevant spans', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Courier);
  const show = (y: number) => `BT /F 10 Tf 1 0 0 1 25 ${y} Tm (XY) Tj ET`;
  const tree = ctx.nextRef(), form = ctx.nextRef(), numberTree = ctx.nextRef();
  const good = ctx.register(ctx.obj({ S: 'P', P: tree, Pg: page.ref, K: 0 }));
  const broken = ctx.register(ctx.obj({ S: 'P', P: tree, Pg: page.ref,
    K: { Type: 'MCR', Stm: PDFRef.of(800), MCID: 1 } }));
  ctx.assign(form, ctx.stream('/Self Do', { Subtype: 'Form', BBox: [0, 0, 120, 120] }));
  ctx.assign(numberTree, ctx.obj({ Kids: [numberTree, ctx.obj({ Nums: [11, [good, broken, PDFNull]] })] }));
  ctx.assign(tree, ctx.obj({ Type: 'StructTreeRoot', ParentTree: numberTree, K: [good, broken, tree] }));
  doc.catalog.set(name('StructTreeRoot'), tree);
  page.node.set(name('StructParents'), ctx.obj(11));
  page.node.set(name('Resources'), ctx.obj({ Font: { F: font.ref }, XObject: { Self: form } }));
  page.node.set(name('Contents'), ctx.register(ctx.stream([
    '/P << /MCID 0 >> BDC', show(200), 'EMC',
    '/P /Missing BDC', show(160), 'EMC',
    '/P << /MCID 1 >> BDC', show(130), 'EMC',
    '/P << /MCID 2 >> BDC', show(100), 'EMC',
    '/P << /MCID 2 >> BDC', show(80), 'EMC',
    '/Self Do',
    show(35),
  ].join('\n'))));

  const inspection = createSemanticInspector(await PDFDocument.load(await doc.save())).inspectPage(0)!;
  const root = inspection.occurrences[0]!;
  expect(root.spans[0]!.issues).toEqual([]);
  expect(root.spans[1]!.issues.map(issue => issue.kind)).toContain('property-name');
  expect(root.spans[2]!.issues.map(issue => issue.kind)).toContain('stream-mismatch');
  for (const span of root.spans.slice(3)) {
    expect(span.issues.map(issue => issue.kind)).toContain('duplicate-mcid');
    expect(span.issues.map(issue => issue.kind)).toContain('parent-owner');
  }
  expect(root.glyphs.filter(g => g.placement.coreQuad[0].y === 35).every(g => g.spans.length === 0)).toBe(true);
  expect(inspection.issues.map(issue => issue.kind)).toEqual(expect.arrayContaining([
    'form-cycle', 'number-tree-cycle', 'structure-cycle',
  ]));
});

test('matches an explicit MCR stream against the part that contains the marked-content opener', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;
  const first = ctx.register(ctx.stream('/P << /MCID 0 >> BDC 0 0 40 40 re f'));
  const second = ctx.register(ctx.stream('EMC'));
  page.node.set(name('Contents'), ctx.obj([first, second]));
  page.node.set(name('StructParents'), ctx.obj(1));
  const tree = ctx.nextRef();
  const mcr = ctx.obj({ Type: 'MCR', Stm: second, StmOwn: page.ref, MCID: 0 });
  const owner = ctx.register(ctx.obj({ S: 'P', P: tree, Pg: page.ref, K: mcr }));
  ctx.assign(tree, ctx.obj({ Type: 'StructTreeRoot', K: owner, ParentTree: { Nums: [1, [owner]] } }));
  doc.catalog.set(name('StructTreeRoot'), tree);

  const broken = createSemanticInspector(doc).inspectPage(0)!;
  expect(broken.occurrences[0]!.spans[0]!.issues.map(issue => issue.kind)).toContain('stream-mismatch');
  const dependencies = await inventorySemantics(await doc.save(), 0);
  expect(dependencies).toContainEqual({
    kind: 'mcr-stm', source: 'struct-elem', pageIndex: 0, mcid: 0, stream: second.toString(), structElem: owner.toString(),
  });

  mcr.set(name('Stm'), first);
  const valid = createSemanticInspector(doc).inspectPage(0)!;
  expect(valid.occurrences[0]!.spans[0]!.issues).toEqual([]);
  expect(valid.dependencies.find(binding => binding.dependency.kind === 'mcr-stm')!.dependency.bbox)
    .toEqual({ x: 0, y: 0, w: 40, h: 40 });
});
