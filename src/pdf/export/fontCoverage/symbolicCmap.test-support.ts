import { sfnt, tinyTtf } from './fixtures/programs';

export function ttfTables(bytes: Uint8Array): Record<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.fromEntries(Array.from({ length: v.getUint16(4) }, (_, i) => {
    const p = 12 + i * 16, offset = v.getUint32(p + 8), length = v.getUint32(p + 12);
    return [String.fromCharCode(...bytes.slice(p, p + 4)), bytes.slice(offset, offset + length)];
  }));
}
export function namedTtf(options: Parameters<typeof tinyTtf>[0] = {}): Uint8Array {
  const tables = ttfTables(tinyTtf(options));
  const names = ['.notdef', 'S', 'a', 'n', 'space', 'f', 'i', 'A', 'uni0301', 'uni200B'];
  const post = new Uint8Array(34 + 20 + names.reduce((n, s) => n + 1 + s.length, 0));
  const v = new DataView(post.buffer); v.setUint32(0, 0x20000); v.setUint16(32, names.length);
  let offset = 54;
  names.forEach((name, i) => {
    v.setUint16(34 + i * 2, 258 + i); post[offset++] = name.length;
    post.set(Array.from(name, c => c.charCodeAt(0)), offset); offset += name.length;
  });
  return sfnt({ ...tables, post });
}
