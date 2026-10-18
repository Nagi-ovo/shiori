import { describe, expect, spyOn, test } from "bun:test";
import { sha256Hex } from "./hash";

const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("SHA-256 source ownership", () => {
  test("hashes just the subarray without copying its ordinary backing buffer", async () => {
    const backing = new Uint8Array([0, 97, 98, 99, 0]);
    const bytes = backing.subarray(1, 4);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let supplied: BufferSource | undefined;
    const probe = spyOn(crypto.subtle, "digest").mockImplementation((algorithm, input) => {
      supplied = input;
      return digest(algorithm, input);
    });
    try {
      expect(await sha256Hex(bytes)).toBe(abcHash);
      expect(ArrayBuffer.isView(supplied)).toBe(true);
      expect((supplied as ArrayBufferView).buffer).toBe(backing.buffer);
      expect(backing).toEqual(new Uint8Array([0, 97, 98, 99, 0]));
    } finally {
      probe.mockRestore();
    }
  });

  test("WebCrypto snapshots the input before the caller can mutate it", async () => {
    const bytes = new TextEncoder().encode("abc");
    const pending = sha256Hex(bytes);
    bytes.fill(0);
    expect(await pending).toBe(abcHash);
  });

  test("accepts shared buffers through a private copy and respects byte offsets", async () => {
    const backing = new Uint8Array(new SharedArrayBuffer(5));
    backing.set([0, 97, 98, 99, 0]);
    expect(await sha256Hex(backing.subarray(1, 4))).toBe(abcHash);
  });

  test("hashes empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
