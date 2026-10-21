import "../../test/setupDom";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createPdfiumEngine, type PdfCoreBridge } from "./pdfiumEngine";

// The core bridge, as a fake handed to the factory (as in pdfiumEngine.test.ts):
// what the engine asks the core for a page's fonts, and what it makes of them.
const helloText = async () => ({
  glyphs: [..."Hi"].map((text, i) => ({
    text,
    origin: [72 + 6 * i, 700] as [number, number],
    end: [78 + 6 * i, 700] as [number, number],
    fontSize: 12,
    angle: 0,
    generated: false,
    fontName: "Helvetica",
    fontFlags: 32,
    ascent: 9,
    descent: -3,
  })),
  lang: "ja-JP" as string | null,
});

const core = {
  open: mock(async (): Promise<number> => 7),
  pageGeometry: mock(async () =>
    Array.from({ length: 5 }, () => ({ rotation: 0, originX: 0, originY: 0, width: 300, height: 400 })),
  ),
  close: mock(() => undefined),
  security: mock(async () => ({ revision: null, permissions: 0xffffffff, userPermissions: 0xffffffff })),
  pageFonts: mock((async () => new Uint8Array()) as (doc: number, page: number) => Promise<Uint8Array>),
  fontOutlines: mock((async () => new Uint8Array()) as (doc: number, page: number, names: string[]) => Promise<Uint8Array>),
  pageText: mock(helloText),
};
/** The arguments of one recorded call. */
const args = (fn: { mock: { calls: unknown[][] } }, call = 0) => fn.mock.calls[call] as unknown[];

const engine = createPdfiumEngine(core as unknown as PdfCoreBridge);

beforeEach(() => {
  for (const fn of Object.values(core)) fn.mockClear();
  core.pageText.mockImplementation(helloText);
});

