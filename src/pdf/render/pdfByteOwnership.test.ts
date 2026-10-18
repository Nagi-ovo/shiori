import { describe, expect, test } from "bun:test";
import { retainPdfSourceBytes } from "./pdfByteOwnership";

describe("PDF load byte ownership", () => {
  test("retains a full-span caller buffer without a second whole-file copy", () => {
    const source = new Uint8Array([1, 2, 3, 4]);

    expect(retainPdfSourceBytes(source)).toBe(source);
  });

  test("normalizes a subarray instead of retaining its larger backing store", () => {
    const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
    const source = backing.subarray(1, 5);
    const retained = retainPdfSourceBytes(source);

    expect(retained).not.toBe(source);
    expect(retained).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(retained.byteOffset).toBe(0);
    expect(retained.buffer.byteLength).toBe(source.byteLength);
  });
});
