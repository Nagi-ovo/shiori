import type { PdfSecurity } from "../engine/types";

/**
 * What an encrypted PDF's permissions (/P, PDF 32000-2 table 22) allow an
 * export to change. PDFium reports every bit set when the owner password
 * opened the file, so the owner is never restricted here.
 *
 * - annotations: add, change or remove annotations (bit 6);
 * - content: change what the pages draw — flattened markup, edited text,
 *   placed images, a raster copy, removed attachments (bit 4);
 * - pages: reorder, rotate, insert, delete or extract pages (bit 4 at
 *   revision 2; bit 11 "assemble" alone from revision 3 on, since bit 4
 *   covers only what bits 6, 9 and 11 do not).
 */
export type PdfEditKind = "annotations" | "content" | "pages";

const PRINT = 1 << 2;
const MODIFY = 1 << 3;
const ANNOTATE = 1 << 5;
const ASSEMBLE = 1 << 10;
const EDIT_KINDS: readonly PdfEditKind[] = ["annotations", "content", "pages"];

function permits(security: PdfSecurity, kind: PdfEditKind): boolean {
  const bits = security.permissions >>> 0;
  switch (kind) {
    case "annotations":
      return (bits & ANNOTATE) !== 0;
    case "content":
      return (bits & MODIFY) !== 0;
    case "pages":
      return (bits & (security.revision >= 3 ? ASSEMBLE : MODIFY)) !== 0;
  }
}

/** The kinds among `edits` the permissions refuse, in a stable order. */
export function deniedEdits(
  security: PdfSecurity | null,
  edits: Iterable<PdfEditKind>,
): PdfEditKind[] {
  if (!security) return [];
  const wanted = new Set(edits);
  return EDIT_KINDS.filter((kind) => wanted.has(kind) && !permits(security, kind));
}

/** Every kind of edit the permissions refuse: what the open-time notice names. */
export function restrictedEdits(security: PdfSecurity | null): PdfEditKind[] {
  return deniedEdits(security, EDIT_KINDS);
}

/**
 * Whether the password that opened the file allows printing (bit 3; bit 12
 * only raises the quality, which a browser's print frame does not choose).
 */
export function mayPrint(security: PdfSecurity | null): boolean {
  return !security || ((security.permissions >>> 0) & PRINT) !== 0;
}
