// Page-level entry of the glyph-removal pass: decode + coalesce the page's
// /Contents, walk it, excise glyphs fully covered by a contentText edit, and
// swap in the rewritten stream.
//
// Best-effort by contract: ANY failure — unsupported filter, parse error,
// unmodelable construct, missing resources — reports every cover rect dirty
// and leaves the page exactly as it was, so the export falls back to today's
// cover-and-redraw output. Never throws.
//
// Sharing safety: nothing is mutated in place. The rewritten bytes go into a
// NEW stream object referenced from THIS page's dict, so duplicates of the
// same source page (which share copied stream objects) are unaffected.
//
// Known v1 limit: text inside Form XObjects is not walked, so it stays
// covered-but-present. Recursing with copy-on-write is the planned follow-up
// (docs/PLAN-CONTENT-STREAM-TEXT-REMOVAL-2026-07.md).

import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFPage,
} from "pdf-lib";
import type { PdfRect } from "../../model/types";
import type { GlyphPlacement, XObjectUse } from "./textState";
import type { RectFontAttribution } from "./removeGlyphs";
import { coalesceContentStreams, tokenizeContentStream } from "./tokenizer";
import { walkTextPlacements } from "./textState";
import { contentFontInfo } from "./glyphWidths";
import { quadIntersectsRect, removeCoveredGlyphs } from "./removeGlyphs";

type Matrix = [number, number, number, number, number, number];

export type RedactionReport = {
  removedCount: number;
  cleanRects: boolean[];
  // Per-rect: which /Font resource the removed glyphs came from. "none" /
  // "mixed" (and every failure path) mean the export cannot redraw that
  // rect's replacement with the source font.
  rectFonts: RectFontAttribution[];
};

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function decodeStream(stream: PDFRawStream): Uint8Array {
  return stream.dict.has(PDFName.of("Filter"))
    ? decodePDFRawStream(stream).decode()
    : stream.getContents();
}

function dirtyReport(coverRects: PdfRect[]): RedactionReport {
  return {
    removedCount: 0,
    cleanRects: coverRects.map(() => false),
    rectFonts: coverRects.map(() => ({ kind: "none" })),
  };
}

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function applyMatrix(
  m: Matrix,
  p: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

function numberAt(array: PDFArray, index: number): number | null {
  const value = array.lookupMaybe(index, PDFNumber)?.asNumber();
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function matrixFromArray(array: PDFArray | undefined): Matrix | null {
  if (!array) return IDENTITY;
  if (array.size() !== 6) return null;
  const values = Array.from({ length: 6 }, (_, index) => numberAt(array, index));
  return values.every((value) => value !== null) ? (values as Matrix) : null;
}

function boxQuad(
  llx: number,
  lly: number,
  urx: number,
  ury: number,
  matrix: Matrix,
): GlyphPlacement["quad"] {
  return [
    applyMatrix(matrix, { x: llx, y: lly }),
    applyMatrix(matrix, { x: urx, y: lly }),
    applyMatrix(matrix, { x: urx, y: ury }),
    applyMatrix(matrix, { x: llx, y: ury }),
  ];
}

function formXObjectQuad(
  stream: PDFStream,
  ctm: Matrix,
): GlyphPlacement["quad"] | null {
  const bbox = stream.dict.lookupMaybe(PDFName.of("BBox"), PDFArray);
  if (!bbox || bbox.size() !== 4) return null;
  const matrix = matrixFromArray(
    stream.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray),
  );
  const llx = numberAt(bbox, 0);
  const lly = numberAt(bbox, 1);
  const urx = numberAt(bbox, 2);
  const ury = numberAt(bbox, 3);
  if (
    matrix === null ||
    llx === null ||
    lly === null ||
    urx === null ||
    ury === null
  ) {
    return null;
  }
  return boxQuad(llx, lly, urx, ury, multiply(matrix, ctm));
}

function xObjectQuad(
  use: XObjectUse,
  xObjectDict: PDFDict | undefined,
): GlyphPlacement["quad"] | null {
  if (!xObjectDict || !use.ctm.every((value) => Number.isFinite(value))) {
    return null;
  }
  const stream = xObjectDict.lookupMaybe(PDFName.of(use.name), PDFStream);
  if (!stream) return null;

  const subtype = stream.dict
    .lookupMaybe(PDFName.of("Subtype"), PDFName)
    ?.decodeText();
  const ctm = use.ctm as Matrix;
  if (subtype === "Form") return formXObjectQuad(stream, ctm);
  if (subtype === "Image") return boxQuad(0, 0, 1, 1, ctm);
  return null;
}

function applyXObjectDirtiness(
  cleanRects: boolean[],
  coverRects: PdfRect[],
  xobjects: XObjectUse[],
  xObjectDict: PDFDict | undefined,
): void {
  for (const use of xobjects) {
    const quad = xObjectQuad(use, xObjectDict);
    if (!quad) {
      cleanRects.fill(false);
      return;
    }
    for (let rectIndex = 0; rectIndex < coverRects.length; rectIndex += 1) {
      if (!cleanRects[rectIndex]) continue;
      if (quadIntersectsRect(quad, coverRects[rectIndex]!)) {
        cleanRects[rectIndex] = false;
      }
    }
  }
}

export function redactCoveredTextOnPage(
  page: PDFPage,
  coverRects: PdfRect[],
): RedactionReport {
  if (coverRects.length === 0) {
    return { removedCount: 0, cleanRects: [], rectFonts: [] };
  }
  try {
    const node = page.node;
    const context = page.doc.context;
    const resolve = (value: unknown): unknown =>
      value instanceof PDFRef ? context.lookup(value) : value;

    const rawContents = node.get(PDFName.of("Contents"));
    const contents = resolve(rawContents);
    const parts: Uint8Array[] = [];
    if (contents === undefined) {
      // No /Contents is a valid empty page: the walk over an empty stream
      // succeeds and the rect can be clean if no XObject use overlaps it.
    } else if (contents instanceof PDFRawStream) {
      parts.push(decodeStream(contents));
    } else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const part = resolve(contents.get(i));
        if (!(part instanceof PDFRawStream)) return dirtyReport(coverRects);
        parts.push(decodeStream(part));
      }
    } else {
      return dirtyReport(coverRects);
    }

    const source = coalesceContentStreams(parts);
    const ops = tokenizeContentStream(source);

    const resources = node.Resources();
    const fontDict = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
    const extGStateDict = resources?.lookupMaybe(
      PDFName.of("ExtGState"),
      PDFDict,
    );
    const xObjectDict = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const walk = walkTextPlacements(ops, {
      resolveFont: (name) => {
        const font = fontDict?.lookupMaybe(PDFName.of(name), PDFDict);
        return font ? contentFontInfo(font) : null;
      },
      extGStateSetsFont: (name) => {
        const state = extGStateDict?.lookupMaybe(PDFName.of(name), PDFDict);
        if (!state) return null;
        return state.has(PDFName.of("Font"));
      },
    });
    if (!walk.ok) return dirtyReport(coverRects);

    const result = removeCoveredGlyphs(source, ops, walk.glyphs, coverRects);
    const cleanRects = [...result.cleanRects];
    applyXObjectDirtiness(cleanRects, coverRects, walk.xobjects, xObjectDict);

    if (result.changed) {
      const rewritten = context.flateStream(result.bytes);
      node.set(PDFName.of("Contents"), context.register(rewritten));
    }
    return {
      removedCount: result.removedCount,
      cleanRects,
      rectFonts: result.rectFonts,
    };
  } catch {
    return dirtyReport(coverRects);
  }
}
