import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { getBoundedTextContent as getTextContent } from "../../../src/editor/textSelection/semanticText";
import { textGlyphsFromOperators, type GlyphFont } from "./pdfjsGlyphs";
import type { PdfPageTextContent } from "../../../src/pdf/engine/text";
import type { PdfPageText } from "../../../src/pdf/engine/types";

type PdfJsFontObject = { name?: string; loadedName?: string };

/**
 * Reference for validation (scripts/pdfium/compare-page-text.ts), not part of
 * the app: a page's text as pdf.js reads it: the bounded text stream, the glyphs from
 * the operator list, and the fonts' BaseFont names, which pdf.js only knows
 * once the operator list has loaded them.
 */
export async function pdfjsPageText(
  doc: PDFDocumentProxy,
  sourceIndex: number,
  options: { checkAbort?: () => void; textOnly?: boolean } = {},
): Promise<PdfPageText> {
  const page = await doc.getPage(sourceIndex + 1);
  if (options.textOnly) {
    // A sweep over many pages (find, Live): skip the operator list, and let
    // pdf.js drop what it parsed for this page once the text is out.
    try {
      const content = await getTextContent(page, options);
      return { content, glyphs: null, fontNames: new Map(), faceFamilies: new Map() };
    } finally {
      page.cleanup?.();
    }
  }
  const content = await getTextContent(page, options);
  options.checkAbort?.();
  const operators = await page.getOperatorList().catch(() => null);
  options.checkAbort?.();
  const commonObjs = (page as PDFPageProxy & { commonObjs?: { get: (id: string) => unknown } })
    .commonObjs;
  const glyphs = operators
    ? textGlyphsFromOperators(
        operators,
        (id) => (commonObjs?.get(id) as GlyphFont | null) ?? null,
      )
    : null;
  const names = fontNames(commonObjs, content);
  // pdf.js loads every font it parses as a FontFace named by its style key.
  const faceFamilies = new Map([...names.keys()].map((key) => [key, key]));
  return { content, glyphs, fontNames: names, faceFamilies };
}

function fontNames(
  commonObjs: { get: (id: string) => unknown } | undefined,
  content: PdfPageTextContent,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!commonObjs) return out;
  for (const fontId of Object.keys(content.styles)) {
    try {
      const font = commonObjs.get(fontId) as PdfJsFontObject | undefined;
      const name = font?.name ?? font?.loadedName;
      if (name) out.set(fontId, name);
    } catch {
      // The font object may not be resolved for pages that have not rendered
      // yet. In that case we keep the pdf.js font id and fall back normally.
    }
  }
  return out;
}
