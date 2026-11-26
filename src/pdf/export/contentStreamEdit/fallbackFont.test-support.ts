import { sfnt, tinyTtf } from '../fontCoverage/fixtures/programs';

/** Real OpenType tables, parsed by fontkit, with one default Latin lookup. */
export function shapingFont(kind: 'substitution' | 'position', valueFormat = 1): Uint8Array {
  const source = tinyTtf({ maps: [{ platform: 3, encoding: 1, entries: [[101, 1]] }] });
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const tables: Record<string, Uint8Array> = {};
  for (let i = 0; i < view.getUint16(4); i++) {
    const p = 12 + i * 16, offset = view.getUint32(p + 8), length = view.getUint32(p + 12);
    tables[new TextDecoder().decode(source.subarray(p, p + 4))] = source.slice(offset, offset + length);
  }
  tables['OS/2'] = new Uint8Array(100); // Editable embedding, no restrictions.
  const u16 = (...values: number[]) => values.flatMap(n => [n >>> 8 & 255, n & 255]);
  const tag = (text: string) => Array.from(text, c => c.charCodeAt(0));
  tables[kind === 'substitution' ? 'GSUB' : 'GPOS'] = Uint8Array.from([
    ...u16(1, 0, 10, 30, 44),
    // ScriptList / latn / default LangSys, selecting feature 0.
    ...u16(1), ...tag('latn'), ...u16(8, 4, 0, 0, 0xffff, 1, 0),
    // FeatureList and one lookup (ccmp is default GSUB, kern default GPOS).
    ...u16(1), ...tag(kind === 'substitution' ? 'ccmp' : 'kern'), ...u16(8, 0, 1, 0),
    ...u16(1, 4, 1, 0, 1, 8),
    // Single substitution to GID 2, or one positioning field set to 20.
    ...u16(...(kind === 'substitution' ? [2, 8, 1, 2] : [1, 8, valueFormat, 20])),
    ...u16(1, 1, 1), // Coverage format 1, containing GID 1 (e).
  ]);
  return sfnt(tables);
}
