import type { PdfAnnotationImportOptions } from "../import/annotations";
import type { Overlay, PageModel, Rotation } from "../model/types";
import type { PdfPageTextContent, PdfTextGlyph } from "./text";

/** A page's text, the glyphs that draw it, and its fonts' real names. */
export type PdfPageText = {
  content: PdfPageTextContent;
  /** Null when the engine could not place glyphs (selection falls back to runs). */
  glyphs: PdfTextGlyph[] | null;
  /** `content.styles` key → the font's BaseFont name, where known. */
  fontNames: Map<string, string>;
  /**
   * `content.styles` key → the CSS family of the document's own font, for
   * the fonts the engine has loaded into `document.fonts` (edit boxes set
   * existing text in it). Empty when the engine loads none.
   */
  faceFamilies: Map<string, string>;
};

declare const pdfDocumentBrand: unique symbol;

/**
 * An open PDF, as the engine that opened it hands it out: an opaque handle
 * the app only passes back to that engine (docs/PLAN-RUST-PDF-CORE-2026-09.md,
 * 4.7c). Behind it is a shiori-core document.
 */
export type PdfDocument = { readonly [pdfDocumentBrand]: true };

/**
 * Where a link or outline entry goes: a page and a view of it, the PDF way.
 * `view` is the destination's fit name (`XYZ`, `Fit`, `FitH`, `FitV`, `FitR`,
 * `FitB`, `FitBH`, `FitBV`) and `args` its operands in order — the PDF
 * destination array after the page — with null where the file leaves one null.
 */
export type PdfDestination = {
  pageIndex: number;
  view: string;
  args: Array<number | null>;
};

export type PdfOutlineItem = {
  title: string;
  /** Null when the entry points nowhere this document can show. */
  destination: PdfDestination | null;
  children: PdfOutlineItem[];
};

export type PdfNamedAction = "FirstPage" | "LastPage" | "NextPage" | "PrevPage";

/** A link annotation: its /Rect in PDF user space and where it goes. */
export type PdfLink = {
  rect: [number, number, number, number];
  destination: PdfDestination | null;
  url: string | null;
  /** A named navigation action (PDF 32000 §12.6.4.11), relative to this page. */
  action?: PdfNamedAction;
};

/** One physical page's box in PDF user space, before any user rotation. */
export type PdfPageGeometry = {
  rotation: Rotation;
  originXPt: number;
  originYPt: number;
  widthPt: number;
  heightPt: number;
};

/**
 * What an encrypted document's Standard security handler allows. Bits are
 * PDF 32000 table 22's, bit 1 the lowest: 3 print, 4 modify, 6 annotate,
 * 11 assemble (src/pdf/security/permissions.ts reads them).
 */
export type PdfSecurity = {
  /** The handler's /R: 2–4 RC4 or AES-128, 5–6 AES-256. */
  revision: number;
  /** What this opening allows: every bit when the owner password opened it. */
  permissions: number;
  /** /P as the file writes it, whichever password opened it. */
  userPermissions: number;
};

/**
 * An encrypted PDF opened once more for an export that must stay encrypted
 * (src/pdf/export/encryptedSource.ts): its plaintext for pdf-lib, and the
 * way back under the file's own /Encrypt and key. The password reached the
 * engine when this opened and is kept nowhere after.
 */
export type EncryptedPdfSource = {
  security: PdfSecurity;
  /** The whole file in the clear, objects kept. */
  plaintext: () => Promise<Uint8Array>;
  /**
   * An unencrypted export of this file, encrypted as the file is, so its own
   * user and owner passwords open it. Rejects when the file's handler cannot
   * be reproduced (the message starts "re-encryption unsupported").
   */
  encrypt: (plain: Uint8Array) => Promise<Uint8Array>;
  /** Releases it. */
  close: () => void;
};

/**
 * What the app needs from a PDF engine: shiori-core implements it, natively
 * on desktop and as wasm on web and mobile (./pdfiumEngine.ts).
 */
export type PdfEngine = {
  /** What draws and reads, for diagnostics ("PDFium 7881", "PDFium 7881 wasm"). */
  label: string;
  /**
   * Parses `bytes`. The returned bytes are the caller's to keep (export,
   * password retry, cache); the engine never takes ownership of them.
   * Rejects with a password error for an encrypted file without the right
   * password (see classifyPdfOpenError).
   */
  load: (
    bytes: Uint8Array,
    options: { password?: string },
  ) => Promise<{ doc: PdfDocument; bytes: Uint8Array }>;
  pageCount: (doc: PdfDocument) => number;
  /** Every physical page, in order. */
  pageGeometry: (doc: PdfDocument) => Promise<PdfPageGeometry[]>;
  importAnnotations: (
    doc: PdfDocument,
    pages: PageModel[],
    bytes: Uint8Array,
    now?: number,
    options?: PdfAnnotationImportOptions,
  ) => Promise<Overlay[]>;
  /** A small JPEG data URL of one page, or undefined if it cannot render. */
  thumbnail: (
    doc: PdfDocument,
    pageNumber: number,
    maxCssWidth: number,
  ) => Promise<string | undefined>;
  /**
   * Draws one region of a page at the full requested scale into `target`,
   * sized to the region: a viewport tile. `region` is in device pixels of the
   * whole page raster at `scale`·`dpr`.
   */
  renderRegion: (
    doc: PdfDocument,
    request: {
      sourceIndex: number;
      rotation: Rotation;
      scale: number;
      dpr: number;
      region: { x: number; y: number; width: number; height: number };
      /**
       * What waits on this region, most urgent first; engines that queue
       * renders draw a tile on screen before a backdrop or a thumbnail.
       * Defaults to "visible".
       */
      priority?: "visible" | "backdrop" | "thumbnail";
      /** Draw the page's annotations and form fields; default true. */
      annotations?: boolean;
    },
    target: HTMLCanvasElement,
  ) => { cancel: () => void; done: Promise<void> };
  /**
   * One page's text for the reading layer. `checkAbort` throws to stop a
   * read that is no longer wanted. `textOnly` is for a reader that needs the
   * text but not where each glyph sits (find, Live): an engine may then skip
   * the glyph geometry, and `glyphs` comes back null.
   */
  pageText: (
    doc: PdfDocument,
    sourceIndex: number,
    options?: { checkAbort?: () => void; textOnly?: boolean },
  ) => Promise<PdfPageText>;
  /** The document outline, in order. Empty when it has none. */
  outline: (doc: PdfDocument) => Promise<PdfOutlineItem[]>;
  /** One page's links that go somewhere: a page of this document or a URL. */
  pageLinks: (doc: PdfDocument, sourceIndex: number) => Promise<PdfLink[]>;
  /**
   * What the document's encryption allows; null when it is not encrypted.
   * Throws when the engine could not tell, which is never "unencrypted".
   */
  security: (doc: PdfDocument) => PdfSecurity | null;
  /**
   * Opens an encrypted file's `bytes` again with its `password` (empty for
   * none), apart from the document on screen, whose pages the import has
   * changed. Rejects for a file that is not encrypted.
   */
  openEncryptedSource: (bytes: Uint8Array, password: string) => Promise<EncryptedPdfSource>;
  /** Releases the document. Never rejects; failures are logged. */
  destroy: (doc: PdfDocument | null | undefined) => Promise<void>;
};
