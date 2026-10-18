import { beforeAll, describe, expect, test } from "bun:test";

let writeBackTarget: typeof import("./writeBack").writeBackTarget;
let CAPABILITIES: typeof import("./index").CAPABILITIES;

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __BUILD_TIMESTAMP__: { configurable: true, value: 0 },
    __BUILD_EXPIRY_DAYS__: { configurable: true, value: 0 },
  });
  ({ writeBackTarget } = await import("./writeBack"));
  ({ CAPABILITIES } = await import("./index"));
});

// The test environment has no Tauri globals, so CAPABILITIES.nativePaths is
// false — i.e. these run as the web build. Asserting that keeps the tests
// honest if the harness ever changes underneath them.
describe("writeBackTarget (web build)", () => {
  test("the suite really is running as the web build", () => {
    expect(CAPABILITIES.nativePaths).toBe(false);
  });

  test("claims a browser file handle", () => {
    expect(writeBackTarget({ type: "webFileHandle", id: "h1" })).toEqual({
      kind: "webFileHandle",
      id: "h1",
    });
  });

  // A workspace restored from a desktop session still carries absolute paths.
  // The web build cannot write to them, and pretending otherwise would send a
  // save into an IPC command that does not exist here.
  test("ignores a desktop path", () => {
    expect(writeBackTarget({ type: "path", path: "/tmp/notes.md" })).toBeNull();
  });

  test("has no target for cache-backed or unknown sources", () => {
    expect(writeBackTarget({ type: "cache" })).toBeNull();
    expect(writeBackTarget(undefined)).toBeNull();
  });

  test("rejects a handle source with no usable id", () => {
    expect(writeBackTarget({ type: "webFileHandle" })).toBeNull();
    expect(
      writeBackTarget({ type: "webFileHandle", id: "" } as never),
    ).toBeNull();
  });
});
