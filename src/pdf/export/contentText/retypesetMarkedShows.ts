import { PDFDict, PDFName, PDFNumber } from 'pdf-lib';
import type { ContentOp } from '../contentStreamEdit/tokenizer';
import type { GlyphPlacement } from '../contentStreamEdit/textState';
import { address, type readRetypesetSource } from './retypesetSource';
import type { RetypesetCluster } from './retypesetTypes';

export function markedShow(ops: ContentOp[], properties: PDFDict | undefined) {
  const marks = new Set<number>();
  for (const [i, op] of ops.entries()) {
    if (op.operator !== 'BDC') continue;
    const operand = op.operands[1];
    let mcid: number | undefined;
    if (operand?.kind === 'dict') mcid = operand.entries.find(entry => entry.key === 'MCID')?.numberValue;
    else if (operand?.kind === 'name' && properties) {
      const dict = properties.lookup(PDFName.of(operand.value));
      const id = dict instanceof PDFDict && dict.lookup(PDFName.of('MCID'));
      if (id instanceof PDFNumber) mcid = id.asNumber();
    }
    if (mcid !== undefined && Number.isSafeInteger(mcid) && mcid >= 0) marks.add(i);
  }
  return (glyph: GlyphPlacement) => glyph.markedContent.some(index => marks.has(index));
}

/** A partial TJ rewrite leaves its surviving bytes before the insertion
 * slot. Re-emit those bytes at their original positions in a marked show
 * so an untouched suffix still follows the edited characters. */
export function retainedMarkedGlyphs(
  hits: GlyphPlacement[], source: ReturnType<typeof readRetypesetSource>, marked: (glyph: GlyphPlacement) => boolean,
  deltas: ReadonlyMap<string, number>,
) {
  const shows = new Set(hits.filter(marked).map(g => g.opIndex));
  const deleted = new Set(hits.map(address));
  const retained = source.glyphs.filter(({ glyph }) => shows.has(glyph.opIndex) && !deleted.has(address(glyph)));
  if (retained.some(({ glyph }) => deltas.has(address(glyph)))) return [];
  return retained.map(home => {
    const g = home.glyph;
    return { home, text: home.text ?? '', font: source.fonts.find(font => font.resourceName === g.fontName)!,
      bytes: g.byteLength === 1 ? Uint8Array.of(g.code) : Uint8Array.of(g.code >> 8, g.code & 255),
    } satisfies RetypesetCluster;
  });
}

// Only dictionaries allocated by this compile are candidates for reuse.
const strippedPropertyClones = new WeakSet<PDFDict>();
export const isStrippedPropertyClone = (dict: PDFDict) => strippedPropertyClones.has(dict);

export function stripNamedEquivalents(properties: PDFDict | undefined) {
  const renamed = new Map<string, string>();
  const keys = ['ActualText', 'Alt', 'E'].map(key => PDFName.of(key));
  return (name: string) => {
    if (renamed.has(name)) return renamed.get(name)!;
    const dict = properties?.lookupMaybe(PDFName.of(name), PDFDict);
    if (!dict || !keys.some(key => dict.has(key))) return null;
    let index = 1;
    while (properties!.has(PDFName.of(`ShioriRtProp${index}`))) index += 1;
    const replacement = `ShioriRtProp${index}`, copy = dict.clone();
    for (const key of keys) copy.delete(key);
    strippedPropertyClones.add(copy);
    properties!.set(PDFName.of(replacement), copy);
    renamed.set(name, replacement);
    return replacement;
  };
}
