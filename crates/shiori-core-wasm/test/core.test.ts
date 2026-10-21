// Run by `bun run test:core` after scripts/pdfium/build-wasm.ts.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { openCoreDocument } from "../../../cli/src/coreEngine";
import { decodeEmbeddedFonts } from "../../../src/pdf/engine/fontContainer";
import { fontKey } from "../../../src/pdf/engine/fontKey";
import { buildOutlineFont, decodeFontOutlines } from "../../../src/pdf/engine/fontOutlines";
import { pageTextFromPdfiumGlyphs, type PdfiumGlyph } from "../../../src/pdf/engine/pdfiumText";
import { loadWasmCore, type WasmCore } from "../../../src/pdf/engine/wasm/loadCore";

const ROOT = join(import.meta.dir, "../../..");
const GENERATED = join(ROOT, "src/pdf/engine/wasm/generated");
const FIXTURE = readFileSync(join(ROOT, "crates/shiori-core/tests/fixtures/text.pdf"));
let wasm: WasmCore;
/** PDFium's heap, caught as its module instantiates. */
let pdfiumMemory: WebAssembly.Memory | undefined;

beforeAll(async () => {
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = (async (...args: Parameters<typeof instantiate>) => {
    const result = await instantiate(...args);
    const { exports } = result instanceof WebAssembly.Instance ? result : result.instance;
    if ("FPDF_LoadMemDocument64" in exports && exports.memory instanceof WebAssembly.Memory) pdfiumMemory = exports.memory;
    return result;
  }) as typeof instantiate;
  try {
    wasm = await loadWasmCore({
      pdfium: readFileSync(join(GENERATED, "pdfium.wasm")),
      core: readFileSync(join(GENERATED, "shiori_core_wasm_bg.wasm")),
      fonts: [{ file: "NotoSansSC-Regular.otf", bytes: readFileSync(join(ROOT, "src/assets/fonts/NotoSansSC-Regular.otf")) }],
      require: createRequire(import.meta.url),
    });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
});

describe("shiori-core in wasm", () => {
  test("reads every page as the native core does", () => {
    const fromWasm = wasm.CoreDocument.open(FIXTURE, undefined);
    const native = openCoreDocument(FIXTURE);
    try {
      expect(fromWasm.pageCount()).toBe(native.pageCount());
      let hyphens = 0;
      for (let index = 0; index < native.pageCount(); index += 1) {
        const glyphs = JSON.parse(fromWasm.pageText(index)).glyphs as Array<{ text: string; origin: number[]; end: number[]; hyphen?: boolean }>;
        const expected = native.glyphs(index);
        expect(glyphs.map((g) => g.text)).toEqual(expected.map((g) => g.text));
        // The reading layer ends a line at a hyphen PDFium flags, which is
        // how find and anchors rejoin a word hyphenated across lines.
        expect(glyphs.map((g) => g.hyphen)).toEqual(expected.map((g) => g.hyphen));
        hyphens += expected.filter((g) => g.hyphen).length;
        glyphs.forEach((g, i) => {
          for (const k of [0, 1]) {
            expect(Math.abs(g.origin[k]! - expected[i]!.origin[k]!)).toBeLessThan(1e-3);
            expect(Math.abs(g.end[k]! - expected[i]!.end[k]!)).toBeLessThan(1e-3);
          }
        });
      }
      expect(hyphens).toBeGreaterThan(0);
      expect(JSON.parse(fromWasm.outline())).toHaveLength(2);
    } finally {
      fromWasm.free();
      native.close();
    }
  });

  test("a failed open leaves no copy of the file in PDFium's heap", () => {
    // Every wrong password and every damaged file: pdfium-render copies the
    // bytes into PDFium's heap for each load, and only closing frees them.
    const damaged = new Uint8Array(8 << 20);
    damaged.set(Buffer.from("%PDF-1.7\n"));
    const heap = () => pdfiumMemory!.buffer.byteLength;
    expect(() => wasm.CoreDocument.open(damaged, undefined)).toThrow("damaged");
    const before = heap();
    for (let i = 0; i < 12; i += 1) {
      expect(() => wasm.CoreDocument.open(damaged, undefined)).toThrow("damaged");
    }
    expect(heap() - before).toBeLessThan(damaged.length);
  });

  test("draws a page with embedded fonts pixel for pixel as the native core does", async () => {
    // Fonts the file does not embed come from the system natively and from
    // PDFium's own set in wasm, so only embedded text can match exactly.
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(readFileSync(join(ROOT, "src/assets/fonts/NotoSansJP-Regular.otf")), { subset: true });
    const page = pdf.addPage([240, 160]);
    page.drawText("Shiori 栞 しおり", { x: 12, y: 100, size: 24, font });
    page.drawRectangle({ x: 12, y: 20, width: 80, height: 40, borderWidth: 3, opacity: 0.5 });
    const bytes = await pdf.save();
    const fromWasm = wasm.CoreDocument.open(bytes, undefined);
    const native = openCoreDocument(bytes);
    try {
      for (const scale of [1, 2.5]) {
        const args = [0, 0, scale, 0, 0, Math.floor(240 * scale), Math.floor(160 * scale)] as const;
        expect(Buffer.from(fromWasm.render(...args)).equals(Buffer.from(native.render(...args)))).toBe(true);
      }
    } finally {
      fromWasm.free();
      native.close();
    }
  });

  test("draws text in a font the file does not embed, from the font folder", async () => {
    // Chinese in STSong-Light, a CJK font PDFs name without embedding.
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 120]);
    const ctx = pdf.context;
    const font = ctx.register(ctx.obj({
      Type: "Font", Subtype: "Type0", BaseFont: "STSong-Light", Encoding: "UniGB-UCS2-H",
      DescendantFonts: [ctx.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "STSong-Light",
        CIDSystemInfo: { Registry: PDFHexString.fromText("Adobe"), Ordering: PDFHexString.fromText("GB1"), Supplement: 4 } })],
    }));
    page.node.setFontDictionary(PDFName.of("F1"), font);
    const hex = [..."中文批注"].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(`BT /F1 40 Tf 20 40 Td <${hex}> Tj ET`)));
    const doc = wasm.CoreDocument.open(await pdf.save(), undefined);
    try {
      const rgba = doc.render(0, 0, 1, 0, 0, 300, 120);
      let ink = 0;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! < 128) ink += 1;
      // Four 40 pt characters; without the font folder PDFium draws none.
      expect(ink).toBeGreaterThan(1000);
    } finally {
      doc.free();
    }
  });

  test("rewrites an encrypted document in the clear, byte for byte as the native core does", () => {
    const encrypted = readFileSync(join(ROOT, "crates/shiori-core/tests/fixtures/encrypted-notes.pdf"));
    const fromWasm = wasm.CoreDocument.open(encrypted, undefined);
    const native = openCoreDocument(encrypted);
    try {
      const copy = wasm.decryptedCopy(fromWasm);
      expect(Buffer.from(copy).includes("/Encrypt")).toBe(false);
      // Every byte alike but the /ID PDFium draws fresh for each save.
      const withoutId = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1").replace(/\/ID\[[^\]]*\]/, "");
      expect(withoutId(copy)).toBe(withoutId(native.decryptedCopy()));
    } finally {
      fromWasm.free();
      native.close();
    }
  });

  test("hands over a page's embedded fonts, packed and unpacked intact", () => {
    const doc = wasm.CoreDocument.open(readFileSync(join(ROOT, "crates/shiori-core/tests/fixtures/embedded-fonts.pdf")), undefined);
    try {
      const fonts = decodeEmbeddedFonts(doc.embeddedFonts(0));
      expect(fonts.map((font) => font.format)).toEqual(["truetype", "cff"]);
      // pdf-lib's TrueType subset drops the program's cmap and bare CFF
      // never loads as it is: both are rebuilt, not loaded (audit B108).
      expect(fonts.map((font) => font.ownCmap)).toEqual([false, false]);
      expect(fonts[0]!.name.startsWith("LiberationSans")).toBe(true);
      expect(Buffer.from(fonts[0]!.data.subarray(0, 4)).toString("latin1")).toBe("true");
      expect(Buffer.from(fonts[0]!.data).includes("glyf")).toBe(true);
    } finally {
      doc.free();
    }
  });

  test("tells two subsets under one name apart, in the glyphs and the programs alike", () => {
    // Two subsets of Liberation Sans, both "AAAAAA+LiberationSans", as the
    // first fonts of two merged word-processor exports are (audit B108).
    const doc = wasm.CoreDocument.open(readFileSync(join(ROOT, "crates/shiori-core/tests/fixtures/font-subsets.pdf")), undefined);
    try {
      const text = pageTextFromPdfiumGlyphs(JSON.parse(doc.pageText(0)).glyphs as PdfiumGlyph[], null);
      const keys = [...new Set(text.fontNames.values())];
      expect(keys).toHaveLength(2);
      // The faces the engine loads or rebuilds are found by the same keys.
      const programs = decodeEmbeddedFonts(doc.embeddedFonts(0));
      expect(programs.map((font) => fontKey(font.name, font.id))).toEqual(keys);
      const rebuilt = decodeFontOutlines(doc.fontOutlines(0, JSON.stringify([programs[0]!.name])));
      expect(rebuilt.map((font) => fontKey(font.name, font.id))).toEqual(keys);
    } finally {
      doc.free();
    }
  });

  test("rebuilds embedded fonts a browser refuses so they draw as PDFium draws them", async () => {
    // Bare CFF (as XeTeX and InDesign embed) and pdf-lib's TrueType subset,
    // rebuilt from PDFium's glyphs, then set at the runs' own positions in a
    // new PDF and drawn by the same PDFium: what can differ is the outlines,
    // advances and metrics of the rebuilt font, not the rasteriser.
    const doc = wasm.CoreDocument.open(readFileSync(join(ROOT, "crates/shiori-core/tests/fixtures/embedded-fonts.pdf")), undefined);
    try {
      const [liberation] = decodeEmbeddedFonts(doc.embeddedFonts(0));
      const runs = [
        { name: "FoxitSerif", text: "Top compact", x: 170, left: 330, right: 600 },
        { name: liberation!.name, text: "Liberation", x: 20, left: 30, right: 250 },
      ];
      const scale = 2;
      const [width, height] = [300 * scale, 200 * scale];
      const page = doc.render(0, 0, scale, 0, 0, width, height, true);
      const fonts = decodeFontOutlines(doc.fontOutlines(0, JSON.stringify(runs.map((run) => run.name))));
      for (const run of runs) {
        const font = fonts.find((f) => f.name === run.name)!;
        const pdf = await PDFDocument.create();
        pdf.registerFontkit(fontkit);
        const rebuilt = await pdf.embedFont(new Uint8Array(await buildOutlineFont(font)), { subset: false });
        // Both runs sit on the baseline 150 pt up a 200 pt page.
        pdf.addPage([300, 200]).drawText(run.text, { x: run.x, y: 150, size: 20, font: rebuilt });
        const redrawn = wasm.CoreDocument.open(await pdf.save(), undefined);
        let drawn: Uint8Array;
        try {
          drawn = redrawn.render(0, 0, scale, 0, 0, width, height, true);
        } finally {
          redrawn.free();
        }
        let ink = 0;
        let differing = 0;
        for (let y = 20; y < 130; y += 1) {
          for (let x = run.left; x < run.right; x += 1) {
            const i = (y * width + x) * 4;
            ink += Number(page[i]! < 128);
            differing += Number(page[i]! < 128 !== drawn[i]! < 128);
          }
        }
        // The rebuilt CFF loses the TrueType hinting (about 7% of the ink
        // for Liberation, nothing for Foxit Serif); the metric-compatible
        // Helvetica in Liberation's place differs by about 18%.
        expect(ink).toBeGreaterThan(1000);
        expect(differing / ink).toBeLessThan(0.12);
      }
    } finally {
      doc.free();
    }
  });

  // The wasm path reads security through PDFium's own exports, because
  // pdfium-render's wasm bridge saturates a /P with bit 32 set (every real
  // one) to 0; and it encrypts with the same shiori-core code built for wasm.
  test("reports an encrypted file's security and re-encrypts it as the native core does", () => {
    const ENCRYPTED = join(ROOT, "crates/shiori-core/tests/fixtures/encrypted");
    for (const [name, user] of [
      ["rc4-40", "user-pw"],
      ["aes-128-nometa", "user-pw"],
      ["restricted", "user-pw"],
      ["empty-user", ""],
      ["cjk-password", "密码パス"],
    ] as const) {
      const bytes = new Uint8Array(readFileSync(join(ENCRYPTED, `${name}.pdf`)));
      for (const password of [user, "owner-pw"]) {
        const fromWasm = wasm.CoreDocument.open(bytes, password);
        const native = openCoreDocument(bytes, password);
        try {
          const report = native.security();
          expect(wasm.security(fromWasm)).toEqual({
            revision: report.revision ?? null,
            permissions: report.permissions >>> 0,
            userPermissions: report.userPermissions >>> 0,
          });
          const encrypted = fromWasm.encryptLikeSource(wasm.decryptedCopy(fromWasm));
          for (const reopenWith of [user, "owner-pw"]) {
            const reopened = openCoreDocument(encrypted, reopenWith);
            try {
              expect(reopened.security().revision).toBe(report.revision);
              expect(reopened.pageCount()).toBe(2);
            } finally {
              reopened.close();
            }
          }
          expect(() => openCoreDocument(encrypted, "not-the-password")).toThrow("password");
        } finally {
          fromWasm.free();
          native.close();
        }
      }
    }
    const plain = wasm.CoreDocument.open(FIXTURE, undefined);
    try {
      expect(wasm.security(plain).revision).toBeNull();
      expect(() => plain.encryptLikeSource(wasm.decryptedCopy(plain))).toThrow("re-encryption unsupported");
    } finally {
      plain.free();
    }
  });
});
