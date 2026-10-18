import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { importPdfAnnotations } from "../../src/pdf/import/annotations";
import type {
  Overlay,
  PageModel,
  PdfRect,
  Rotation,
} from "../../src/pdf/model/types";
import { assertPdfPageDimensionsWithinLimit } from "../../src/pdf/openPolicy";
import { getBoundedTextContent } from "../../src/editor/textSelection/semanticText";
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

type TextItemRect = {
  index: number;
  text: string;
  rect: PdfRect;
};

type TextItemLike = {
  str: string;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
};

const INTERSECTION_EPSILON_PT = 0.75;
/** How far outside a highlight rect a glyph's middle may sit and still count. */
const QUOTE_EPSILON_PT = 0.5;

export async function extractAnnotationsFromPdf(
  doc: PDFDocumentProxy,
  input: string,
  pageNumbers: number[],
  sourceBytes?: Uint8Array,
  /** Reads page boxes and quotes from shiori-core instead of pdf.js. */
  core?: CoreDocument,
): Promise<ExtractResult> {
  const pageContexts = core
    ? corePageContexts(core, pageNumbers)
    : await readPageContexts(doc, pageNumbers);
  const overlays = await importPdfAnnotations(
    doc,
    pageContexts.map((context) => context.model),
    sourceBytes,
    undefined,
    // With the core, an encrypted file's annotations come from its copy in the clear.
    core ? { decryptedBytes: async () => core.decryptedCopy() } : {},
  );
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

async function readPageContexts(
  doc: PDFDocumentProxy,
  pageNumbers: number[],
): Promise<PageContext[]> {
  const contexts: PageContext[] = [];
  for (const pageNumber of pageNumbers) {
    const page = await doc.getPage(pageNumber);
    try {
      const model = pageModelFromPdfjsPage(page, pageNumber);
      const textItems = await textItemRectsForPage(page, model);
      contexts.push({
        model,
        pageNumber,
        quote: (rects) => quoteForRects(textItems, rects),
      });
    } finally {
      page.cleanup();
    }
  }
  return contexts;
}

function corePageContexts(core: CoreDocument, pageNumbers: number[]): PageContext[] {
  return pageNumbers.map((pageNumber) => {
    const geometry = core.pageGeometry(pageNumber - 1);
    assertPdfPageDimensionsWithinLimit(geometry.width, geometry.height, pageNumber);
    const model: PageModel = {
      id: `page-${pageNumber}`,
      sourceIndex: pageNumber - 1,
      rotation: normalizeRotation(geometry.rotation),
      originXPt: geometry.originX,
      originYPt: geometry.originY,
      widthPt: geometry.width,
      heightPt: geometry.height,
    };
    let glyphs: CoreGlyph[] | null = null;
    return {
      model,
      pageNumber,
      quote: (rects) => {
        glyphs ??= core.glyphs(pageNumber - 1);
        return quoteFromGlyphs(glyphs, rects, model);
      },
    };
  });
}

/**
 * The text under `rects` (page space, origin at the page box corner), glyph by
 * glyph: a glyph belongs when the middle of its advance box lies inside a rect.
 * Unlike the pdf.js path, which can only take whole text items, a highlight
 * over two words of a line quotes those two words. Breaks PDFium inserted
 * between runs become spaces, and a word PDFium saw hyphenated across a line
 * break comes back whole.
 */
export function quoteFromGlyphs(
  glyphs: CoreGlyph[],
  rects: PdfRect[],
  page: Pick<PageModel, "originXPt" | "originYPt">,
): string {
  const ox = page.originXPt ?? 0;
  const oy = page.originYPt ?? 0;
  const inside = (glyph: CoreGlyph) => {
    const x = (glyph.origin[0] + glyph.end[0]) / 2 - ox;
    const y = (glyph.loose[1] + glyph.loose[3]) / 2 - oy;
    return rects.some(
      (rect) =>
        x >= rect.x - QUOTE_EPSILON_PT &&
        x <= rect.x + rect.w + QUOTE_EPSILON_PT &&
        y >= rect.y - QUOTE_EPSILON_PT &&
        y <= rect.y + rect.h + QUOTE_EPSILON_PT,
    );
  };
  let quote = "";
  // A space is owed before the next glyph taken: something was skipped or a
  // break was inserted since the last one.
  let gap = false;
  // The last glyph taken ended a line with a hyphenation hyphen.
  let hyphenated = false;
  for (const glyph of glyphs) {
    // Inserted breaks have no box of their own; they only separate words.
    if (glyph.generated || !inside(glyph)) {
      if (quote && !hyphenated) gap = true;
      continue;
    }
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

export function pageModelFromPdfjsPage(
  page: PDFPageProxy,
  pageNumber: number,
): PageModel {
  const view = page.view;
  const widthPt = view[2]! - view[0]!;
  const heightPt = view[3]! - view[1]!;
  assertPdfPageDimensionsWithinLimit(widthPt, heightPt, pageNumber);
  return {
    id: `page-${pageNumber}`,
    sourceIndex: pageNumber - 1,
    rotation: normalizeRotation(page.rotate ?? 0),
    originXPt: view[0]!,
    originYPt: view[1]!,
    widthPt,
    heightPt,
  };
}

async function textItemRectsForPage(
  page: PDFPageProxy,
  model: PageModel,
): Promise<TextItemRect[]> {
  const content = await getBoundedTextContent(page);
  const items: TextItemRect[] = [];
  content.items.forEach((item, index) => {
    if (!isTextItemLike(item)) return;
    const text = item.str.replace(/\s+/g, " ").trim();
    if (!text) return;
    const rect = textItemRect(item, model);
    if (!rect) return;
    items.push({ index, text, rect });
  });
  return items;
}

function textItemRect(item: TextItemLike, page: PageModel): PdfRect | null {
  const transform = item.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const x = numberValue(transform[4]);
  const y = numberValue(transform[5]);
  const rawWidth = numberValue(item.width);
  const rawHeight = numberValue(item.height);
  if (x == null || y == null || rawWidth == null || rawHeight == null) return null;
  const width = Math.abs(rawWidth);
  const height = Math.abs(rawHeight);
  if (width <= 0 || height <= 0) return null;
  return {
    x: x - (page.originXPt ?? 0),
    y: y - (page.originYPt ?? 0),
    w: width,
    h: height,
  };
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

function quoteForRects(textItems: TextItemRect[], rects: PdfRect[]): string {
  const quote = textItems
    .filter((item) =>
      rects.some((rect) => rectsIntersect(item.rect, rect, INTERSECTION_EPSILON_PT)),
    )
    .sort((a, b) => a.index - b.index)
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return quote.slice(0, MAX_TEXT_CHARACTERS);
}

function rectsIntersect(a: PdfRect, b: PdfRect, epsilon: number): boolean {
  return !(
    a.x + a.w < b.x - epsilon ||
    b.x + b.w < a.x - epsilon ||
    a.y + a.h < b.y - epsilon ||
    b.y + b.h < a.y - epsilon
  );
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

function normalizeRotation(angle: number): Rotation {
  return ((((angle % 360) + 360) % 360) as Rotation);
}

function isTextItemLike(value: unknown): value is TextItemLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    typeof (value as { str?: unknown }).str === "string"
  );
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
