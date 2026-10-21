import "../test/setupDom";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";

let encodeSuggestedNameHeader: typeof import("./save").encodeSuggestedNameHeader;
let parseAndroidBridgeResult: typeof import("./save").parseAndroidBridgeResult;
let saveBytes: typeof import("./save").saveBytes;

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __BUILD_TIMESTAMP__: { configurable: true, value: 0 },
    __BUILD_EXPIRY_DAYS__: { configurable: true, value: 0 },
  });
  ({ encodeSuggestedNameHeader, parseAndroidBridgeResult, saveBytes } = await import(
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

describe("saveBytes (web build)", () => {
  // The browser fetches a download's blob after click() returns (Safari
  // fails it with a WebKitBlobResource error once the URL is revoked), so the
  // URL must outlive the call that started the download.
  test("keeps the download's blob URL alive after the save returns", async () => {
    const revoked: string[] = [];
    const later: (() => void)[] = [];
    const create = spyOn(URL, "createObjectURL").mockImplementation(() => "blob:shiori/1");
    const revoke = spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void) => {
      later.push(run);
      return 0;
    }) as never);
    try {
      const result = await saveBytes(new Uint8Array([1, 2]), { suggestedName: "a.pdf" });

      expect(result).toEqual({ status: "saved", path: "a.pdf", platform: "web" });
      expect(revoked).toEqual([]);
      later.forEach((run) => run());
      expect(revoked).toEqual(["blob:shiori/1"]);
    } finally {
      create.mockRestore();
      revoke.mockRestore();
      timer.mockRestore();
    }
  });
});
