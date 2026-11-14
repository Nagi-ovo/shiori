/** fontkit masks the CFF supplement flag. Its private decoded offset is the
 * only link back to that byte; reject the font if that contract changes. */
export function cffEncodingOffset(encoding: object, table: { offset: number; length: number } | undefined): number {
  const offset: unknown = Reflect.get(encoding, '_startOffset');
  if (!table || typeof offset !== 'number' || !Number.isInteger(offset) ||
      offset < table.offset || offset >= table.offset + table.length) {
    throw Error('unverified CFF Encoding offset: fontkit private offset unavailable or invalid');
  }
  return offset;
}
