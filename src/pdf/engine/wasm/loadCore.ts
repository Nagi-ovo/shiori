import createPdfiumModule from "./generated/pdfium.mjs";
import initCore, * as core from "./generated/shiori_core_wasm.js";

/**
 * Loads shiori-core in this thread (a worker in the app, the main thread in
 * tests): PDFium's Emscripten build, then the core, joined through
 * pdfium-render's `initialize_pdfium_render` (docs/PLAN-RUST-PDF-CORE-2026-09.md, 4.6).
 *
 * PDFium in wasm has no system fonts, so text in a font the PDF does not
 * embed has nothing to draw with. `fonts` go into PDFium's in-memory file
 * system as its font folder: as bytes, or, in a worker, as lazy files that
 * fetch only the ranges PDFium reads, so a document that never needs a CJK
 * fallback never downloads one.
 */

export type WasmCore = typeof core & {
  /**
   * The document rewritten without its encryption, objects kept
   * (shiori-core's `decrypted_copy`, which is native-only).
   */
  decryptedCopy(doc: core.CoreDocument): Uint8Array;
  /**
   * What the document's encryption allows. Read here, not in the core:
   * pdfium-render's wasm bridge saturates PDFium's unsigned results to 0.
   */
  security(doc: core.CoreDocument): { revision: number | null; permissions: number; userPermissions: number };
};

type Binary = Uint8Array | ArrayBuffer;

export type WasmCoreFont = { file: string } & ({ bytes: Binary } | { url: string });

export type WasmCoreAssets = {
  /** PDFium's wasm, as bytes or a URL. */
  pdfium: Binary | string;
  /** The core's wasm (shiori_core_wasm_bg.wasm), as bytes or a URL. */
  core: Binary | string;
  fonts?: readonly WasmCoreFont[];
  /** Only under Node, where the glue reads through `require`. */
  require?: unknown;
};

type PdfiumModule = Record<string, unknown> & {
  HEAPU8: Uint8Array;
  addFunction(fn: (...args: number[]) => number, signature: string): number;
  removeFunction(index: number): void;
  _free(ptr: number): void;
  _FPDF_SaveAsCopy(doc: number, writer: number, flags: number): number;
  _FPDF_GetSecurityHandlerRevision(doc: number): number;
  _FPDF_GetDocPermissions(doc: number): number;
  _FPDF_GetDocUserPermissions(doc: number): number;
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    createLazyFile(parent: string, name: string, url: string, read: boolean, write: boolean): void;
  };
  _malloc(size: number): number;
  _FPDF_InitLibraryWithConfig(config: number): void;
};

const FONT_DIR = "/fonts";

export async function loadWasmCore(assets: WasmCoreAssets): Promise<WasmCore> {
  const pdfium = await new Promise<PdfiumModule>((resolve, reject) => {
    const module: Record<string, unknown> = {
      onRuntimeInitialized: () => resolve(module as PdfiumModule),
      onAbort: (reason: unknown) => reject(new Error(`PDFium failed to load: ${String(reason)}`)),
    };
    if (typeof assets.pdfium === "string") {
      const url = assets.pdfium;
      module.locateFile = () => url;
    } else {
      module.wasmBinary = assets.pdfium;
    }
    createPdfiumModule(module, assets.require);
  });

  pdfium.FS.mkdir(FONT_DIR);
  for (const font of assets.fonts ?? []) {
    if ("bytes" in font) {
      pdfium.FS.writeFile(`${FONT_DIR}/${font.file}`, new Uint8Array(font.bytes));
    } else {
      pdfium.FS.createLazyFile(FONT_DIR, font.file, font.url, true, false);
    }
  }
  // pdfium-render initialises PDFium by calling `PDFium_Init` unless the
  // module has an (unprefixed) `FPDF_InitLibrary`; this build has neither.
  // Standing in for it, initialise with the font folder above.
  pdfium._PDFium_Init = () => pdfium._FPDF_InitLibraryWithConfig(libraryConfig(pdfium, FONT_DIR));

  const coreExports = await initCore({ module_or_path: assets.core });
  if (!core.initialize_pdfium_render(pdfium, coreExports, false)) {
    throw new Error("PDFium's module is missing what pdfium-render needs");
  }
  core.bindPdfium();
  return {
    ...core,
    decryptedCopy: (doc) => decryptedCopy(pdfium, doc.pdfiumHandle()),
    security: (doc) => {
      const handle = doc.pdfiumHandle();
      const revision = pdfium._FPDF_GetSecurityHandlerRevision(handle);
      // Emscripten hands an unsigned long back as a signed int32.
      return {
        revision: revision === -1 ? null : revision,
        permissions: pdfium._FPDF_GetDocPermissions(handle) >>> 0,
        userPermissions: pdfium._FPDF_GetDocUserPermissions(handle) >>> 0,
      };
    },
  };
}

// FPDF_NO_INCREMENTAL | FPDF_REMOVE_SECURITY (fpdf_save.h, 7881).
const SAVE_DECRYPTED = (1 << 1) | (1 << 2);

/** FPDF_SaveAsCopy into memory, with an FPDF_FILEWRITE whose callback is JS. */
function decryptedCopy(pdfium: PdfiumModule, handle: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  // int WriteBlock(FPDF_FILEWRITE* self, const void* data, unsigned long size)
  const writeBlock = pdfium.addFunction((_self, data, size) => {
    chunks.push(pdfium.HEAPU8.slice(data, data + size));
    return 1;
  }, "iiii");
  const writer = pdfium._malloc(8);
  try {
    const view = new DataView(pdfium.HEAPU8.buffer);
    view.setInt32(writer, 1, true);
    view.setUint32(writer + 4, writeBlock, true);
    if (!pdfium._FPDF_SaveAsCopy(handle, writer, SAVE_DECRYPTED)) {
      throw new Error("PDFium could not rewrite the document");
    }
  } finally {
    pdfium._free(writer);
    pdfium.removeFunction(writeBlock);
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** FPDF_LIBRARY_CONFIG version 2: one user font path, no V8 isolate. */
function libraryConfig(pdfium: PdfiumModule, fontDir: string): number {
  const path = new TextEncoder().encode(`${fontDir}/\0`);
  const pathPtr = pdfium._malloc(path.length);
  pdfium.HEAPU8.set(path, pathPtr);
  const paths = pdfium._malloc(8);
  new DataView(pdfium.HEAPU8.buffer).setUint32(paths, pathPtr, true);
  new DataView(pdfium.HEAPU8.buffer).setUint32(paths + 4, 0, true);
  const config = pdfium._malloc(24);
  const view = new DataView(pdfium.HEAPU8.buffer);
  [2, paths, 0, 0, 0, 0].forEach((value, i) => view.setUint32(config + i * 4, value, true));
  return config;
}
