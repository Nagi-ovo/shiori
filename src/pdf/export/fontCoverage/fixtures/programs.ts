// Tiny generated sfnt programs. No downloaded fonts or host font dependency.
const u16 = (n: number) => [n >>> 8 & 255, n & 255];
const u32 = (n: number) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
export function sfnt(tables: Record<string, Uint8Array>, cff = false): Uint8Array {
  const entries = Object.entries(tables).sort(([a], [b]) => a.localeCompare(b));
  let offset = 12 + entries.length * 16;
  const records: number[] = [], body: number[] = [];
  for (const [tag, bytes] of entries) {
    records.push(...Array.from(tag, c => c.charCodeAt(0)), 0, 0, 0, 0, ...u32(offset), ...u32(bytes.length));
    body.push(...bytes);
    while (body.length % 4) body.push(0);
    offset = 12 + entries.length * 16 + body.length;
  }
  return Uint8Array.from([...(cff ? [79,84,84,79] : [0,1,0,0]), ...u16(entries.length), 0,0,0,0,0,0, ...records, ...body]);
}
export function tinyTtf(options: {
  maps?: { platform: number; encoding: number; entries: [number, number][]; subtable?: Uint8Array }[];
  empty?: number[];
} = {}): Uint8Array {
  const maps = options.maps ?? [{ platform: 3, encoding: 1, entries: [[83,1],[97,2],[110,3],[100,0],[32,4],[102,5],[105,6],[65,7],[0x301,8],[0x200b,9]] }];
  const head = new Uint8Array(54); const hv = new DataView(head.buffer);
  hv.setUint32(0, 0x10000); hv.setUint32(12, 0x5f0f3cf5); hv.setUint16(18, 1000); hv.setInt16(50, 1);
  const maxp = Uint8Array.from([...u32(0x10000), ...u16(10), ...new Array(26).fill(0)]);
  const hhea = new Uint8Array(36); const hh = new DataView(hhea.buffer);
  hh.setUint32(0,0x10000); hh.setInt16(4,800); hh.setInt16(6,-200); hh.setUint16(34,10);
  const offsets: number[] = [], glyf: number[] = [];
  for (let gid = 0; gid < 10; gid++) {
    offsets.push(glyf.length);
    if (gid === 4 || gid === 8 || gid === 9 || options.empty?.includes(gid)) continue;
    // One triangle contour; present and decodable, unlike a removed loca slot.
    glyf.push(0,1, 0,0, 0,0, 0,100, 0,100, 0,2, 0,0, 0x31,0x33,0x27, 100,100,100);
    if (glyf.length % 2) glyf.push(0);
  }
  offsets.push(glyf.length);
  const subtables = maps.map(m => {
    if (m.subtable) return m.subtable;
    const sorted = [...m.entries].sort(([a],[b]) => a-b);
    return Uint8Array.from([...u16(6),...u16(10 + ((sorted.at(-1)?.[0] ?? 0)-(sorted[0]?.[0] ?? 0)+1)*2),0,0,
      ...u16(sorted[0]?.[0] ?? 0),...u16((sorted.at(-1)?.[0] ?? 0)-(sorted[0]?.[0] ?? 0)+1),
      ...Array.from({length:(sorted.at(-1)?.[0] ?? 0)-(sorted[0]?.[0] ?? 0)+1},(_,i)=>u16(sorted.find(([cp])=>cp===i+(sorted[0]?.[0] ?? 0))?.[1] ?? 0)).flat()]);
  });
  let start = 4 + maps.length * 8;
  const cmapRecords = maps.flatMap((m,i) => { const r = [...u16(m.platform),...u16(m.encoding),...u32(start)]; start += subtables[i]!.length; return r; });
  return sfnt({ head, maxp, hhea,
    hmtx: Uint8Array.from(Array.from({length:10},()=>[...u16(500),0,0]).flat()),
    loca: Uint8Array.from(offsets.flatMap(u32)), glyf: Uint8Array.from(glyf),
    cmap: Uint8Array.from([0,0,...u16(maps.length),...cmapRecords,...subtables.flatMap(t=>[...t])]),
    post: Uint8Array.from([...u32(0x30000),...new Array(28).fill(0)]),
  });
}
function index(items: number[][]): number[] {
  if (!items.length) return [0,0];
  let pos = 1;
  return [...u16(items.length),1,...items.map(a=>{const p=pos;pos+=a.length;return p;}),pos,...items.flat()];
}
export function tinyCff(cid = true, supplement = false): Uint8Array {
  // Fixed-width DICT integers keep absolute charset/CharStrings offsets stable.
  const integer = (n: number) => [29,...u32(n)];
  const name = index([[84,105,110,121]]);
  const makeDict = (charset: number, chars: number, encoding = 0) => [
    ...(cid ? [139,139,139,12,30] : []), ...integer(charset),15,...integer(chars),17, ...(supplement ? [...integer(encoding),16] : []),
  ];
  const prefixSize = 4 + name.length + index([makeDict(0,0)]).length + 4;
  const charset = cid ? [0,0,42,0,7] : [0,0,34,0,35]; // GID1=CID42/A, GID2=CID7/B
  // Base code 65 selects SID34/A; the supplement remaps it to SID35/B.
  const encoding = supplement ? [0x80,2,65,66,1,65,0,35] : [];
  const chars = prefixSize + charset.length + encoding.length;
  return Uint8Array.from([1,0,4,4,...name,...index([makeDict(prefixSize,chars,prefixSize+charset.length)]),0,0,0,0,
    ...charset,...encoding,...index([[14],[139,139,21,239,139,5,14],[14]])]);
}

// Independent tables with known GIDs, including delta and glyph-array paths.
// S uses glyphIndexArray value 5 + idDelta 2 = GID7. T is .notdef.
export function format4Table(sValue = 5): Uint8Array {
  return Uint8Array.from([
    ...u16(4),...u16(46),0,0,...u16(6),...u16(4),...u16(1),...u16(2),
    ...[0x42,0x55,0xffff].flatMap(u16),0,0,
    ...[0x41,0x53,0xffff].flatMap(u16),
    ...[-64,2,1].flatMap(u16), ...[0,4,0].flatMap(u16),
    ...[sValue,0,1].flatMap(u16),
  ]);
}
export function format12Table(sGid = 7): Uint8Array {
  const groups = [[0x41,0x43,1],[0x53,0x53,sGid],[0x54,0x54,0],[0x10000,0x10002,5]];
  return Uint8Array.from([...u16(12),0,0,...u32(16+groups.length*12),...u32(0),...u32(groups.length),...groups.flatMap(g=>g.flatMap(u32))]);
}
// Valid, sparse BMP table for high-byte symbolic aliases (format 6 would
// overflow its 16-bit byte length when spanning the low and F000 blocks).
export function format4Points(entries: [number,number][]): Uint8Array {
  const points=[...entries].sort(([a],[b])=>a-b).concat([[0xffff,0]]);
  const count=points.length,power=2**Math.floor(Math.log2(count));
  return Uint8Array.from([
    ...u16(4),...u16(16+count*8),0,0,...u16(count*2),...u16(power*2),...u16(Math.log2(power)),...u16(count*2-power*2),
    ...points.flatMap(([cp])=>u16(cp)),0,0,...points.flatMap(([cp])=>u16(cp)),
    ...points.flatMap(([cp,gid])=>u16(gid-cp)),...points.flatMap(()=>u16(0)),
  ]);
}
