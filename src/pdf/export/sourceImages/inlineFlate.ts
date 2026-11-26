// Walk the zlib framing and DEFLATE codes without allocating decoded pixels.
const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];

function invalid(): never {
  throw Error("invalid Flate inline image framing");
}

function huffman(lengths: number[]): Map<number, number> {
  const codes = new Map<number, number>();
  let next = 0;
  for (let width = 1; width <= 15; width += 1) {
    next <<= 1;
    for (const [symbol, length] of lengths.entries()) {
      if (length !== width) continue;
      if (next >= (1 << width)) invalid();
      codes.set((1 << width) | next++, symbol);
    }
  }
  return codes;
}

const fixedLiterals = huffman(Array.from({ length: 288 }, (_, code) =>
  code < 144 ? 8 : code < 256 ? 9 : code < 280 ? 7 : 8));
const fixedDistances = huffman(Array<number>(32).fill(5));

export function flateInlineEnd(bytes: Uint8Array, start: number): number {
  const cmf = bytes[start] ?? 0;
  const flags = bytes[start + 1] ?? 0;
  if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || (256 * cmf + flags) % 31 !== 0 || (flags & 32)) invalid();

  let bit = (start + 2) * 8;
  const read = (width: number): number => {
    if (bit + width > bytes.length * 8) invalid();
    let value = 0;
    for (let i = 0; i < width; i += 1, bit += 1) {
      value |= ((bytes[Math.floor(bit / 8)]! >>> (bit % 8)) & 1) << i;
    }
    return value;
  };

  const symbol = (codes: Map<number, number>): number => {
    let code = 1;
    for (let width = 1; width <= 15; width += 1) {
      code = (code << 1) | read(1);
      const value = codes.get(code);
      if (value !== undefined) return value;
    }
    return invalid();
  };

  function dynamicCodes() {
    const literals = read(5) + 257;
    const distances = read(5) + 1;
    const lengths = read(4) + 4;
    if (literals > 286) invalid();
    const codes = Array<number>(19).fill(0);
    for (let i = 0; i < lengths; i += 1) codes[codeLengthOrder[i]!] = read(3);
    const alphabet = huffman(codes);
    const decoded: number[] = [];
    while (decoded.length < literals + distances) {
      const length = symbol(alphabet);
      if (length < 16) {
        decoded.push(length);
      } else {
        if (length === 16 && decoded.length === 0) invalid();
        const count = length === 18 ? read(7) + 11 : length === 17 ? read(3) + 3 : read(2) + 3;
        const value = length === 16 ? decoded[decoded.length - 1]! : 0;
        for (let i = 0; i < count; i += 1) decoded.push(value);
      }
    }
    if (decoded.length !== literals + distances || !decoded[256]) invalid();
    return [huffman(decoded.slice(0, literals)), huffman(decoded.slice(literals))] as const;
  }

  let last: number;
  let output = 0;
  do {
    last = read(1);
    const type = read(2);
    if (type === 0) {
      bit = Math.ceil(bit / 8) * 8;
      const length = read(16);
      if ((length ^ read(16)) !== 0xffff) invalid();
      bit += length * 8;
      output += length;
      continue;
    }
    if (type === 3) invalid();
    const [literals, distances] = type === 1 ? [fixedLiterals, fixedDistances] : dynamicCodes();
    while (true) {
      const value = symbol(literals);
      if (value === 256) break;
      if (value < 256) {
        output += 1;
        continue;
      }
      const index = value - 257;
      const base = lengthBase[index];
      if (base === undefined) invalid();
      const length = base + read(index === 28 ? 0 : Math.max(0, Math.floor(index / 4) - 1));
      const distanceCode = symbol(distances);
      if (distanceCode > 29) invalid();
      const extra = Math.max(0, (distanceCode >>> 1) - 1);
      const distance = distanceCode < 4 ? distanceCode + 1 : ((2 + (distanceCode & 1)) << extra) + 1 + read(extra);
      if (distance > output || distance > 2 ** ((cmf >>> 4) + 8)) invalid();
      output += length;
    }
  } while (!last);

  // Four Adler-32 bytes follow the padded final block.
  const end = Math.ceil(bit / 8) + 4;
  if (end > bytes.length) invalid();
  return end;
}
