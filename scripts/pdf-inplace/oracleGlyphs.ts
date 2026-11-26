// Oracle inputs come from saved PDF bytes, independently of edit-plan codes.
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import { inspectRunPage } from '../../src/pdf/export/contentStreamEdit/replaceRunPage';
import { sourceFingerprint } from '../../src/pdf/export/contentStreamEdit/replaceRun';
import { tokenizeContentStream } from '../../src/pdf/export/contentStreamEdit/tokenizer';
import { runToUnicode } from '../../src/pdf/export/contentStreamEdit/runToUnicode';
import { fontCoverageFromDict } from '../../src/pdf/export/fontCoverage/pdfLibAdapter';
import type { FontCoverage } from '../../src/pdf/export/fontCoverage/types';

export type OracleGlyph = { fontObject: string; code: number; unicode: string; opIndex: number; itemIndex: number; edited: boolean; replacement?: boolean; glyphId?: number };
const decode = (s: PDFRawStream) => s.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(s).decode() : s.getContents();
type RawGlyph = Omit<OracleGlyph, 'unicode' | 'edited'> & { font: PDFDict; size: 1 | 2 };
function rawGlyphs(doc: PDFDocument, content: Uint8Array, resources: PDFDict, inheritedFont = ''): RawGlyph[] {
  let font = inheritedFont;
  const stack: string[] = [], result: RawGlyph[] = [];
  const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
  for (const [opIndex, op] of tokenizeContentStream(content).entries()) {
    if (op.operator === 'q') stack.push(font);
    if (op.operator === 'Q') font = stack.pop()!;
    if (op.operator === 'Tf' && op.operands[0]?.kind === 'name') font = op.operands[0].value;
    if (op.operator === 'Do' && op.operands[0]?.kind === 'name') {
      const object = resources.lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of(op.operands[0].value), PDFRawStream);
      const nested = rawGlyphs(doc, decode(object), object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources, font);
      result.push(...nested.map(g => ({ ...g, opIndex: -1 })));
    }
    if (!['Tj', 'TJ'].includes(op.operator)) continue;
    const ref = fonts.get(PDFName.of(font));
    if (!(ref instanceof PDFRef)) throw Error('oracle fixture needs indirect fonts');
    const dict = doc.context.lookup(ref, PDFDict);
    const size = dict.lookup(PDFName.of('Subtype'), PDFName).decodeText() === 'Type0' ? 2 : 1;
    const items = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : op.operands;
    for (const [itemIndex, item] of items.entries()) {
      if (item.kind !== 'string') continue;
      if (item.bytes.length % size) throw Error('unaligned oracle code');
      for (let i = 0; i < item.bytes.length; i += size) {
        const code = size === 1 ? item.bytes[i]! : item.bytes[i]! * 256 + item.bytes[i + 1]!;
        result.push({ fontObject: ref.toString(), code, font: dict, size, opIndex,
          itemIndex: op.operator === 'TJ' ? itemIndex : -1 });
      }
    }
  }
  return result;
}
export function sourceGlyphs(doc: PDFDocument, content: Uint8Array, resources: PDFDict, hashes: Record<string, string>): OracleGlyph[] {
  const maps = new Map<PDFDict, Map<number, string>>();
  const coverage = new Map<PDFDict, FontCoverage>();
  return rawGlyphs(doc, content, resources).map(({ font, size, ...glyph }) => {
    if (!maps.has(font)) {
      const cmap = runToUnicode(new TextDecoder().decode(decode(font.lookup(PDFName.of('ToUnicode'), PDFRawStream))), size);
      if (!cmap) throw Error('fixture missing mapping');
      maps.set(font, cmap);
      coverage.set(font, fontCoverageFromDict(font));
      const descendant = size === 2 ? font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict) : font;
      const descriptor = descendant.lookup(PDFName.of('FontDescriptor'), PDFDict);
      const program = descriptor.lookupMaybe(PDFName.of('FontFile2'), PDFRawStream) ?? descriptor.lookup(PDFName.of('FontFile3'), PDFRawStream);
      hashes[glyph.fontObject] = sourceFingerprint(decode(program));
    }
    const unicode = maps.get(font)!.get(glyph.code);
    if (!unicode || Array.from(unicode).length !== 1) throw Error('fixture code not one scalar');
    const glyphId = coverage.get(font)!.glyphIds.get(glyph.code.toString(16).padStart(size * 2, '0'));
    return { ...glyph, unicode, glyphId, edited: false };
  });
}
export async function readSavedGlyphs(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(0), content = inspectRunPage(page);
  if (!content.ok) throw Error(content.reason);
  const fontHashes: Record<string, string> = {};
  const glyphs = sourceGlyphs(doc, content.bytes, page.node.Resources()!, fontHashes);
  return { glyphs, fontHashes };
}
export function assertSavedGlyphs(expected: readonly OracleGlyph[], actual: readonly OracleGlyph[]) {
  if (actual.length !== expected.length) throw Error(`saved glyph count ${actual.length} != ${expected.length}`);
  for (const [i, a] of actual.entries()) {
    const e = expected[i]!;
    if (a.fontObject !== e.fontObject || a.code !== e.code || a.unicode !== e.unicode) {
      throw Error(`saved glyph ${i}: expected ${e.fontObject}/${e.code}/${e.unicode}, got ${a.fontObject}/${a.code}/${a.unicode}`);
    }
  }
}

// The spike deliberately has no ToUnicode. For these known WinAnsi/ASCII
// Embedded CFF fixtures only: the embedded program is FULL, with ASCII glyphs.
// Advertise ASCII extraction metadata; canEncode independently checks presence.
export function addFixtureAsciiMappings(page: PDFPage) {
  const content = inspectRunPage(page);
  if (!content.ok) throw Error(content.reason);
  const fonts = new Set<PDFDict>();
  for (const glyph of rawGlyphs(page.doc, content.bytes, page.node.Resources()!)) {
    if (glyph.font.has(PDFName.of('ToUnicode'))) continue;
    if (glyph.size !== 1 || glyph.font.lookup(PDFName.of('BaseFont'), PDFName).decodeText() !== 'SHIORI+FoxitSerif' ||
        glyph.font.lookup(PDFName.of('Encoding'), PDFName).decodeText() !== 'WinAnsiEncoding' || glyph.code < 32 || glyph.code > 126) {
      throw Error('cannot synthesize mapping outside known ASCII spike fixture');
    }
    fonts.add(glyph.font);
  }
  for (const font of fonts) {
    const entries = Array.from({ length: 95 }, (_, i) => i + 32).map(c => `<${c.toString(16).padStart(2, '0')}> <${c.toString(16).padStart(4, '0')}>`);
    const program = `${entries.length} beginbfchar\n${entries.join('\n')}\nendbfchar`;
    font.set(PDFName.of('ToUnicode'), page.doc.context.register(page.doc.context.stream(new TextEncoder().encode(program))));
  }
}
