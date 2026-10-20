import { importFileAnnotations } from "../../src/pdf/import/annotations";
import { pageGeometryFromPdfium } from "../../src/pdf/engine/pdfiumGeometry";
import type {
  Overlay,
  PageModel,
  PdfRect,
} from "../../src/pdf/model/types";
import { assertPdfPageDimensionsWithinLimit } from "../../src/pdf/openPolicy";
import type { CoreDocument, CoreGlyph } from "./coreEngine";
import {
  ANNOTATION_SPEC_SCHEMA,
  MAX_TEXT_CHARACTERS,
  annotationSpec,
  type AnnotationSpecAnnotation,
  type AnnotationSpecV1,
} from "./annotationSpec";

export type ExtractAnnotation = AnnotationSpecAnnotation;

export type ExtractResult = {
  schema: typeof ANNOTATION_SPEC_SCHEMA;
  command: "extract";
  input: string;
  pages: number[];
  annotations: ExtractAnnotation[];
};

type PageContext = {
  model: PageModel;
  pageNumber: number;
  /** The page text under `rects`, in reading order. */
  quote: (rects: PdfRect[]) => string;
};

/** How far outside a highlight rect a glyph's middle may sit and still count. */
const QUOTE_EPSILON_PT = 0.5;

/** Extraction failed as the CLI reports it: `code`, `summary` its message, `message` the detail. */
export class ExtractError extends Error {
  code: "ERR_ANNOTATIONS_UNAVAILABLE" | "ERR_TEXT_UNAVAILABLE";
  summary: string;

  constructor(code: ExtractError["code"], summary: string, message: string) {
    super(message);
    this.code = code;
    this.summary = summary;
  }
}

/** pdf-lib could not read the file's annotations: unknown, which is not "none". */
export class AnnotationsUnavailableError extends ExtractError {
  constructor(message: string) {
    super("ERR_ANNOTATIONS_UNAVAILABLE", "The PDF's annotations could not be read", message);
    this.name = "AnnotationsUnavailableError";
  }
}

/**
 * Glyph visits one extract may spend finding quotes. A markup's rects are
 * looked up in a y-sorted index, so a real page costs about the lines it
 * covers; the cap stops a hostile page (one line of a million glyphs under
 * thousands of highlights) from hanging the command.
 */
export const MAX_QUOTE_GLYPH_VISITS = 100_000_000;

/** What is left of the glyph visits quoting may still spend; shared by every page. */
export type QuoteBudget = { visits: number };

export class QuoteWorkLimitError extends ExtractError {
  constructor() {
    super(
      "ERR_TEXT_UNAVAILABLE",
      "Annotation quotes exceed Shiori's safety limits",
      `quoting markup annotations took more than ${MAX_QUOTE_GLYPH_VISITS} glyph visits; use --pages to read fewer pages at once`,
    );
    this.name = "QuoteWorkLimitError";
  }
}

/**
 * The selected pages' annotations: page boxes and quotes from shiori-core,
 * the annotations themselves from the file through pdf-lib (an encrypted
 * file through the core's copy in the clear, which keeps its object
 * numbers and so the overlay ids).
 */
