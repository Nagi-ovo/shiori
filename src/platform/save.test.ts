import { beforeAll, describe, expect, test } from "bun:test";

let encodeSuggestedNameHeader: typeof import("./save").encodeSuggestedNameHeader;
let parseAndroidBridgeResult: typeof import("./save").parseAndroidBridgeResult;

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __BUILD_TIMESTAMP__: { configurable: true, value: 0 },
    __BUILD_EXPIRY_DAYS__: { configurable: true, value: 0 },
  });
  ({ encodeSuggestedNameHeader, parseAndroidBridgeResult } = await import(
    "./save"
  ));
});

describe("encodeSuggestedNameHeader", () => {
  test("CJK filenames become ASCII-safe header values", () => {
    const encoded = encodeSuggestedNameHeader("栞 示例文档-2026年.pdf");
    // WebKit's Headers constructor rejects non-ISO-8859-1 values; base64
    // output stays within the safe alphabet.
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("round-trips UTF-8 through base64", () => {
    const name = "栞 — テスト 文件名.pdf";
    const encoded = encodeSuggestedNameHeader(name);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)),
    );
    expect(decoded).toBe(name);
  });
});

describe("parseAndroidBridgeResult", () => {
  test("turns malformed bridge output into a named export error", () => {
    expect(parseAndroidBridgeResult("not json")).toEqual({
      ok: false,
      message: "android-share-export-invalid-response",
    });
  });
});