describe("pdfiumEngine fonts", () => {
  test("a page's embedded fonts become faces its text styles use, fetched once per font", async () => {
    const added: string[] = [];
    const previousFontFace = (globalThis as { FontFace?: unknown }).FontFace;
    const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    (globalThis as { FontFace?: unknown }).FontFace = class {
      constructor(readonly family: string) {}
      load() {
        return Promise.resolve(this);
      }
    };
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: (face: { family: string }) => added.push(face.family) },
    });
    try {
      core.pageFonts.mockImplementation(async () => packFonts([{ name: "Helvetica", format: "truetype", data: [0, 1, 0, 0, 7] }]));
      const { doc } = await engine.load(new Uint8Array([7]), {});
      // A read for find or Live only wants words.
      await engine.pageText(doc, 2, { textOnly: true });
      expect(core.pageFonts).not.toHaveBeenCalled();
      const first = await engine.pageText(doc, 0);
      const family = first.faceFamilies.get("f0");
      expect(family).toMatch(/^shiori-pdf-/);
      expect(added).toEqual([family]);
      // The same font on another page: nothing fetched again.
      const second = await engine.pageText(doc, 1);
      expect(second.faceFamilies.get("f0")).toBe(family);
      expect(core.pageFonts).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { FontFace?: unknown }).FontFace = previousFontFace;
      if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
      else delete (document as { fonts?: unknown }).fonts;
    }
  });

  test("a font the browser cannot load is rebuilt from the characters each page adds", async () => {
    const faces: Array<{ family: string; unicodeRange?: string }> = [];
    const removed: unknown[] = [];
    const previousFontFace = (globalThis as { FontFace?: unknown }).FontFace;
    const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    (globalThis as { FontFace?: unknown }).FontFace = class {
      constructor(
        readonly family: string,
        readonly data: ArrayBuffer,
        readonly descriptors?: { unicodeRange?: string },
      ) {}
      load() {
        return Promise.resolve(this);
      }
    };
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: { family: string; descriptors?: { unicodeRange?: string } }) =>
          faces.push({ family: face.family, unicodeRange: face.descriptors?.unicodeRange }),
        delete: (face: unknown) => removed.push(face),
      },
    });
    // Pages 0 and 1 set "Hi" in a bare CFF font, page 2 "Ho".
    const pageWords = ["Hi", "Hi", "Ho"];
    core.pageText.mockImplementation((async (_doc: number, page: number) => ({
      glyphs: [...pageWords[page]!].map((text, i) => ({
        text,
        origin: [72 + 6 * i, 700] as [number, number],
        end: [78 + 6 * i, 700] as [number, number],
        fontSize: 12,
        angle: 0,
        generated: false,
        fontName: "CMR10",
        fontFlags: 32,
        ascent: 9,
        descent: -3,
      })),
      lang: null,
    })) as unknown as typeof core.pageText);
    core.pageFonts.mockImplementation(async () => packFonts([{ name: "CMR10", format: "cff", data: [1, 0, 4, 2] }]));
    const square = "M0 0L500 0L500 700L0 700Z";
    core.fontOutlines.mockImplementation(async (_doc, page) =>
      new TextEncoder().encode(
        JSON.stringify([
          {
            name: "CMR10",
            flags: 32,
            ascent: 700,
            descent: -200,
            glyphs: [...pageWords[page]!].map((ch) => [ch.codePointAt(0), 500, square]),
          },
        ]),
      ),
    );
    try {
      const { doc } = await engine.load(new Uint8Array([7]), {});
      const first = await engine.pageText(doc, 0);
      const family = first.faceFamilies.get("f0");
      expect(family).toMatch(/^shiori-pdf-/);
      expect(args(core.fontOutlines)[2]).toEqual(["CMR10"]);
      // One face for the page's characters, and no more than them.
      expect(faces).toEqual([{ family: family!, unicodeRange: "U+48,U+69" }]);
      // The same characters on another page: nothing to rebuild.
      expect((await engine.pageText(doc, 1)).faceFamilies.get("f0")).toBe(family);
      expect(core.fontOutlines).toHaveBeenCalledTimes(1);
      // A page with a new character adds a face to the same family for it alone.
      expect((await engine.pageText(doc, 2)).faceFamilies.get("f0")).toBe(family);
      expect(core.fontOutlines).toHaveBeenCalledTimes(2);
      expect(faces[1]).toEqual({ family: family!, unicodeRange: "U+6F" });
      expect(core.pageFonts).toHaveBeenCalledTimes(1);
      // Closing the document takes its faces away.
      await engine.destroy(doc);
      expect(removed).toHaveLength(2);
    } finally {
      (globalThis as { FontFace?: unknown }).FontFace = previousFontFace;
      if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
      else delete (document as { fonts?: unknown }).fonts;
    }
  });

  // Two papers merged into one file, each embedding its own subset of the
  // same font (audit B108): page 0 sets "Hi" in one Calibri, page 1 "Ho" in
  // the other. PDFium names both "Calibri"; the core tells them apart by id.
  const twoSubsets = (fontName: string) =>
    (async (_doc: number, page: number) => ({
      glyphs: [...["Hi", "Ho"][page]!].map((text, i) => ({
        text,
        origin: [72 + 6 * i, 700] as [number, number],
        end: [78 + 6 * i, 700] as [number, number],
        fontSize: 12,
        angle: 0,
        generated: false,
        fontName,
        fontId: ["1a", "2b"][page],
        fontFlags: 32,
        ascent: 9,
        descent: -3,
      })),
      lang: null,
    })) as unknown as typeof core.pageText;

  test("two programs under one font name each get their own face", async () => {
    await withFontStubs(async (added) => {
      core.pageText.mockImplementation(twoSubsets("Calibri"));
      core.pageFonts.mockImplementation(async (_doc: number, page: number) =>
        packFonts([{ name: "Calibri", id: ["1a", "2b"][page], format: "truetype", data: [0, 1, 0, 0, 40 + page] }]),
      );
      const { doc } = await engine.load(new Uint8Array([7]), {});
      const first = await engine.pageText(doc, 0);
      const second = await engine.pageText(doc, 1);
      const families = [first.faceFamilies.get("f0"), second.faceFamilies.get("f0")];
      expect(families[0]).toMatch(/^shiori-pdf-/);
      expect(families[1]).toMatch(/^shiori-pdf-/);
      expect(families[1]).not.toBe(families[0]);
      expect(added).toEqual(families);
      // What edit boxes and their glyph warnings are keyed by differs too.
      expect(second.fontNames.get("f0")).not.toBe(first.fontNames.get("f0"));
    });
  });

  test("two rebuilt programs under one font name keep their own glyphs", async () => {
    await withFontStubs(async (added) => {
      core.pageText.mockImplementation(twoSubsets("CMR10"));
      core.pageFonts.mockImplementation(async (_doc: number, page: number) =>
        packFonts([{ name: "CMR10", id: ["1a", "2b"][page], format: "cff", data: [1, 0, 4, 2] }]),
      );
      core.fontOutlines.mockImplementation(async (_doc, page) =>
        new TextEncoder().encode(
          JSON.stringify([
            {
              name: "CMR10",
              id: ["1a", "2b"][page],
              flags: 32,
              ascent: 700,
              descent: -200,
              glyphs: [...["Hi", "Ho"][page]!].map((ch) => [ch.codePointAt(0), 500, "M0 0L500 0L500 700Z"]),
            },
          ]),
        ),
      );
      const { doc } = await engine.load(new Uint8Array([7]), {});
      const first = (await engine.pageText(doc, 0)).faceFamilies.get("f0");
      const second = (await engine.pageText(doc, 1)).faceFamilies.get("f0");
      expect(second).not.toBe(first);
      // The second program draws its own H, not the first one's.
      expect(added).toEqual([`${first} U+48,U+69`, `${second} U+48,U+6F`]);
      expect(core.fontOutlines).toHaveBeenCalledTimes(2);
    });
  });

  test("a dictionary its program's own cmap does not draw is rebuilt, not loaded as it is", async () => {
    // Two dictionaries share one TrueType program (audit B108): "1a" draws
    // "a" as the program's cmap does, "2b" draws its A as "a", as a small-caps
    // encoding would. Loaded as it is, the program would edit 2b's "a" as a.
    const runs = [["a", "1a"], ["a", "2b"]] as const;
    await withFontStubs(async (added) => {
      core.pageText.mockImplementation((async () => ({
        glyphs: runs.map(([text, fontId], run) => ({
          text,
          origin: [72, 700 - 20 * run] as [number, number],
          end: [78, 700 - 20 * run] as [number, number],
          fontSize: 12,
          angle: 0,
          generated: false,
          fontName: "LiberationSans",
          fontId,
          fontFlags: 32,
          ascent: 9,
          descent: -3,
        })),
        lang: null,
      })) as unknown as typeof core.pageText);
      core.pageFonts.mockImplementation(async () =>
        packFonts(
          runs.map(([, id]) => ({ name: "LiberationSans", id, format: "truetype", ownCmap: id === "1a", data: [0, 1, 0, 0, 9] })),
        ),
      );
      core.fontOutlines.mockImplementation(async () =>
        new TextEncoder().encode(
          JSON.stringify(
            runs.map(([text, id]) => ({
              name: "LiberationSans",
              id,
              flags: 32,
              ascent: 700,
              descent: -200,
              glyphs: [[text.codePointAt(0), 667, "M0 0L667 0L333 700Z"]],
            })),
          ),
        ),
      );
      const { doc } = await engine.load(new Uint8Array([7]), {});
      const text = await engine.pageText(doc, 0);
      const familyOf = (id: string) => {
        const style = [...text.fontNames].find(([, key]) => key.endsWith(`#${id}`))![0];
        return text.faceFamilies.get(style);
      };
      const [loaded, rebuilt] = [familyOf("1a"), familyOf("2b")];
      expect(loaded).toMatch(/^shiori-pdf-/);
      expect(rebuilt).toMatch(/^shiori-pdf-/);
      expect(rebuilt).not.toBe(loaded);
      // 1a's program as it is; 2b's "a" from the glyph PDFium draws for it.
      expect(added).toEqual([loaded!, `${rebuilt} U+61`]);
    });
  });

  test("a rebuilt font seen before keeps its family on a page beside a new one", async () => {
    // Page 0 sets "Hi" in one CMR10; page 1 sets "Ho" in it and "x" in a
    // second CMR10 program, the usual later page of a merged LaTeX file.
    const runs = [[["Hi", "1a"]], [["Ho", "1a"], ["x", "2b"]]] as const;
    await withFontStubs(async (added) => {
      core.pageText.mockImplementation((async (_doc: number, page: number) => ({
        glyphs: runs[page]!.flatMap(([word, fontId], run) =>
          [...word].map((text, i) => ({
            text,
            origin: [72 + 6 * i, 700 - 20 * run] as [number, number],
            end: [78 + 6 * i, 700 - 20 * run] as [number, number],
            fontSize: 12,
            angle: 0,
            generated: false,
            fontName: "CMR10",
            fontId,
            fontFlags: 32,
            ascent: 9,
            descent: -3,
          })),
        ),
        lang: null,
      })) as unknown as typeof core.pageText);
      core.pageFonts.mockImplementation(async (_doc: number, page: number) =>
        packFonts(runs[page]!.map(([, id]) => ({ name: "CMR10", id, format: "cff", data: [1, 0, 4, 2] }))),
      );
      core.fontOutlines.mockImplementation(async (_doc, page) =>
        new TextEncoder().encode(
          JSON.stringify(
            runs[page]!.map(([word, id]) => ({
              name: "CMR10",
              id,
              flags: 32,
              ascent: 700,
              descent: -200,
              glyphs: [...word].map((ch) => [ch.codePointAt(0), 500, "M0 0L500 0L500 700Z"]),
            })),
          ),
        ),
      );
      const familyOf = (text: Awaited<ReturnType<typeof engine.pageText>>, id: string) => {
        const style = [...text.fontNames].find(([, key]) => key.endsWith(`#${id}`))![0];
        return text.faceFamilies.get(style);
      };
      const { doc } = await engine.load(new Uint8Array([7]), {});
      const first = familyOf(await engine.pageText(doc, 0), "1a");
      const page1 = await engine.pageText(doc, 1);
      expect(familyOf(page1, "1a")).toBe(first);
      const other = familyOf(page1, "2b");
      expect(other).toMatch(/^shiori-pdf-/);
      expect(other).not.toBe(first);
      // The seen font gains its new character alone; its H stays loaded.
      expect(added).toEqual([`${first} U+48,U+69`, `${first} U+6F`, `${other} U+78`]);
    });
  });
});

