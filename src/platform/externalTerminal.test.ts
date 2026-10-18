import { beforeAll, describe, expect, test } from "bun:test";

let isExternalTerminalId: typeof import("./externalTerminal").isExternalTerminalId;
let normalizeExternalTerminalApps: typeof import("./externalTerminal").normalizeExternalTerminalApps;
let normalizeExternalTerminalIconDataUrl: typeof import("./externalTerminal").normalizeExternalTerminalIconDataUrl;
let normalizeExternalTerminalWorkingDirectory: typeof import("./externalTerminal").normalizeExternalTerminalWorkingDirectory;

const TEST_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __BUILD_TIMESTAMP__: { configurable: true, value: 0 },
    __BUILD_EXPIRY_DAYS__: { configurable: true, value: 0 },
  });
  ({
    isExternalTerminalId,
    normalizeExternalTerminalApps,
    normalizeExternalTerminalIconDataUrl,
    normalizeExternalTerminalWorkingDirectory,
  } = await import("./externalTerminal"));
});

describe("external terminal platform contract", () => {
  test("accepts only the fixed terminal id allowlist", () => {
    expect(isExternalTerminalId("ghostty")).toBe(true);
    expect(isExternalTerminalId("iterm2")).toBe(true);
    expect(isExternalTerminalId("wezterm")).toBe(true);
    expect(isExternalTerminalId("ghostty; rm -rf /")).toBe(false);
    expect(isExternalTerminalId("../../bin/zsh")).toBe(false);
  });

  test("drops malformed, duplicate, and unknown native payload entries", () => {
    expect(
      normalizeExternalTerminalApps([
        { id: "terminal", name: "Terminal" },
        { id: "terminal", name: "Duplicate" },
        { id: "ghostty", name: "Ghostty" },
        { id: "unknown", name: "Unknown" },
        { id: "wezterm", name: "" },
        null,
      ]),
    ).toEqual([
      { id: "terminal", name: "Terminal" },
      { id: "ghostty", name: "Ghostty" },
    ]);
  });

  test("keeps only bounded PNG icon data URLs without dropping the app", () => {
    expect(normalizeExternalTerminalIconDataUrl(TEST_PNG_DATA_URL)).toBe(
      TEST_PNG_DATA_URL,
    );
    expect(
      normalizeExternalTerminalIconDataUrl(
        "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      ),
    ).toBeNull();
    expect(
      normalizeExternalTerminalIconDataUrl("data:image/png;base64,not-a-png"),
    ).toBeNull();

    expect(
      normalizeExternalTerminalApps([
        { id: "terminal", name: "Terminal", iconDataUrl: TEST_PNG_DATA_URL },
        {
          id: "ghostty",
          name: "Ghostty",
          iconDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        },
      ]),
    ).toEqual([
      { id: "terminal", name: "Terminal", iconDataUrl: TEST_PNG_DATA_URL },
      { id: "ghostty", name: "Ghostty" },
    ]);
  });

  test("uses whitespace only as an empty check without changing a real path", () => {
    expect(normalizeExternalTerminalWorkingDirectory("   ")).toBeNull();
    expect(normalizeExternalTerminalWorkingDirectory(null)).toBeNull();
    expect(
      normalizeExternalTerminalWorkingDirectory("/tmp/项目 folder "),
    ).toBe("/tmp/项目 folder ");
  });
});
