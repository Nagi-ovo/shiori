import { beforeAll, describe, expect, test } from "bun:test";

let normalizeSystemFontFamilies: typeof import("./systemFonts").normalizeSystemFontFamilies;
let normalizeWebLocalFonts: typeof import("./systemFonts").normalizeWebLocalFonts;

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __BUILD_TIMESTAMP__: { configurable: true, value: 0 },
    __BUILD_EXPIRY_DAYS__: { configurable: true, value: 0 },
  });
  ({ normalizeSystemFontFamilies, normalizeWebLocalFonts } = await import(
    "./systemFonts"
  ));
});

describe("system font platform contract", () => {
  test("filters malformed native payloads and merges duplicate families", () => {
    expect(
      normalizeSystemFontFamilies([
        {
          family: "Cascadia Code",
          aliases: ["Cascadia Mono", "Cascadia Mono", "Bad\nAlias"],
          monospaced: false,
        },
        {
          family: "cascadia code",
          aliases: ["Cascadia"],
          monospaced: true,
        },
        { family: "", aliases: [], monospaced: false },
        { family: ".Private UI Font", aliases: [], monospaced: false },
        { family: "Beta Serif", aliases: "not-an-array", monospaced: false },
        null,
      ]),
    ).toEqual([
      { family: "Beta Serif", aliases: [], monospaced: false },
      {
        family: "Cascadia Code",
        aliases: ["Cascadia", "Cascadia Mono"],
        monospaced: true,
      },
    ]);
  });

  test("reads only family names from the browser font payload", () => {
    expect(
      normalizeWebLocalFonts([
        { family: "Avenir Next", fullName: "Avenir Next Bold", blob: "secret" },
        { family: "avenir next", postscriptName: "AvenirNext-Italic" },
        { fullName: "Missing family" },
      ]),
    ).toEqual([
      { family: "Avenir Next", aliases: [], monospaced: false },
    ]);
  });
});
