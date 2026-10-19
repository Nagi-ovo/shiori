import type { PdfPoint } from "../model/types";

/**
 * A page's text as the reading layer consumes it (text layer, selection,
 * semantic copy, anchors, find). The shape is pdf.js's TextContent, which
 * the reading layer was written against; PDFium's glyphs are built into it
 * (./pdfiumText.ts, docs/PLAN-RUST-PDF-CORE-2026-09.md, stage 4.3).
 */
export type PdfTextItem = {
  str: string;
  /** "ltr", "rtl" or "ttb". */
  dir: string;
  /** Text space to page user space, with the font size folded in. */
  transform: number[];
  /** Advance of the whole string, in page units. */
  width: number;
  height: number;
  /** Key into `PdfPageTextContent.styles`. */
  fontName: string;
  /** The item ends a line. */
  hasEOL: boolean;
};

export type PdfTextMarkedContent = {
  /** "beginMarkedContent", "beginMarkedContentProps" or "endMarkedContent". */
  type: string;
  id?: string;
  tag?: string;
};

export type PdfTextStyle = {
  ascent: number;
  descent: number;
  vertical: boolean;
  fontFamily: string;
};

export type PdfPageTextContent = {
  items: Array<PdfTextItem | PdfTextMarkedContent>;
  styles: Record<string, PdfTextStyle>;
  lang: string | null;
};

/** One drawn glyph's advance cell, in PDF user space. */
export type PdfTextGlyph = {
  text: string;
  fontName: string;
  origin: PdfPoint;
  end: PdfPoint;
  /** The advance cell's corners, excluding Tc/Tw/TJ gaps. */
  quad: PdfPoint[];
};
