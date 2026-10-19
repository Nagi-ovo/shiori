export const MAX_PDF_BYTES = 200 * 1024 * 1024;
export const MAX_PDF_PAGES = 500;
export const THUMBNAIL_PRE_RENDER_PAGE_LIMIT = 100;
export const MAX_PAGE_DIMENSION_PT = 14_400; // 200 in at 72 pt/in
export const MAX_CANVAS_PIXELS = 32_000_000;
export const MAX_THUMBNAIL_CANVAS_PIXELS = 1_000_000;

export type PdfOpenErrorKind =
  | "tooLarge"
  | "tooManyPages"
  | "pageTooLarge"
  | "renderTooLarge"
  | "password"
  | "damaged"
  | "engineUnavailable"
  | "unknown";

export class PdfOpenError extends Error {
  kind: PdfOpenErrorKind;

  constructor(kind: PdfOpenErrorKind, message: string) {
    super(message);
    this.name = "PdfOpenError";
    this.kind = kind;
  }
}

export function assertPdfWithinFileLimit(size: number): void {
  if (size > MAX_PDF_BYTES) {
    throw new PdfOpenError("tooLarge", `PDF is ${size} bytes`);
  }
}

export function assertPdfWithinPageLimit(pageCount: number): void {
  if (pageCount > MAX_PDF_PAGES) {
    throw new PdfOpenError("tooManyPages", `PDF has ${pageCount} pages`);
  }
}

export function assertPdfPageDimensionsWithinLimit(
  widthPt: number,
  heightPt: number,
  pageIndex1Based?: number,
): void {
  if (
    !Number.isFinite(widthPt) ||
    !Number.isFinite(heightPt) ||
    widthPt <= 0 ||
    heightPt <= 0 ||
    widthPt > MAX_PAGE_DIMENSION_PT ||
    heightPt > MAX_PAGE_DIMENSION_PT
  ) {
    const page = pageIndex1Based == null ? "" : ` page ${pageIndex1Based}`;
    throw new PdfOpenError(
      "pageTooLarge",
      `PDF${page} has dimensions ${widthPt}×${heightPt} pt`,
    );
  }
}

export function assertCanvasPixelBudget(
  widthPx: number,
  heightPx: number,
  maxPixels: number = MAX_CANVAS_PIXELS,
): void {
  if (!isCanvasWithinPixelBudget(widthPx, heightPx, maxPixels)) {
    throw new PdfOpenError(
      "renderTooLarge",
      `Canvas would be ${widthPx}×${heightPx} px`,
    );
  }
}

export function maxScaleForCanvasBudget(
  pageWidthPxAtScale1: number,
  pageHeightPxAtScale1: number,
  dpr: number = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  maxPixels: number = MAX_CANVAS_PIXELS,
): number {
  if (
    !Number.isFinite(pageWidthPxAtScale1) ||
    !Number.isFinite(pageHeightPxAtScale1) ||
    !Number.isFinite(dpr) ||
    !Number.isFinite(maxPixels) ||
    pageWidthPxAtScale1 <= 0 ||
    pageHeightPxAtScale1 <= 0 ||
    dpr <= 0 ||
    maxPixels <= 0
  ) {
    return 0;
  }
  return Math.sqrt(
    maxPixels / (pageWidthPxAtScale1 * pageHeightPxAtScale1 * dpr * dpr),
  );
}

export function clampScaleToCanvasBudget(
  scale: number,
  pageWidthPxAtScale1: number,
  pageHeightPxAtScale1: number,
  dpr: number = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  maxPixels: number = MAX_CANVAS_PIXELS,
): number {
  const maxScale = maxScaleForCanvasBudget(
    pageWidthPxAtScale1,
    pageHeightPxAtScale1,
    dpr,
    maxPixels,
  );
  if (!Number.isFinite(scale) || scale <= 0) return Math.max(0, maxScale);
  if (maxScale <= 0) return 0;
  return Math.min(scale, maxScale);
}

export function isCanvasWithinPixelBudget(
  widthPx: number,
  heightPx: number,
  maxPixels: number = MAX_CANVAS_PIXELS,
): boolean {
  return (
    Number.isFinite(widthPx) &&
    Number.isFinite(heightPx) &&
    Number.isFinite(maxPixels) &&
    widthPx > 0 &&
    heightPx > 0 &&
    maxPixels > 0 &&
    widthPx <= maxPixels / heightPx
  );
}

const PDF_OPEN_ERROR_KINDS: ReadonlySet<string> = new Set<PdfOpenErrorKind>([
  "tooLarge",
  "tooManyPages",
  "pageTooLarge",
  "renderTooLarge",
  "password",
  "damaged",
  "engineUnavailable",
  "unknown",
]);

export function classifyPdfOpenError(err: unknown): PdfOpenErrorKind {
  if (err instanceof PdfOpenError) return err.kind;
  const name = String((err as { name?: unknown })?.name ?? "");
  // A PdfOpenError from another copy of this module, which the CLI bundle
  // carries: not this class, but its name and kind.
  const kind = (err as { kind?: unknown })?.kind;
  if (name === "PdfOpenError" && typeof kind === "string" && PDF_OPEN_ERROR_KINDS.has(kind)) {
    return kind as PdfOpenErrorKind;
  }
  const message = String((err as { message?: unknown })?.message ?? "");
  const joined = `${name} ${message}`.toLowerCase();
  if (name === "PasswordException" || /password|encrypted/.test(joined)) {
    return "password";
  }
  // shiori-core did not start: PDFium missing (desktop), or its wasm worker
  // could not load (web, mobile).
  if (/pdfium library unavailable|pdfium-missing|pdf-core-worker|pdf engine unavailable/.test(joined)) {
    return "engineUnavailable";
  }
  if (
    name === "InvalidPDFException" ||
    /invalid pdf|missing pdf|xref|trailer|page tree|parse|damaged|corrupt/.test(
      joined,
    )
  ) {
    return "damaged";
  }
  return "unknown";
}

export function diagnosticCode(kind: PdfOpenErrorKind): string {
  return `ERR_PDF_${kind.replace(/[A-Z]/g, (ch) => `_${ch}`).toUpperCase()}`;
}
