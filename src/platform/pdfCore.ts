// shiori-core, the Rust/PDFium page renderer, as the desktop app reaches it
// (docs/PLAN-RUST-PDF-CORE-2026-09.md, stage 3). Web and mobile have no
// PDFium yet and report it unavailable; callers keep drawing with pdf.js.
//
// `pdf_core_open` and `pdf_core_render` move raw bytes (the PDF in, RGBA out)
// and so have hand-written invokes, like save.ts; the rest go through the
// generated bindings.
import { commands, unwrapCommand } from "./ipc";
import { IS_TAURI_DESKTOP } from "./index";
import { encodeSuggestedNameHeader } from "./save";

export const PDF_CORE_AVAILABLE = IS_TAURI_DESKTOP;

/** Tiles on screen outrank the page backdrop, which outranks thumbnails. */
export type PdfCorePriority = "visible" | "backdrop" | "thumbnail";

const PRIORITY: Record<PdfCorePriority, number> = {
  visible: 0,
  backdrop: 1,
  thumbnail: 2,
};

export type PdfCoreRenderRequest = {
  /** The page's displayed rotation, clockwise degrees; replaces its /Rotate. */
  rotation: number;
  /** Device pixels per PDF point: zoom scale × device pixel ratio. */
  pixelsPerPoint: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Draw annotations and form fields; default true. */
  annotations?: boolean;
};

/** Opens a copy of `bytes` in the render process; resolves to its id. */
export async function pdfCoreOpen(bytes: Uint8Array, password?: string): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("pdf_core_open", new Uint8Array(bytes), {
    headers: password
      ? { "x-shiori-pdf-password": encodeSuggestedNameHeader(password) }
      : {},
  });
}

/** RGBA rows of the requested region, `width × height × 4` bytes. */
export async function pdfCoreRender(
  doc: number,
  page: number,
  request: PdfCoreRenderRequest,
  priority: PdfCorePriority,
  ticket: number,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<ArrayBuffer | number[]>("pdf_core_render", {
    doc,
    page,
    ...request,
    priority: PRIORITY[priority],
    ticket,
  });
  return raw instanceof ArrayBuffer
    ? new Uint8ClampedArray(raw)
    : new Uint8ClampedArray(new Uint8Array(raw).buffer);
}

/** Drops these renders if they have not started. Fire and forget. */
export function pdfCoreCancel(tickets: number[]): void {
  if (tickets.length === 0) return;
  void commands.pdfCoreCancel(tickets).catch(() => undefined);
}

export function pdfCoreClose(doc: number): void {
  void commands.pdfCoreClose(doc).catch(() => undefined);
}

/**
 * Hides annotations Shiori draws itself from one page's raster, found by
 * subtype and /Rect `[left, bottom, right, top]`. Resolves to how many it hid.
 */
export async function pdfCoreHideAnnotations(
  doc: number,
  page: number,
  keys: Array<{ subtype: string; rect: [number, number, number, number] }>,
): Promise<number> {
  return unwrapCommand(await commands.pdfCoreHideAnnotations(doc, page, keys));
}

export type { PdfCoreDestination, PdfCoreLink, PdfCoreOutlineItem } from "./bindings";

export async function pdfCoreOutline(doc: number) {
  return unwrapCommand(await commands.pdfCoreOutline(doc));
}

export async function pdfCoreLinks(doc: number, page: number) {
  return unwrapCommand(await commands.pdfCoreLinks(doc, page));
}

export type { PdfCoreGlyph, PdfCorePageText } from "./bindings";

/** One page's characters and the document's language, as PDFium reads them. */
export async function pdfCorePageText(doc: number, page: number) {
  return unwrapCommand(await commands.pdfCorePageText(doc, page));
}

/** The open document rewritten without its encryption, for the annotation import. */
export async function pdfCoreDecryptedCopy(doc: number): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<ArrayBuffer | number[]>("pdf_core_decrypted_copy", { doc });
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
}

export type { PdfCoreSecurity } from "./bindings";

/** What the open document's encryption allows, as PDFium reports it. */
export async function pdfCoreSecurity(doc: number) {
  return unwrapCommand(await commands.pdfCoreSecurity(doc));
}

/**
 * `plain`, an unencrypted export of the open document `doc`, encrypted with
 * that document's own handler and key, unlocked when it was opened: no
 * password travels with this call.
 */
export async function pdfCoreEncryptLikeSource(doc: number, plain: Uint8Array): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<ArrayBuffer | number[]>("pdf_core_encrypt_like_source", new Uint8Array(plain), {
    headers: { "x-shiori-pdf-doc": String(doc) },
  });
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
}

export type { PdfCorePageGeometry } from "./bindings";

/** Every page's box and /Rotate, in order. */
export async function pdfCorePageGeometry(doc: number) {
  return unwrapCommand(await commands.pdfCorePageGeometry(doc));
}

/** The embedded fonts a page draws with, packed (src/pdf/engine/fontContainer.ts reads it). */
export async function pdfCorePageFonts(doc: number, page: number): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<ArrayBuffer | number[]>("pdf_core_page_fonts", { doc, page });
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
}

/** The named embedded fonts rebuilt from this page's glyphs, as JSON bytes (src/pdf/engine/fontOutlines.ts reads it). */
export async function pdfCoreFontOutlines(doc: number, page: number, names: string[]): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<ArrayBuffer | number[]>("pdf_core_font_outlines", { doc, page, names });
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
}
