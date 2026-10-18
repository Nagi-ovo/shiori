import "../../test/setupDom";
import {
  blankDocumentBytes,
  createDocxEditor,
} from "@docx-editor.dev/core";
import { afterEach, describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { loadShioriDocxFonts, scanDocxFontFamilies } from "./docxFonts";

Object.defineProperties(globalThis, {
  Node: { configurable: true, value: window.Node },
  Element: { configurable: true, value: window.Element },
  Range: { configurable: true, value: window.Range },
});

const CJK_TEXT =
  "这是一个用于验证中文字体测量和自动换行是否一致的真实段落。".repeat(8);

describe("Shiori DOCX fonts", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("measures a common Chinese Word face with the font used to paint it", async () => {
    const fontFaces = installFontFaceHarness();
    let editor: ReturnType<typeof createDocxEditor> | undefined;

    try {
      const container = document.createElement("div");
      document.body.append(container);
      const fonts = await loadShioriDocxFonts();
      const substitutions = fonts.substitutions ?? [];
      expect(
        substitutions.some(
          ({ from, to }) =>
            from.family === "Microsoft YaHei" &&
            to.family === "Noto Sans SC",
        ),
      ).toBe(true);
      expect(
        substitutions.some(
          ({ from, to }) =>
            from.family === "Meiryo" && to.family === "Noto Sans JP",
        ),
      ).toBe(true);
      expect(
        substitutions.some(({ from }) =>
          ["SimSun", "宋体", "MS Mincho"].includes(from.family),
        ),
      ).toBe(false);
      editor = createDocxEditor({
        container,
        document: chineseDocx("Microsoft YaHei"),
        fonts,
        mode: "view",
      });
      await waitForFontMeasurement(editor);
      expect(
        Array.from(container.querySelectorAll(".docx-line"), (line) =>
          (line.textContent ?? "").length,
        ),
      ).toEqual([42, 42, 42, 42, 42, 22]);
      expect(
        Array.from(
          container.querySelectorAll<HTMLElement>("[style]"),
          (node) => node.style.fontFamily,
        ).some(
          (family) =>
            family.startsWith("docx-embedded-") &&
            family.includes("Microsoft YaHei"),
        ),
      ).toBe(true);
    } finally {
      editor?.destroy();
      const releasedAliases = fontFaces.deleted.some((face) =>
        face.family.startsWith("docx-embedded-"),
      );
      fontFaces.restore();
      if (editor) expect(releasedAliases).toBe(true);
    }
  });
});

describe("Shiori DOCX font loading by what the file names", () => {
  test("reads run, style and theme font names straight from the package", () => {
    const families = scanDocxFontFamilies(chineseDocx("Microsoft YaHei"));
    expect(families.has("Microsoft YaHei")).toBe(true);
    // Word's blank template names Calibri in docDefaults; the theme names
    // its Latin typefaces too.
    expect(families.has("Calibri")).toBe(true);
    expect(scanDocxFontFamilies(new Uint8Array([1, 2, 3])).size).toBe(0);
  });

  test("loads the CJK face only for a document that names one of its aliases", async () => {
    const families = (fragment: Awaited<ReturnType<typeof loadShioriDocxFonts>>) =>
      new Set(fragment.sources?.map((source) => source.request.family));
    const substitutes = (
      fragment: Awaited<ReturnType<typeof loadShioriDocxFonts>>,
    ) => new Set(fragment.substitutions?.map(({ from }) => from.family));

    const latinOnly = await loadShioriDocxFonts({ families: ["Calibri"] });
    expect(families(latinOnly).has("Noto Sans SC")).toBe(false);
    expect(families(latinOnly).has("Noto Sans JP")).toBe(false);
    expect(families(latinOnly).has("Carlito")).toBe(true);
    // Every Word default used to load whatever the file said; Times is not
    // named here, so its substitute stays on disk.
    expect(families(latinOnly).has("Liberation Serif")).toBe(false);
    expect(substitutes(latinOnly).has("Microsoft YaHei")).toBe(false);

    const chinese = await loadShioriDocxFonts({
      families: ["calibri", "微软雅黑", "Times New Roman"],
    });
    expect(families(chinese).has("Noto Sans SC")).toBe(true);
    expect(families(chinese).has("Noto Sans JP")).toBe(false);
    expect(families(chinese).has("Liberation Serif")).toBe(true);
    expect(
      chinese.substitutions?.some(
        ({ from, to }) =>
          from.family === "微软雅黑" && to.family === "Noto Sans SC",
      ),
    ).toBe(true);
    expect(
      chinese.substitutions?.some(({ to }) => to.family === "Noto Sans JP"),
    ).toBe(false);
  });
});

function chineseDocx(family: string): Uint8Array {
  const files = unzipSync(blankDocumentBytes());
  const run = `<w:p><w:r><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}" w:eastAsia="${family}" w:cs="${family}"/></w:rPr><w:t>${CJK_TEXT}</w:t></w:r></w:p>`;
  const documentXml = strFromU8(files["word/document.xml"]);
  files["word/document.xml"] = strToU8(documentXml.replace("<w:p/>", run));
  return zipSync(files);
}

function installFontFaceHarness(): {
  deleted: TestFontFace[];
  restore: () => void;
} {
  const originalGlobal = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
  const originalWindow = Object.getOwnPropertyDescriptor(window, "FontFace");
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  const added: TestFontFace[] = [];
  const deleted: TestFontFace[] = [];
  const fontSet = {
    add: (face: TestFontFace) => {
      added.push(face);
      return fontSet;
    },
    delete: (face: TestFontFace) => {
      deleted.push(face);
      return true;
    },
    [Symbol.iterator]: () => added[Symbol.iterator](),
  };
  Object.defineProperty(globalThis, "FontFace", {
    configurable: true,
    value: TestFontFace,
  });
  Object.defineProperty(window, "FontFace", {
    configurable: true,
    value: TestFontFace,
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fontSet,
  });
  return {
    deleted,
    restore: () => {
      restoreProperty(globalThis, "FontFace", originalGlobal);
      restoreProperty(window, "FontFace", originalWindow);
      restoreProperty(document, "fonts", originalFonts);
    },
  };
}

class TestFontFace {
  readonly weight: string;
  readonly style: string;

  constructor(
    readonly family: string,
    _source: string | ArrayBuffer,
    descriptors: { weight?: string; style?: string } = {},
  ) {
    this.weight = descriptors.weight ?? "normal";
    this.style = descriptors.style ?? "normal";
  }

  async load(): Promise<this> {
    return this;
  }
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

async function waitForFontMeasurement(
  editor: ReturnType<typeof createDocxEditor>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!editor.fontMeasurement().resolving) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("DOCX font measurement did not settle");
}