export async function extractAnnotationsFromCore(
  core: CoreDocument,
  input: string,
  pageNumbers: number[],
  sourceBytes: Uint8Array,
): Promise<ExtractResult> {
  const pageContexts = corePageContexts(core, pageNumbers);
  const bytes = core.security().revision != null ? core.decryptedCopy() : sourceBytes;
  // Strict: what pdf-lib cannot read is an error, where the app would
  // import it as no annotations.
  let overlays: Overlay[];
  try {
    overlays = await importFileAnnotations(
      pageContexts.map((context) => context.model),
      bytes,
      undefined,
      { strict: true },
    );
  } catch (error) {
    throw new AnnotationsUnavailableError(
      `pdf-lib could not read the file's annotations: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return extractResult(input, pageNumbers, pageContexts, overlays);
}

function extractResult(
  input: string,
  pageNumbers: number[],
  pageContexts: PageContext[],
  overlays: Overlay[],
): ExtractResult {
  const contextByPageId = new Map(
    pageContexts.map((context) => [context.model.id, context]),
  );
  return {
    schema: ANNOTATION_SPEC_SCHEMA,
    command: "extract",
    input,
    pages: pageNumbers,
    annotations: overlays.flatMap((overlay) => {
      const annotation = serializeOverlay(overlay, contextByPageId);
      return annotation ? [annotation] : [];
    }),
  };
}

export function extractResultAsSpec(result: ExtractResult): AnnotationSpecV1 {
  return annotationSpec(result.annotations);
}

export function formatExtractHumanLine(annotation: ExtractAnnotation): string {
  const parts = [`p${annotation.page}`, annotation.type];
  if (
    annotation.type === "highlight" ||
    annotation.type === "underline" ||
    annotation.type === "strikethrough"
  ) {
    if (annotation.quote) parts.push(JSON.stringify(truncateQuote(annotation.quote)));
    parts.push(annotation.color);
    return parts.join(" ");
  }
  if (annotation.type === "note") {
    if (annotation.text.trim()) parts.push(JSON.stringify(truncateQuote(annotation.text)));
    parts.push(annotation.color);
    return parts.join(" ");
  }
  if (annotation.type === "callout") {
    if (annotation.quote) parts.push(JSON.stringify(truncateQuote(annotation.quote)));
    if (annotation.text.trim()) parts.push(JSON.stringify(truncateQuote(annotation.text)));
    parts.push(annotation.color);
    return parts.join(" ");
  }
  if ("color" in annotation && typeof annotation.color === "string") {
    parts.push(annotation.color);
  }
  return parts.join(" ");
}

/** Page `pageNumber` (from 1) as the CLI models it; throws past Shiori's page limit. */
export function corePageModel(core: CoreDocument, pageNumber: number): PageModel {
  const geometry = pageGeometryFromPdfium(core.pageGeometry(pageNumber - 1));
  assertPdfPageDimensionsWithinLimit(geometry.widthPt, geometry.heightPt, pageNumber);
  return { id: `page-${pageNumber}`, sourceIndex: pageNumber - 1, ...geometry };
}

function corePageContexts(core: CoreDocument, pageNumbers: number[]): PageContext[] {
  const budget: QuoteBudget = { visits: MAX_QUOTE_GLYPH_VISITS };
  return pageNumbers.map((pageNumber) => {
    const model = corePageModel(core, pageNumber);
    let quote: ((rects: PdfRect[]) => string) | null = null;
    return {
      model,
      pageNumber,
      quote: (rects) => {
        quote ??= pageQuoter(core.glyphs(pageNumber - 1), model, budget);
        return quote(rects);
      },
    };
  });
}

/**
 * The text under `rects` (page space, origin at the page box corner), glyph by
 * glyph: a glyph belongs when the middle of its advance box lies inside a rect.
 * A highlight over two words of a line quotes those two words. Breaks PDFium inserted
 * between runs become spaces, and a word PDFium saw hyphenated across a line
 * break comes back whole.
 */
export function quoteFromGlyphs(
  glyphs: CoreGlyph[],
  rects: PdfRect[],
  page: Pick<PageModel, "originXPt" | "originYPt">,
): string {
  return pageQuoter(glyphs, page, { visits: Infinity })(rects);
}

/**
 * `quoteFromGlyphs` for many markups on one page: the glyphs are indexed by
 * the height of their middle once, and each rect visits only the glyphs in
 * its own band, each visit charged to `budget`.
 */
export function pageQuoter(
  glyphs: CoreGlyph[],
  page: Pick<PageModel, "originXPt" | "originYPt">,
  budget: QuoteBudget,
): (rects: PdfRect[]) => string {
  const ox = page.originXPt ?? 0;
  const oy = page.originYPt ?? 0;
  const xs: number[] = [];
  const ys: number[] = [];
  // Inserted breaks have no box of their own; they only separate words, so
  // they are never taken and stay out of the index.
  const byY: number[] = [];
  glyphs.forEach((glyph, index) => {
    xs.push((glyph.origin[0] + glyph.end[0]) / 2 - ox);
    ys.push((glyph.loose[1] + glyph.loose[3]) / 2 - oy);
    if (!glyph.generated) byY.push(index);
  });
  byY.sort((a, b) => ys[a]! - ys[b]!);

  return (rects) => {
    const taken = new Set<number>();
    for (const rect of rects) {
      const top = rect.y + rect.h + QUOTE_EPSILON_PT;
      const left = rect.x - QUOTE_EPSILON_PT;
      const right = rect.x + rect.w + QUOTE_EPSILON_PT;
      for (let i = firstAtOrAbove(byY, ys, rect.y - QUOTE_EPSILON_PT); i < byY.length; i += 1) {
        const index = byY[i]!;
        if (!(ys[index]! <= top)) break;
        budget.visits -= 1;
        if (budget.visits < 0) throw new QuoteWorkLimitError();
        if (xs[index]! >= left && xs[index]! <= right) taken.add(index);
      }
    }
    return quoteText(glyphs, [...taken].sort((a, b) => a - b));
  };
}

/** The first position in `byY` whose glyph's middle is at or above `y`. */
function firstAtOrAbove(byY: number[], ys: number[], y: number): number {
  let lo = 0;
  let hi = byY.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ys[byY[mid]!]! < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The quote of the glyphs at `taken` (ascending indices); every other glyph was skipped. */
function quoteText(glyphs: CoreGlyph[], taken: number[]): string {
  let quote = "";
  // A space is owed before the next glyph taken: something was skipped or a
  // break was inserted since the last one.
  let gap = false;
  // The last glyph taken ended a line with a hyphenation hyphen.
  let hyphenated = false;
  let previous = -1;
  for (const index of taken) {
    if (index > previous + 1 && quote && !hyphenated) gap = true;
    previous = index;
    const glyph = glyphs[index]!;
    if (glyph.hyphen) {
      hyphenated = true;
      continue;
    }
    if (gap) quote += " ";
    quote += glyph.text;
    gap = false;
    hyphenated = false;
  }
  return quote.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARACTERS);
}

function serializeOverlay(
  overlay: Overlay,
  contextByPageId: Map<string, PageContext>,
): ExtractAnnotation | null {
  const context = contextByPageId.get(overlay.pageId);
  // No page context means the overlay points outside the extracted models;
  // dropping it is safer than mislabeling it as page 1.
  if (!context) return null;
  const page = context.pageNumber;
  if (
    overlay.type === "highlight" ||
    overlay.type === "underline" ||
    overlay.type === "strikethrough"
  ) {
    const quote = context.quote(overlay.rects);
    return {
      type: overlay.type,
      page,
      rects: overlay.rects.map(cloneRect),
      color: overlay.color,
      opacity: overlay.opacity,
      ...(quote ? { quote } : {}),
    };
  }
  if (overlay.type === "note") {
    return {
      type: "note",
      page,
      at: { x: overlay.rect.x, y: overlay.rect.y },
      text: overlay.text,
      color: overlay.color,
    };
  }
  if (overlay.type === "ink") {
    return {
      type: "ink",
      page,
      paths: overlay.paths.map((path) =>
        path.map((point) => ({ x: point.x, y: point.y })),
      ),
      color: overlay.color,
      width: overlay.width,
    };
  }
  if (overlay.type === "rect") {
    return {
      type: "rect",
      page,
      rect: cloneRect(overlay.rect),
      color: overlay.color,
      strokeWidth: overlay.strokeWidth,
      fill: null,
    };
  }
  if (overlay.type === "stamp") {
    return {
      type: "stamp",
      page,
      kind: overlay.kind,
      rect: cloneRect(overlay.rect),
      color: overlay.color,
      strokeWidth: overlay.strokeWidth,
    };
  }
  if (overlay.type === "callout") {
    const quote = context.quote(overlay.targetRects);
    return {
      type: "callout",
      page,
      targetRects: overlay.targetRects.map(cloneRect),
      rect: cloneRect(overlay.rect),
      ...(overlay.leader
        ? { leader: overlay.leader.map((point) => ({ ...point })) }
        : {}),
      ...(overlay.leaderKind ? { leaderKind: overlay.leaderKind } : {}),
      text: overlay.text,
      fontSize: overlay.fontSize,
      color: overlay.color,
      ...(quote ? { quote } : {}),
      align: overlay.align,
    };
  }
  if (overlay.type === "text") {
    return {
      type: "text",
      page,
      rect: cloneRect(overlay.rect),
      text: overlay.text,
      fontSize: overlay.fontSize,
      color: overlay.color,
      bold: overlay.bold,
      ...optionalItalic(overlay),
      align: overlay.align,
      fontFamily: portableFontFamily(overlay.fontFamily),
    };
  }
  return null;
}

function optionalItalic(overlay: { italic?: boolean }): { italic?: boolean } {
  return typeof overlay.italic === "boolean" ? { italic: overlay.italic } : {};
}

function portableFontFamily(
  family: "sans" | "serif" | "mono" | "notoSansSc" | "notoSansJp",
): "sans" | "serif" | "mono" {
  return family === "serif" || family === "mono" ? family : "sans";
}

function cloneRect(rect: PdfRect): PdfRect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function truncateQuote(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`;
}
