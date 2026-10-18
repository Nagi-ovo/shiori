import { describe, expect, test } from "bun:test";
import {
  assertDocumentWithinFileLimit,
  assertSafeDocxPackage,
  DocumentOpenPolicyError,
  looksLikeDocxPackage,
  MAX_DOCX_BYTES,
  MAX_DOCX_UNCOMPRESSED_BYTES,
} from "./openPolicy";

describe("document open policy", () => {
  test("rejects an oversized DOCX before its bytes are read", () => {
    expect(() => assertDocumentWithinFileLimit("docx", MAX_DOCX_BYTES + 1)).toThrow(
      DocumentOpenPolicyError,
    );
  });

  test("accepts a bounded Word ZIP directory", () => {
    const bytes = centralDirectory([
      ["[Content_Types].xml", 120, 100],
      ["word/document.xml", 2_000, 1_000],
    ]);
    expect(() => assertSafeDocxPackage(bytes)).not.toThrow();
    expect(looksLikeDocxPackage(bytes)).toBe(true);
  });

  test("rejects a package whose declared expansion exceeds the budget", () => {
    const bytes = centralDirectory([
      ["[Content_Types].xml", 1, 1],
      ["word/document.xml", MAX_DOCX_UNCOMPRESSED_BYTES, 2_000_000],
      ["word/styles.xml", 1, 1],
    ]);
    expect(() => assertSafeDocxPackage(bytes)).toThrow(
      /expands to .* bytes/,
    );
  });

  test("accepts a highly compressible Word XML part within the total budget", () => {
    const bytes = centralDirectory([
      ["[Content_Types].xml", 1, 1],
      // Ordinary repeated paragraphs and empty tables can exceed 180:1 even
      // though their total inflated size is tiny and bounded by the package cap.
      ["word/document.xml", 181_000, 1_000],
    ]);
    expect(() => assertSafeDocxPackage(bytes)).not.toThrow();
    expect(looksLikeDocxPackage(bytes)).toBe(true);
  });

  test("does not identify an arbitrary ZIP as a Word document", () => {
    const bytes = centralDirectory([["notes.txt", 10, 10]]);
    expect(looksLikeDocxPackage(bytes)).toBe(false);
  });
});

function centralDirectory(
  entries: ReadonlyArray<readonly [name: string, size: number, compressed: number]>,
): Uint8Array {
  const encoder = new TextEncoder();
  const names = entries.map(([name]) => encoder.encode(name));
  const centralSize = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const bytes = new Uint8Array(centralSize + 22);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  entries.forEach(([, size, compressed], index) => {
    const name = names[index]!;
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 10, 8, true);
    view.setUint32(offset + 20, compressed, true);
    view.setUint32(offset + 24, size, true);
    view.setUint16(offset + 28, name.length, true);
    bytes.set(name, offset + 46);
    offset += 46 + name.length;
  });
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, 0, true);
  return bytes;
}
