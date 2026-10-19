import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * shiori-core, Shiori's Rust/PDFium reader, as the CLI loads it: a Node addon
 * (crates/shiori-core-node) beside the PDFium library it binds. The packaged
 * CLI ships it in `native/` and reads and renders with it; a run from source
 * uses pdf.js unless SHIORI_PDF_ENGINE=pdfium (docs/PLAN-RUST-PDF-CORE-2026-09.md,
 * stage 5). SHIORI_PDF_ENGINE=pdfjs opts a packaged CLI out.
 */

export type PdfEngineName = "pdfjs" | "pdfium";

export type CoreGlyph = {
  text: string;
  /** [x, y] of the baseline start, PDF user space. */
  origin: [number, number];
  /** [x, y] of the advance end. */
  end: [number, number];
  /** [left, bottom, right, top]: advance box united with ink. */
  loose: [number, number, number, number];
  fontSize: number;
  angle: number;
  generated: boolean;
  hyphen: boolean;
  fontName: string;
  /** PDF font descriptor flags (1 fixed pitch, 2 serif, 64 italic, …). */
  fontFlags: number;
  /** Page units at this glyph's size; descent is negative. */
  ascent: number;
  descent: number;
};

export type CorePageGeometry = {
  rotation: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
};

/** A link annotation's /Rect and where it goes: a page of this document or a URL. */
export type CoreLink = {
  /** [left, bottom, right, top], PDF user space. */
  rect: [number, number, number, number];
  destination?: {
    pageIndex: number;
    /** The fit name: `XYZ`, `Fit`, `FitH`, … */
    view: string;
    /** Its operands in order; null for one the file leaves null. */
    args: Array<number | null>;
  };
  url?: string;
};

/**
 * The document information, keyed as pdf.js's `documentInfo`: /Info strings
 * as written (dates unparsed, no XMP), the version, /Lang and the encryption
 * handler. A key is absent when the file has no value for it.
 */
export type CoreMetadata = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
  pdfFormatVersion?: string;
  language?: string;
  encryptFilterName?: string;
};

export type CoreDocument = {
  pageCount(): number;
  pageGeometry(index: number): CorePageGeometry;
  /** The page's glyphs; throws "page text too large" past shiori-core's MAX_PAGE_CHARS. */
  glyphs(index: number): CoreGlyph[];
  links(index: number): CoreLink[];
  metadata(): CoreMetadata;
  /** RGBA rows of a region of the page, `width × height × 4` bytes. */
  render(
    index: number,
    rotation: number,
    pixelsPerPoint: number,
    x: number,
    y: number,
    width: number,
    height: number,
    annotations?: boolean,
  ): Uint8Array;
  /** The document rewritten without its encryption, objects kept. */
  decryptedCopy(): Uint8Array;
  /** What the document's encryption allows; `revision` is absent when it has none. */
  security(): { revision?: number | null; permissions: number; userPermissions: number };
  /** An unencrypted export of this document, encrypted with its own handler and key. */
  encryptLikeSource(plain: Uint8Array): Uint8Array;
  close(): void;
};

type CoreAddon = {
  CoreDocument: {
    open(libraryDir: string, bytes: Uint8Array, password?: string): CoreDocument;
  };
};

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function pdfEngineFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = corePackaged(),
): PdfEngineName {
  const chosen = env.SHIORI_PDF_ENGINE?.trim().toLowerCase();
  if (chosen === "pdfium" || chosen === "pdfjs") return chosen;
  return packaged ? "pdfium" : "pdfjs";
}

/** Whether the core ships beside the executable (or SHIORI_CORE_DIR names one). */
export function corePackaged(): boolean {
  return resolveCoreFiles().packaged;
}

/** Where the addon and PDFium live: packaged beside the executable, or built in the repo. */
export function resolveCoreFiles(): { addon: string; pdfiumDir: string; packaged: boolean } {
  const override = process.env.SHIORI_CORE_DIR?.trim();
  const packaged = override ? resolve(override) : join(dirname(process.execPath), "native");
  const packagedAddon = join(packaged, "shiori_core.node");
  if (existsSync(packagedAddon)) return { addon: packagedAddon, pdfiumDir: packaged, packaged: true };

  const library =
    platform() === "win32"
      ? "shiori_core_node.dll"
      : platform() === "darwin"
        ? "libshiori_core_node.dylib"
        : "libshiori_core_node.so";
  const os = { darwin: "mac", linux: "linux", win32: "win" }[platform() as string] ?? platform();
  const cpu = arch() === "arm64" ? "arm64" : "x64";
  return {
    addon: join(SOURCE_ROOT, "crates", "shiori-core-node", "target", "release", library),
    pdfiumDir: join(
      SOURCE_ROOT,
      "vendor",
      "pdfium",
      `${os}-${cpu}`,
      platform() === "win32" ? "bin" : "lib",
    ),
    packaged: false,
  };
}

let addon: CoreAddon | null = null;

function loadAddon(path: string): CoreAddon {
  if (addon) return addon;
  if (!existsSync(path)) {
    throw new Error(
      `shiori-core addon not found at ${path}; build crates/shiori-core-node or set SHIORI_CORE_DIR`,
    );
  }
  // process.dlopen takes any file name; require() would insist on ".node".
  const module = { exports: {} as CoreAddon };
  process.dlopen(module, path);
  addon = module.exports;
  return addon;
}

/** Opens `bytes` with shiori-core. Errors carry the core's wording, which classifyPdfOpenError reads. */
export function openCoreDocument(bytes: Uint8Array, password?: string): CoreDocument {
  const files = resolveCoreFiles();
  return loadAddon(files.addon).CoreDocument.open(files.pdfiumDir, bytes, password);
}
