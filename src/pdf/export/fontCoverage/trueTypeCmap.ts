/** Rendering cmap lookup with a hole distinct from an explicit .notdef.
 * Reads only the existing (3,0), (3,1), (1,0) selection paths. */
export type CmapLookup = (code: number) => number | undefined;
const malformed = (detail: string): never => { throw Error(`symbolic-cmap-unsupported: malformed TrueType cmap (${detail})`); };

function subtable(bytes: Uint8Array): CmapLookup {
  if (bytes.length < 4) return malformed('header');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), format = v.getUint16(0);
  if (![0, 4, 6, 10, 12, 13].includes(format)) throw Error(`tt-cmap-format-unsupported: Unsupported TrueType cmap format ${format}`);
  const long = format >= 10;
  if (long && (bytes.length < 12 || v.getUint16(2) !== 0)) return malformed('long header');
  const length = long ? v.getUint32(4) : v.getUint16(2);
  if (length > bytes.length || length < (long ? 12 : 6)) return malformed('length');
  const need = (end: number) => { if (end > length) malformed('truncated arrays'); };
  if (format === 0) {
    need(262);
    return cp => cp >= 0 && cp < 256 ? v.getUint8(6 + cp) : undefined;
  }
  if (format === 6 || format === 10) {
    need(format === 6 ? 10 : 20);
    const first = format === 6 ? v.getUint16(6) : v.getUint32(12);
    const count = format === 6 ? v.getUint16(8) : v.getUint32(16), start = format === 6 ? 10 : 20;
    need(start + count * 2);
    if (first + count > (format === 6 ? 0x10000 : 0x110000)) return malformed('code range');
    return cp => cp >= first && cp < first + count ? v.getUint16(start + (cp - first) * 2) : undefined;
  }
  if (format === 4) {
    need(16);
    const segCountX2 = v.getUint16(6), count = segCountX2 / 2;
    if (!count || segCountX2 % 2) return malformed('segment count');
    need(16 + count * 8);
    if (v.getUint16(14 + count * 2) !== 0) return malformed('reserved pad');
    const segments: { first: number; last: number; delta: number; word: number; offset: number }[] = [];
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const last = v.getUint16(14 + i * 2), first = v.getUint16(16 + count * 2 + i * 2);
      const delta = v.getInt16(16 + count * 4 + i * 2), word = 16 + count * 6 + i * 2, offset = v.getUint16(word);
      if (first > last || first <= previous) return malformed('overlapping/unordered segments');
      if (offset && (offset % 2 || word + offset < 16 + count * 8 || word + offset + (last - first + 1) * 2 > length)) return malformed('idRangeOffset');
      segments.push({ first, last, delta, word, offset }); previous = last;
    }
    return cp => {
      const s = segments.find(s => cp >= s.first && cp <= s.last);
      if (!s) return undefined;
      if (!s.offset) return (cp + s.delta) & 65535;
      const gid = v.getUint16(s.word + s.offset + (cp - s.first) * 2);
      return gid === 0 ? 0 : (gid + s.delta) & 65535;
    };
  }
  need(16);
  const count = v.getUint32(12); need(16 + count * 12);
  const groups: { first: number; last: number; gid: number }[] = [];
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const p = 16 + i * 12, first = v.getUint32(p), last = v.getUint32(p + 4), gid = v.getUint32(p + 8);
    if (first > last || first <= previous || last > 0x10ffff || gid + (format === 12 ? last - first : 0) > 0xffffffff) return malformed('group range');
    groups.push({ first, last, gid }); previous = last;
  }
  return cp => {
    const g = groups.find(g => cp >= g.first && cp <= g.last);
    return g ? g.gid + (format === 12 ? cp - g.first : 0) : undefined;
  };
}

export function trueTypeCmaps(data: Uint8Array, entry?: { offset: number; length: number }) {
  const records: { platform: number; encoding: number; offset: number }[] = [];
  const bytes = entry ? data.subarray(entry.offset, entry.offset + entry.length) : new Uint8Array();
  if (entry) {
    if (entry.offset + entry.length > data.length || bytes.length < 4) return malformed('directory');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = v.getUint16(2);
    if (v.getUint16(0) !== 0 || 4 + count * 8 > bytes.length) return malformed('records');
    for (let i = 0; i < count; i++) {
      const p = 4 + i * 8, offset = v.getUint32(p + 4);
      if (offset < 4 + count * 8 || offset + 4 > bytes.length) return malformed('subtable offset');
      records.push({ platform: v.getUint16(p), encoding: v.getUint16(p + 2), offset });
    }
  }
  return (platform: number, encoding: number): CmapLookup | undefined => {
    const matches = records.filter(r => r.platform === platform && r.encoding === encoding);
    if (platform === 3 && encoding === 0 && matches.length > 1) throw Error('symbolic-cmap-ambiguous: duplicate (3,0) selection records');
    return matches.length ? subtable(bytes.subarray(matches[0]!.offset)) : undefined;
  };
}

export function symbolicGid(lookup: CmapLookup, code: number): number | { reason: string } {
  const hits = [0, 0xf000, 0xf100, 0xf200].map(base => lookup(base + code));
  const gids = new Set(hits.filter((gid): gid is number => gid !== undefined));
  if (gids.has(0) || gids.size > 1) return { reason: `symbolic-cmap-ambiguous: Symbolic code ${code} selects conflicting glyphs` };
  return gids.values().next().value ?? { reason: `symbolic-cmap-unsupported: No supported symbolic cmap selects code ${code}` };
}
