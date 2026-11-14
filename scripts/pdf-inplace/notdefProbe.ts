// Construct known-GID0 native probes WITHOUT the coverage resolver. Reuse the
// exact embedded program; force two probe codes to .notdef/GID0 in PDF encoding.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectCopier } from 'pdf-lib';
export async function notdefProbePdf(source: Uint8Array, objects: readonly string[]) {
  const original = await PDFDocument.load(source, { updateMetadata: false });
  const doc = await PDFDocument.create(), ctx = doc.context;
  const dictionaries = new Map(original.context.enumerateIndirectObjects().map(([ref, value]) => [ref.toString(), value]));
  const copier = PDFObjectCopier.for(original.context, ctx);
  for (const object of objects) {
    const sourceFont = dictionaries.get(object);
    if (!(sourceFont instanceof PDFDict)) throw Error(`native probe font missing: ${object}`);
    const type0 = String(sourceFont.lookup(PDFName.of('Subtype'))) === '/Type0';
    const child = type0 ? sourceFont.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict) : sourceFont;
    const descriptor = child.lookup(PDFName.of('FontDescriptor'), PDFDict);
    const copiedDescriptor = copier.copy(descriptor);
    const flags = copiedDescriptor.lookup(PDFName.of('Flags'));
    copiedDescriptor.set(PDFName.of('Flags'), PDFNumber.of(((flags instanceof PDFNumber ? flags.asNumber() : 0) & ~4) | 32));
    const descriptorRef = ctx.register(copiedDescriptor);
    const trueType = descriptor.has(PDFName.of('FontFile2'));
    const cidCff = String(child.lookup(PDFName.of('Subtype'))) === '/CIDFontType0';
    const wide = trueType || cidCff;
    let font: PDFDict;
    const toUnicode = ctx.register(ctx.flateStream(`2 beginbfchar ${wide ? '<0000> <fffe> <0001> <ffff>' : '<00> <fffe> <01> <ffff>'} endbfchar`));
    if (wide) {
      const childRef = ctx.register(ctx.obj({ Type: 'Font', Subtype: trueType ? 'CIDFontType2' : 'CIDFontType0',
        BaseFont: 'NativeNotdefProbe', FontDescriptor: descriptorRef, DW: 500,
        CIDSystemInfo: { Registry: ctx.obj('Adobe'), Ordering: ctx.obj('Identity'), Supplement: 0 },
        // Explicit zeros, not a GID inferred from coverage or a source CMap.
        ...(trueType ? { CIDToGIDMap: ctx.register(ctx.flateStream(Uint8Array.of(0, 0, 0, 0))) } : {}) }));
      const encoding = trueType ? PDFName.of('Identity-H') : ctx.register(ctx.flateStream(
        '1 begincodespacerange <0000> <ffff> endcodespacerange 2 begincidchar <0000> 0 <0001> 0 endcidchar'));
      font = ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'NativeNotdefProbe', Encoding: encoding, DescendantFonts: [childRef], ToUnicode: toUnicode });
    } else {
      if (!descriptor.has(PDFName.of('FontFile3'))) throw Error('native .notdef probe unsupported font program');
      font = ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'NativeNotdefProbe', FontDescriptor: descriptorRef,
        FirstChar: 0, LastChar: 1, Widths: [500, 500], Encoding: { Differences: [0, '.notdef', '.notdef'] }, ToUnicode: toUnicode });
    }
    const page = doc.addPage([100, 100]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { Probe: ctx.register(font) } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(`BT /Probe 12 Tf 10 50 Td <${wide ? '00000001' : '0001'}> Tj ET`)));
  }
  return doc.save({ useObjectStreams: false });
}