/**
 * Runs `body` with FontFace and document.fonts stubbed; `added` lists each
 * face added, as its family and any unicode-range.
 */
async function withFontStubs(body: (added: string[]) => Promise<void>): Promise<void> {
  const added: string[] = [];
  const previousFontFace = (globalThis as { FontFace?: unknown }).FontFace;
  const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  (globalThis as { FontFace?: unknown }).FontFace = class {
    constructor(
      readonly family: string,
      readonly data: unknown,
      readonly descriptors?: { unicodeRange?: string },
    ) {}
    load() {
      return Promise.resolve(this);
    }
  };
  type Face = { family: string; descriptors?: { unicodeRange?: string } };
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: (face: Face) =>
        added.push([face.family, face.descriptors?.unicodeRange].filter(Boolean).join(" ")),
      delete: () => true,
    },
  });
  try {
    await body(added);
  } finally {
    (globalThis as { FontFace?: unknown }).FontFace = previousFontFace;
    if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
    else delete (document as { fonts?: unknown }).fonts;
  }
}

/** shiori-core's font container: u32 length, a JSON listing, the programs. */
function packFonts(
  fonts: Array<{ name: string; id?: string; format: string; ownCmap?: boolean; data: number[] }>,
): Uint8Array {
  const header = new TextEncoder().encode(
    JSON.stringify(
      fonts.map(({ name, id, format, ownCmap = true, data }) => ({ name, id, flags: 32, format, ownCmap, length: data.length })),
    ),
  );
  const out = new Uint8Array(4 + header.length + fonts.reduce((sum, font) => sum + font.data.length, 0));
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  let offset = 4 + header.length;
  for (const font of fonts) {
    out.set(font.data, offset);
    offset += font.data.length;
  }
  return out;
}
