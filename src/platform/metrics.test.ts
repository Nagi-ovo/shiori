import { afterEach, beforeAll, describe, expect, test } from "bun:test";

let readGpuRendererInfo: typeof import("./metrics").readGpuRendererInfo;
beforeAll(async () => {
  Object.defineProperties(globalThis, {
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __BUILD_TIMESTAMP__: { configurable: true, value: 0 },
    __BUILD_EXPIRY_DAYS__: { configurable: true, value: 0 },
  });
  ({ readGpuRendererInfo } = await import("./metrics"));
});

const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
  else Reflect.deleteProperty(globalThis, "document");
});

function installGpuProbe(debug: boolean, fail = false) {
  let released = 0;
  const gl = {
    RENDERER: 1, VENDOR: 2,
    getExtension: (name: string) => name === "WEBGL_lose_context"
      ? { loseContext: () => { released++; } }
      : debug ? { UNMASKED_RENDERER_WEBGL: 1, UNMASKED_VENDOR_WEBGL: 2 } : null,
    getParameter: (key: number) => {
      if (fail) throw new Error("GPU probe failed");
      return key === 1 ? "Test GPU" : "Test vendor";
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ getContext: () => gl }) },
  });
  return () => released;
}

describe("GPU diagnostics resource lifetime", () => {
  for (const debug of [true, false]) {
    test(`releases each temporary context (debug extension: ${debug})`, () => {
      const releases = installGpuProbe(debug);
      for (let i = 0; i < 4; i++) {
        expect(readGpuRendererInfo()).toEqual({ renderer: "Test GPU", vendor: "Test vendor" });
      }
      expect(releases()).toBe(4);
    });
  }
  test("releases its context even when querying GPU details fails", () => {
    const releases = installGpuProbe(true, true);
    expect(() => readGpuRendererInfo()).toThrow("GPU probe failed");
    expect(releases()).toBe(1);
  });
});
