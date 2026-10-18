import { beforeAll, describe, expect, test } from "bun:test";

let encodeEmbeddedTerminalBinary: typeof import("./embeddedTerminal").encodeEmbeddedTerminalBinary;
let normalizeEmbeddedTerminalSize: typeof import("./embeddedTerminal").normalizeEmbeddedTerminalSize;

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __BUILD_TIMESTAMP__: { configurable: true, value: 0 },
    __BUILD_EXPIRY_DAYS__: { configurable: true, value: 0 },
  });
  ({ encodeEmbeddedTerminalBinary, normalizeEmbeddedTerminalSize } =
    await import("./embeddedTerminal"));
});

describe("embedded terminal IPC", () => {
  test("encodes every onBinary byte without UTF-8 reinterpretation", () => {
    const encoded = encodeEmbeddedTerminalBinary("\x00\x1b\x80\xff");
    const decoded = atob(encoded);
    expect(Array.from(decoded, (char) => char.charCodeAt(0))).toEqual([
      0x00, 0x1b, 0x80, 0xff,
    ]);
  });

  test("rejects non-byte input instead of silently truncating it", () => {
    expect(() => encodeEmbeddedTerminalBinary("\u0100")).toThrow(
      "terminal-binary-byte-out-of-range",
    );
  });

  test("normalizes sizes to the backend PTY contract", () => {
    expect(normalizeEmbeddedTerminalSize(1.9, 0)).toEqual({ cols: 2, rows: 2 });
    expect(normalizeEmbeddedTerminalSize(120.8, 44.9)).toEqual({
      cols: 120,
      rows: 44,
    });
    expect(normalizeEmbeddedTerminalSize(999, 999)).toEqual({
      cols: 400,
      rows: 200,
    });
  });
});
