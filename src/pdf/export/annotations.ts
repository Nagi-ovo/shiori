// Builds real PDF /Annot dictionaries for our overlay model and attaches
// them to pages, so exported documents remain editable in Acrobat, Foxit,
// PDF Expert, and our own reader. Parallel path to the flatten-into-page
// code in exportPdf.ts — both live side-by-side because some export
// workflows (stamping, signing) intentionally want flattened content.

import {
  LineCapStyle,
  LineJoinStyle,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  appendBezierCurve,
  beginText,
  clip,
  degrees,
  drawText as drawTextOperators,
  endText,
  endPath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingColor,
  stroke,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { Font as FontkitFont } from "@pdf-lib/fontkit";
import type {
  CalloutOverlay,
  CalloutThreadEntry,
  HighlightOverlay,
  InkOverlay,
  NoteOverlay,
  Overlay,
  OverlayTextAnchor,
  PageModel,
  RectOverlay,
  StampOverlay,
  StrikeOutOverlay,
  TextOverlay,
  UnderlineOverlay,
} from "../model/types";
import {
  CALLOUT_LABEL_PADDING_X_PT,
  CALLOUT_LABEL_PADDING_Y_PT,
  CALLOUT_TARGET_OPACITY,
  calloutConnectorGeometry,
} from "../model/callout";
import { baseTextDirection, hasKana, hasNonAscii } from "./textScripts";
import { measureTextWidth, wrapText } from "./textWrap";
import { drawPathText, type PathTextFont } from "./vectorText";
import { isListedForImport } from "../import/sourceAnnotations";

export type AnnotationFonts = {
  // Standard-14 PDF fonts. Routed on by TextOverlay.fontFamily so the
  // editable-mode export matches the flatten-mode export instead of
  // silently collapsing every family into Helvetica.
  helv: PDFFont;
  helvBold: PDFFont;
  helvOblique: PDFFont;
  helvBoldOblique: PDFFont;
  times: PDFFont;
  timesBold: PDFFont;
  timesItalic: PDFFont;
  timesBoldItalic: PDFFont;
  courier: PDFFont;
  courierBold: PDFFont;
  courierOblique: PDFFont;
  courierBoldOblique: PDFFont;
  zapf: PDFFont;
  // Simplified-Chinese CJK font. Used for FreeText without kana — the
  // glyph shapes render correctly for Chinese content. If null,
  // non-ASCII FreeText falls back to helv and renders as "?" in
  // viewers, though the Contents field still carries the original
  // text so downstream editors can recover it.
  unicode: PDFFont | null;
  unicodePath: FontkitFont | null;
  // Japanese CJK font. Used for FreeText that contains hiragana or
  // katakana — the SC font doesn't cover those blocks at all. Kanji
  // in these overlays also renders through this font so Japanese
  // readers see consistent glyph shapes.
  unicodeJp: PDFFont | null;
  unicodeJpPath: FontkitFont | null;
};

type FontFamily = TextOverlay["fontFamily"];
type FreeTextFontEntry = {
  name: PDFName;
  font: PDFFont;
  pathFont?: PathTextFont | null;
};
type FreeTextFontNames = {
  helv: FreeTextFontEntry;
  helvBold: FreeTextFontEntry;
  helvOblique: FreeTextFontEntry;
  helvBoldOblique: FreeTextFontEntry;
  times: FreeTextFontEntry;
  timesBold: FreeTextFontEntry;
  timesItalic: FreeTextFontEntry;
  timesBoldItalic: FreeTextFontEntry;
  courier: FreeTextFontEntry;
  courierBold: FreeTextFontEntry;
  courierOblique: FreeTextFontEntry;
  courierBoldOblique: FreeTextFontEntry;
  zapf: FreeTextFontEntry;
  unicode: FreeTextFontEntry | null;
  unicodePath: FontkitFont | null;
  unicodeJp: FreeTextFontEntry | null;
  unicodeJpPath: FontkitFont | null;
};

const SHIORI_ANNOT_PREFIX = "shiori:";
const SYNTHETIC_ITALIC_DEGREES = 12;
const SHIORI_FONT_PREFIXES = [
  "SCour",
  "SCourB",
  "SCourO",
  "SCourBO",
  "SHelv",
  "SHelvB",
  "SHelvO",
  "SHelvBO",
  "STimes",
  "STimesB",
  "STimesI",
  "STimesBI",
  "SUni",
  "SUniJP",
  "SZapf",
];
const REPLACED_SOURCE_SUBTYPES = new Set([
  "FreeText",
  "Highlight",
  "Ink",
  "Square",
  "Text",
  "StrikeOut",
  "Underline",
]);

/** Remove every page annotation, including links, widgets, and unknown types. */
export function stripAllAnnotationsFromPages(pages: PDFPage[]): boolean {
  let removed = false;
  for (const page of pages) {
    if (!page.node.get(PDFName.of("Annots"))) continue;
    page.node.delete(PDFName.of("Annots"));
    removed = true;
  }
  return removed;
}

export function stripReplaceableAnnotationsFromPages(pages: PDFPage[]): boolean {
  let removedAny = false;
  for (const page of pages) {
    removedAny = stripReplaceableAnnotationsFromPage(page) || removedAny;
  }
  return removedAny;
}

// Main entry: build annotation refs for the overlays on `page` and attach
// them to its /Annots array. Handles per-page font registration for
// FreeText so the DA string's font operator resolves against the page's
// /Resources /Font dict.
export function attachAnnotationsToPage(
  page: PDFPage,
  model: PageModel,
  overlays: Overlay[],
  fonts: AnnotationFonts,
): void {
  const pageOverlays = overlays.filter((o) => o.pageId === model.id);
  if (pageOverlays.length === 0) return;

  // Cache font-dict names once per page, only if a FreeText shows up.
  // The ASCII fonts cover every family × weight combination because
  // the editable-mode DA string needs a single resolved /Font name
  // per annotation — picking at buildAnnotRef time requires all six
  // to be registered up front.
  let freeTextFontNames: FreeTextFontNames | null = null;
  const ensureFontNames = (): FreeTextFontNames => {
    if (freeTextFontNames) return freeTextFontNames;
    const reg = (
      alias: string,
      font: PDFFont,
      pathFont?: FontkitFont | null,
    ): FreeTextFontEntry => ({
      name: page.node.newFontDictionary(alias, font.ref),
      font,
      pathFont,
    });
    freeTextFontNames = {
      helv: reg("SHelv", fonts.helv),
      helvBold: reg("SHelvB", fonts.helvBold),
      helvOblique: reg("SHelvO", fonts.helvOblique),
      helvBoldOblique: reg("SHelvBO", fonts.helvBoldOblique),
      times: reg("STimes", fonts.times),
      timesBold: reg("STimesB", fonts.timesBold),
      timesItalic: reg("STimesI", fonts.timesItalic),
      timesBoldItalic: reg("STimesBI", fonts.timesBoldItalic),
      courier: reg("SCour", fonts.courier),
      courierBold: reg("SCourB", fonts.courierBold),
      courierOblique: reg("SCourO", fonts.courierOblique),
      courierBoldOblique: reg("SCourBO", fonts.courierBoldOblique),
      zapf: reg("SZapf", fonts.zapf),
      unicode: fonts.unicode
        ? reg("SUni", fonts.unicode, fonts.unicodePath)
        : null,
      unicodePath: fonts.unicodePath,
      unicodeJp: fonts.unicodeJp
        ? reg("SUniJP", fonts.unicodeJp, fonts.unicodeJpPath)
        : null,
      unicodeJpPath: fonts.unicodeJpPath,
    };
    return freeTextFontNames;
  };

  const refsByOverlayId = new Map<string, PDFRef>();
  for (const o of pageOverlays) {
    const ref = buildAnnotRef(page, o, ensureFontNames);
    if (!ref) continue;
    page.node.addAnnot(ref);
    refsByOverlayId.set(o.id, ref);
    applySourceProvenance(page, o, ref);
  }
  // /IRT has to wait until every annotation on the page has a ref, because a
  // reply may be built before the comment it answers. Threads that span pages
  // are not rebuilt: /IRT is defined within a page's annotation list.
  linkReplyThreads(page, pageOverlays, refsByOverlayId);
  // Callout conversation turns become native /IRT Text replies, appended in
  // thread order so a round trip reads them back in the same order.
  for (const o of pageOverlays) {
    if (o.type !== "callout" || !o.thread?.length) continue;
    const parentRef = refsByOverlayId.get(o.id);
    if (!parentRef) continue;
    for (const entry of o.thread) {
      page.node.addAnnot(buildCalloutReply(page, o, entry, parentRef));
    }
  }
}

// A thread turn as a standard Text reply: /IRT to the callout, /RT R —
// Acrobat and friends render that as a comment thread. pdf.js folds "R"
// replies into the parent's popup instead of painting a second icon, and
// Shiori suppresses its own annotations' canvas painting anyway, so the
// icon rect (tucked at the label corner) never actually draws. Role rides
// in the Shio dictionary; /T is only written for turns that carry a real
// author name, mirroring applySourceProvenance's no-invented-author rule.
function buildCalloutReply(
  page: PDFPage,
  o: CalloutOverlay,
  entry: CalloutThreadEntry,
  parentRef: PDFRef,
): PDFRef {
  const ctx = page.doc.context;
  const ICON = 20;
  const x = o.rect.x;
  const y = o.rect.y + o.rect.h - ICON;
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [x, y, x + ICON, y + ICON],
    Contents: PDFHexString.fromText(entry.text ?? ""),
    Name: "Comment",
    F: 4,
    RT: "R",
    NM: shioriAnnotationName(`${o.id}/reply/${entry.id}`),
  });
  dict.set(PDFName.of("IRT"), parentRef);
  if (entry.author) {
    dict.set(PDFName.of("T"), PDFHexString.fromText(entry.author));
  }
  if (typeof entry.at === "number") {
    const value = formatPdfDate(entry.at);
    if (value) {
      dict.set(PDFName.of("CreationDate"), PDFString.of(value));
      dict.set(PDFName.of("M"), PDFString.of(value));
    }
  }
  dict.set(
    PDFName.of("Shio"),
    ctx.obj({
      V: 1,
      Kind: "Reply",
      Role: entry.role === "agent" ? "Agent" : "User",
      ReplyId: PDFString.of(entry.id),
    }),
  );
  return ctx.register(dict);
}

// Writes back the review metadata captured at import (see OverlayCommon's
// source* fields). Overlays authored in Shiori carry none of these, so their
// annotations stay exactly as before — no invented author, no invented date.
function applySourceProvenance(page: PDFPage, o: Overlay, ref: PDFRef): void {
  const dict = page.doc.context.lookupMaybe(ref, PDFDict);
  if (!dict) return;
  if (o.sourceAuthor) {
    dict.set(PDFName.of("T"), PDFString.of(o.sourceAuthor));
  }
  if (typeof o.sourceCreatedAt === "number") {
    const value = formatPdfDate(o.sourceCreatedAt);
    if (value) dict.set(PDFName.of("CreationDate"), PDFString.of(value));
  }
  if (typeof o.sourceModifiedAt === "number") {
    const value = formatPdfDate(o.sourceModifiedAt);
    if (value) dict.set(PDFName.of("M"), PDFString.of(value));
  }
}

function linkReplyThreads(
  page: PDFPage,
  overlays: Overlay[],
  refsByOverlayId: Map<string, PDFRef>,
): void {
  for (const o of overlays) {
    if (!o.sourceInReplyToId) continue;
    const parentRef = refsByOverlayId.get(o.sourceInReplyToId);
    if (!parentRef) continue;
    const ownRef = refsByOverlayId.get(o.id);
    if (!ownRef) continue;
    const dict = page.doc.context.lookupMaybe(ownRef, PDFDict);
    if (!dict) continue;
    dict.set(PDFName.of("IRT"), parentRef);
    dict.set(PDFName.of("RT"), PDFName.of(o.sourceReplyType ?? "R"));
  }
}

// PDF date syntax: D:YYYYMMDDHHmmSSZ. Always emitted in UTC so the value does
// not depend on the exporting machine's time zone.
function formatPdfDate(epochMs: number): string | null {
  if (!Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function pickFreeTextFont(
  family: FontFamily,
  bold: boolean,
  italic: boolean,
  text: string,
  names: FreeTextFontNames,
): { entry: FreeTextFontEntry; family: FontFamily; bold: boolean; italic: boolean } {
  // Same routing rule as the flatten path in exportPdf.pickFont:
  // explicit bundled family first, then kana → JP and other
  // non-ASCII → SC. When we fall back to a CJK path font, keep the
  // requested family and bold flag in the DS hint for re-editing viewers.
  if (family === "notoSansJp" && !hasNonAscii(text) && names.unicodeJp) {
    return { entry: names.unicodeJp, family, bold, italic };
  }
  if (family === "notoSansSc" && !hasNonAscii(text) && names.unicode) {
    return { entry: names.unicode, family, bold, italic };
  }
  if ((family === "notoSansJp" || hasKana(text)) && names.unicodeJpPath) {
    return {
      entry: {
        ...names.helv,
        pathFont: pathFontWithFallback(
          names.unicodeJpPath,
          names.unicodePath,
        ),
      },
      family,
      bold,
      italic,
    };
  }
  if ((family === "notoSansJp" || hasKana(text)) && names.unicodeJp) {
    return { entry: names.unicodeJp, family, bold, italic };
  }
  if ((family === "notoSansSc" || hasNonAscii(text)) && names.unicodePath) {
    return {
      entry: {
        ...names.helv,
        pathFont: pathFontWithFallback(
          names.unicodePath,
          names.unicodeJpPath,
        ),
      },
      family,
      bold,
      italic,
    };
  }
  if ((family === "notoSansSc" || hasNonAscii(text)) && names.unicode) {
    return { entry: names.unicode, family, bold, italic };
  }
  if (family === "serif") {
    const entry =
      bold && italic
        ? names.timesBoldItalic
        : bold
          ? names.timesBold
          : italic
            ? names.timesItalic
            : names.times;
    return { entry, family, bold, italic };
  }
  if (family === "mono") {
    const entry =
      bold && italic
        ? names.courierBoldOblique
        : bold
          ? names.courierBold
          : italic
            ? names.courierOblique
            : names.courier;
    return { entry, family, bold, italic };
  }
  const entry =
    bold && italic
      ? names.helvBoldOblique
      : bold
        ? names.helvBold
        : italic
          ? names.helvOblique
          : names.helv;
  return { entry, family, bold, italic };
}

function pathFontWithFallback(
  primary: FontkitFont,
  fallback: FontkitFont | null,
): PathTextFont {
  if (!fallback || fallback === primary) return primary;
  return { primary, fallbacks: [fallback] };
}

function buildAnnotRef(
  page: PDFPage,
  o: Overlay,
  ensureFontNames: () => FreeTextFontNames,
): PDFRef | null {
  const ctx = page.doc.context;
  if (o.type === "highlight") return buildHighlight(page, o);
  if (o.type === "underline") return buildUnderline(page, o);
  if (o.type === "strikethrough") return buildStrikeOut(page, o);
  if (o.type === "note") return buildStickyNote(page, o);
  if (o.type === "rect") return buildSquare(page, o);
  if (o.type === "stamp") return buildStampFreeText(page, o, ensureFontNames().zapf.name);
  if (o.type === "ink") return buildInk(page, o);
  if (o.type === "text") {
    const picked = pickFreeTextFont(
      o.fontFamily,
      o.bold,
      Boolean(o.italic),
      o.text,
      ensureFontNames(),
    );
    return buildFreeText(page, o, picked);
  }
  if (o.type === "callout") {
    const picked = pickFreeTextFont(
      o.fontFamily,
      o.bold,
      Boolean(o.italic),
      o.text,
      ensureFontNames(),
    );
    return buildCallout(page, o, picked);
  }
  void ctx;
  return null;
}

// ---------------------------------------------------------------------------

function buildHighlight(page: PDFPage, o: HighlightOverlay): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  const bbox = unionRects(o.rects);
  const appearanceRef = buildHighlightAppearance(page, o, bbox);
  // QuadPoints: 8 numbers per rect, spec order: top-left, top-right,
  // bottom-left, bottom-right. The AP stream carries the visible rendering,
  // while spec-ordered quads give external editors a better text-markup target.
  const quads: number[] = [];
  for (const r of o.rects) {
    const l = r.x;
    const b = r.y;
    const ri = r.x + r.w;
    const t = r.y + r.h;
    quads.push(l, t, ri, t, l, b, ri, b);
  }
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h],
    QuadPoints: quads,
    C: color,
    CA: o.opacity,
    AP: ctx.obj({ N: appearanceRef }),
    F: 4,
    Contents: PDFString.of(""),
    Subj: PDFString.of("Highlight"),
    NM: shioriAnnotationName(o.id),
  });
  setShioAnchor(page, dict, o);
  return ctx.register(dict);
}

function buildUnderline(page: PDFPage, o: UnderlineOverlay): PDFRef {
  return buildTextLineMarkup(page, o, "Underline", underlinePdfY);
}

function buildStrikeOut(page: PDFPage, o: StrikeOutOverlay): PDFRef {
  return buildTextLineMarkup(page, o, "StrikeOut", strikethroughPdfY);
}

function buildTextLineMarkup(
  page: PDFPage,
  o: UnderlineOverlay | StrikeOutOverlay,
  subtype: "Underline" | "StrikeOut",
  lineY: (rect: { y: number; h: number }) => number,
): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  const bbox = unionRects(o.rects);
  const appearanceRef = buildTextLineMarkupAppearance(page, o, bbox, lineY);
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: subtype,
    Rect: [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h],
    QuadPoints: textMarkupQuadPoints(o.rects),
    C: color,
    CA: o.opacity,
    AP: ctx.obj({ N: appearanceRef }),
    F: 4,
    Contents: PDFString.of(""),
    Subj: PDFString.of(subtype),
    NM: shioriAnnotationName(o.id),
  });
  setShioAnchor(page, dict, o);
  return ctx.register(dict);
}

function textMarkupQuadPoints(
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): number[] {
  const quads: number[] = [];
  for (const r of rects) {
    const l = r.x;
    const b = r.y;
    const ri = r.x + r.w;
    const t = r.y + r.h;
    quads.push(l, t, ri, t, l, b, ri, b);
  }
  return quads;
}

function buildHighlightAppearance(
  page: PDFPage,
  o: HighlightOverlay,
  bbox: { x: number; y: number; w: number; h: number },
): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  const gsName = PDFName.of("GS0");
  const extGState = ctx.obj({});
  extGState.set(
    gsName,
    ctx.obj({
      Type: "ExtGState",
      ca: o.opacity,
      CA: o.opacity,
      BM: "Multiply",
    }),
  );
  const resources = ctx.obj({});
  resources.set(PDFName.ExtGState, extGState);
  const operators = [
    pushGraphicsState(),
    setGraphicsState(gsName),
    setFillingColor(rgb(color[0], color[1], color[2])),
  ];
  for (const r of o.rects) {
    operators.push(
      rectangle(r.x - bbox.x, r.y - bbox.y, r.w, r.h),
      fill(),
    );
  }
  operators.push(popGraphicsState());
  const stream = ctx.formXObject(operators, {
    Resources: resources,
    BBox: ctx.obj([0, 0, bbox.w, bbox.h]),
    Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
  });
  return ctx.register(stream);
}

function buildTextLineMarkupAppearance(
  page: PDFPage,
  o: UnderlineOverlay | StrikeOutOverlay,
  bbox: { x: number; y: number; w: number; h: number },
  lineY: (rect: { y: number; h: number }) => number,
): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  const gsName = PDFName.of("GS0");
  const extGState = ctx.obj({});
  extGState.set(
    gsName,
    ctx.obj({
      Type: "ExtGState",
      ca: o.opacity,
      CA: o.opacity,
    }),
  );
  const resources = ctx.obj({});
  resources.set(PDFName.ExtGState, extGState);
  const operators = [
    pushGraphicsState(),
    setGraphicsState(gsName),
    setStrokingColor(rgb(color[0], color[1], color[2])),
    setLineWidth(underlineStrokeWidth(o.rects)),
    setLineCap(LineCapStyle.Round),
  ];
  for (const r of o.rects) {
    const y = lineY(r) - bbox.y;
    operators.push(moveTo(r.x - bbox.x, y), lineTo(r.x + r.w - bbox.x, y));
  }
  operators.push(stroke(), popGraphicsState());
  const stream = ctx.formXObject(operators, {
    Resources: resources,
    BBox: ctx.obj([0, 0, bbox.w, bbox.h]),
    Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
  });
  return ctx.register(stream);
}

function buildStickyNote(page: PDFPage, o: NoteOverlay): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  // Sticky notes display as a small icon pinned at one corner — the body
  // text lives in /Contents, not in the rect. We anchor the icon to the
  // top-left of the note's drawn rect so its position on the page matches
  // what the user saw while editing.
  const ICON = 20;
  const x = o.rect.x;
  const y = o.rect.y + o.rect.h - ICON;
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [x, y, x + ICON, y + ICON],
    Contents: PDFHexString.fromText(o.text ?? ""),
    Name: "Note",
    C: color,
    F: 4,
    Open: false,
    NM: shioriAnnotationName(o.id),
  });
  setShioAnchor(page, dict, o);
  return ctx.register(dict);
}

function buildSquare(page: PDFPage, o: RectOverlay): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: "Square",
    Rect: [o.rect.x, o.rect.y, o.rect.x + o.rect.w, o.rect.y + o.rect.h],
    C: color,
    BS: ctx.obj({ W: o.strokeWidth }),
    F: 4,
    NM: shioriAnnotationName(o.id),
  });
  if (o.fill) {
    dict.set(PDFName.of("IC"), ctx.obj(hexToRgbArr(o.fill)));
  }
  return ctx.register(dict);
}

function buildStampFreeText(
  page: PDFPage,
  o: StampOverlay,
  fontName: PDFName,
): PDFRef {
  const ctx = page.doc.context;
  const [r, g, b] = hexToRgbArr(o.color);
  const size = Math.max(6, o.rect.h * 0.9);
  const da = `${fontName.asString()} ${fmt(size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`;
  const appearanceRef = buildStampAppearance(page, o);
  return ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "FreeText",
      Rect: [o.rect.x, o.rect.y, o.rect.x + o.rect.w, o.rect.y + o.rect.h],
      Contents: PDFHexString.fromText(stampGlyph(o.kind)),
      DA: PDFString.of(da),
      AP: ctx.obj({ N: appearanceRef }),
      C: [r, g, b],
      BS: ctx.obj({ W: o.strokeWidth }),
      Q: 1,
      F: 4,
      NM: shioriAnnotationName(o.id),
    }),
  );
}

function buildStampAppearance(page: PDFPage, o: StampOverlay): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  const paths = stampPaths(o.kind, o.rect.w, o.rect.h);
  const operators = [
    pushGraphicsState(),
    setStrokingColor(rgb(color[0], color[1], color[2])),
    setLineWidth(o.strokeWidth),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
  ];
  for (const path of paths) {
    const [first, ...rest] = path;
    if (!first) continue;
    operators.push(moveTo(first.x, first.y));
    for (const point of rest) {
      operators.push(lineTo(point.x, point.y));
    }
  }
  operators.push(stroke(), popGraphicsState());
  const stream = ctx.formXObject(operators, {
    BBox: ctx.obj([0, 0, o.rect.w, o.rect.h]),
    Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
  });
  return ctx.register(stream);
}

function buildInk(page: PDFPage, o: InkOverlay): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  const flat = o.paths.flat();
  if (flat.length === 0) {
    // Defensive: shouldn't happen because OverlayLayer drops <2-point
    // strokes, but register a degenerate rect to avoid a PDF with a
    // malformed /InkList.
    const dict = ctx.obj({
      Type: "Annot",
      Subtype: "Ink",
      Rect: [0, 0, 0, 0],
      InkList: [[]],
      C: color,
      BS: ctx.obj({ W: o.width }),
      F: 4,
      NM: shioriAnnotationName(o.id),
    });
    return ctx.register(dict);
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of flat) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const inkList = o.paths.map((path) => path.flatMap((p) => [p.x, p.y]));
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: "Ink",
    Rect: [minX, minY, maxX, maxY],
    InkList: inkList,
    C: color,
    BS: ctx.obj({ W: o.width }),
    F: 4,
    NM: shioriAnnotationName(o.id),
  });
  return ctx.register(dict);
}

function buildFreeText(
  page: PDFPage,
  o: TextOverlay,
  picked: { entry: FreeTextFontEntry; family: FontFamily; bold: boolean; italic: boolean },
): PDFRef {
  const ctx = page.doc.context;
  const [r, g, b] = hexToRgbArr(o.color);
  // DA is a content-stream snippet: font-op, then color-op. The font
  // operator takes the encoded name (with leading slash) as produced by
  // PDFName.asString().
  const da = `${picked.entry.name.asString()} ${o.fontSize} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`;
  const q = o.align === "center" ? 1 : o.align === "right" ? 2 : 0;
  const appearanceRef = buildFreeTextAppearance(page, o, picked);
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: "FreeText",
    Rect: [o.rect.x, o.rect.y, o.rect.x + o.rect.w, o.rect.y + o.rect.h],
    Contents: PDFHexString.fromText(o.text ?? ""),
    DA: PDFString.of(da),
    AP: ctx.obj({ N: appearanceRef }),
    Q: q,
    F: 4,
    NM: shioriAnnotationName(o.id),
  });
  // Viewers that honor DS (rich-text default style) use it for bold
  // and family hints. Optional — Adobe ignores it when DA is present,
  // but Foxit and PDF Expert use it to recover family + weight when
  // re-opening the annotation for editing.
  const cssFamily = freeTextCssFamily(picked.family);
  // /Q remains the alignment source for conventional PDF viewers. pdf.js
  // does not expose /Q on FreeText annotations, so mirror the full requested
  // style in standards-compatible XHTML as well. Keep the PDF string ASCII:
  // some readers pass its raw bytes directly to an XML parser instead of
  // decoding UTF-16BE first.
  dict.set(
    PDFName.of("RC"),
    PDFString.of(richText(o.text, o.fontSize, o.color, picked, o.align)),
  );
  if (picked.bold || picked.italic || picked.family !== "sans") {
    dict.set(
      PDFName.of("DS"),
      PDFString.of(
        `font: ${picked.italic ? "italic " : ""}${picked.bold ? "bold " : ""}${o.fontSize}pt ${cssFamily}`,
      ),
    );
  }
  return ctx.register(dict);
}

function buildCallout(
  page: PDFPage,
  o: CalloutOverlay,
  picked: { entry: FreeTextFontEntry; family: FontFamily; bold: boolean; italic: boolean },
): PDFRef {
  const ctx = page.doc.context;
  const [r, g, b] = hexToRgbArr(o.color);
  const da = `${picked.entry.name.asString()} ${fmt(o.fontSize)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`;
  const q = o.align === "center" ? 1 : o.align === "right" ? 2 : 0;
  const connector = calloutConnectorGeometry(o);
  const outer = calloutOuterRect(o, connector);
  const appearanceRef = buildCalloutAppearance(page, o, picked, outer, connector);
  const labelRight = o.rect.x + o.rect.w;
  const labelTop = o.rect.y + o.rect.h;
  const outerRight = outer.x + outer.w;
  const outerTop = outer.y + outer.h;
  const semanticLeader = [
    connector.to.x,
    connector.to.y,
    connector.control.x,
    connector.control.y,
    connector.from.x,
    connector.from.y,
  ];
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: "FreeText",
    IT: "FreeTextCallout",
    Rect: [outer.x, outer.y, outerRight, outerTop],
    RD: [
      o.rect.x - outer.x,
      outerTop - labelTop,
      outerRight - labelRight,
      o.rect.y - outer.y,
    ],
    CL: semanticLeader,
    LE: "OpenArrow",
    Contents: PDFHexString.fromText(o.text ?? ""),
    DA: PDFString.of(da),
    RC: PDFString.of(richText(o.text, o.fontSize, o.color, picked, o.align)),
    Q: q,
    C: [r, g, b],
    BS: ctx.obj({ Type: "Border", W: 1.25, S: "S" }),
    AP: ctx.obj({ N: appearanceRef }),
    F: 4,
    Subj: PDFString.of("Callout"),
    NM: shioriAnnotationName(o.id),
  });

  // A FreeText callout has one standard target point. Shiori's versioned
  // developer dictionary preserves the richer target rectangles and exact
  // label geometry without changing how other PDF viewers interpret it.
  dict.set(
    PDFName.of("Shio"),
    ctx.obj({
      V: 1,
      Kind: "Callout",
      TargetRects: o.targetRects.map((rect) => [
        rect.x,
        rect.y,
        rect.w,
        rect.h,
      ]),
      LabelRect: [o.rect.x, o.rect.y, o.rect.w, o.rect.h],
      Leader: semanticLeader,
      LeaderKind: connector.kind === "polyline" ? "Polyline" : "Quadratic",
    }),
  );
  setShioAnchor(page, dict, o);
  return ctx.register(dict);
}

function calloutOuterRect(
  o: CalloutOverlay,
  connector: ReturnType<typeof calloutConnectorGeometry>,
): { x: number; y: number; w: number; h: number } {
  const points = [
    connector.from,
    connector.control,
    connector.to,
    connector.arrowLeft,
    connector.arrowRight,
  ];
  const pathX = points.map((point) => point.x);
  const pathY = points.map((point) => point.y);
  const pathRect = {
    x: Math.min(...pathX),
    y: Math.min(...pathY),
    w: Math.max(...pathX) - Math.min(...pathX),
    h: Math.max(...pathY) - Math.min(...pathY),
  };
  const union = unionRects([o.rect, ...o.targetRects, pathRect]);
  const margin = 2.5;
  return {
    x: union.x - margin,
    y: union.y - margin,
    w: union.w + margin * 2,
    h: union.h + margin * 2,
  };
}

function buildCalloutAppearance(
  page: PDFPage,
  o: CalloutOverlay,
  picked: { entry: FreeTextFontEntry; family: FontFamily; bold: boolean; italic: boolean },
  outer: { x: number; y: number; w: number; h: number },
  connector: ReturnType<typeof calloutConnectorGeometry>,
): PDFRef {
  const ctx = page.doc.context;
  const font = picked.entry;
  const color = hexToRgbArr(o.color);
  const ox = (x: number) => x - outer.x;
  const oy = (y: number) => y - outer.y;
  const gsName = PDFName.of("GS0");
  const extGState = ctx.obj({});
  extGState.set(
    gsName,
    ctx.obj({ Type: "ExtGState", ca: CALLOUT_TARGET_OPACITY, CA: 1, BM: "Multiply" }),
  );

  const operators = [
    pushGraphicsState(),
    setGraphicsState(gsName),
    setFillingColor(rgb(color[0], color[1], color[2])),
  ];
  for (const target of o.targetRects) {
    operators.push(
      rectangle(ox(target.x), oy(target.y), target.w, target.h),
      fill(),
    );
  }
  const c1 = {
    x: connector.from.x + (connector.control.x - connector.from.x) * (2 / 3),
    y: connector.from.y + (connector.control.y - connector.from.y) * (2 / 3),
  };
  const c2 = {
    x: connector.to.x + (connector.control.x - connector.to.x) * (2 / 3),
    y: connector.to.y + (connector.control.y - connector.to.y) * (2 / 3),
  };
  const leaderOperators =
    connector.kind === "polyline"
      ? [
          lineTo(ox(connector.control.x), oy(connector.control.y)),
          lineTo(ox(connector.to.x), oy(connector.to.y)),
        ]
      : [
          appendBezierCurve(
            ox(c1.x),
            oy(c1.y),
            ox(c2.x),
            oy(c2.y),
            ox(connector.to.x),
            oy(connector.to.y),
          ),
        ];
  operators.push(
    popGraphicsState(),
    pushGraphicsState(),
    setStrokingColor(rgb(color[0], color[1], color[2])),
    setLineWidth(1.25),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(ox(connector.from.x), oy(connector.from.y)),
    ...leaderOperators,
    moveTo(ox(connector.to.x), oy(connector.to.y)),
    lineTo(ox(connector.arrowLeft.x), oy(connector.arrowLeft.y)),
    moveTo(ox(connector.to.x), oy(connector.to.y)),
    lineTo(ox(connector.arrowRight.x), oy(connector.arrowRight.y)),
    stroke(),
    popGraphicsState(),
    pushGraphicsState(),
    setFillingColor(rgb(1, 0.992, 0.973)),
    rectangle(ox(o.rect.x), oy(o.rect.y), o.rect.w, o.rect.h),
    fill(),
    setStrokingColor(rgb(color[0], color[1], color[2])),
    setLineWidth(0.8),
    rectangle(ox(o.rect.x), oy(o.rect.y), o.rect.w, o.rect.h),
    stroke(),
    popGraphicsState(),
    beginText(),
    setFontAndSize(font.name, o.fontSize),
    setFillingColor(rgb(color[0], color[1], color[2])),
    endText(),
    pushGraphicsState(),
    rectangle(ox(o.rect.x), oy(o.rect.y), o.rect.w, o.rect.h),
    clip(),
    endPath(),
  );

  const lineHeight = o.fontSize * 1.2;
  const textRect = {
    x: o.rect.x + CALLOUT_LABEL_PADDING_X_PT,
    y: o.rect.y + CALLOUT_LABEL_PADDING_Y_PT,
    w: Math.max(1, o.rect.w - CALLOUT_LABEL_PADDING_X_PT * 2),
    h: Math.max(1, o.rect.h - CALLOUT_LABEL_PADDING_Y_PT * 2),
  };
  const lines = wrapText(
    normalizeFreeTextAppearanceText(o.text ?? ""),
    font.font,
    o.fontSize,
    textRect.w,
    font.pathFont,
  );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const textWidth = measureTextWidth(font.font, line, o.fontSize, font.pathFont);
    let x = ox(textRect.x);
    if (o.align === "center") x += (textRect.w - textWidth) / 2;
    else if (o.align === "right") x += textRect.w - textWidth;
    const y =
      oy(textRect.y) +
      textRect.h -
      (index + 1) * lineHeight +
      (lineHeight - o.fontSize) / 2;
    if (y < oy(textRect.y) - lineHeight) break;
    const syntheticItalic = usesSyntheticFreeTextItalic(picked, line);
    if (font.pathFont && hasNonAscii(line)) {
      operators.push(
        ...drawPathText(
          font.pathFont,
          line,
          x,
          y,
          o.fontSize,
          color,
          syntheticItalic,
        ),
      );
    } else {
      operators.push(
        ...drawTextOperators(font.font.encodeText(line), {
          x,
          y,
          size: o.fontSize,
          font: font.name,
          color: rgb(color[0], color[1], color[2]),
          rotate: degrees(0),
          xSkew: degrees(0),
          ySkew: syntheticItalic
            ? degrees(SYNTHETIC_ITALIC_DEGREES)
            : degrees(0),
        }),
      );
    }
  }
  operators.push(popGraphicsState());

  const fontDict = ctx.obj({});
  fontDict.set(font.name, font.font.ref);
  const resources = ctx.obj({});
  resources.set(PDFName.Font, fontDict);
  resources.set(PDFName.ExtGState, extGState);
  const stream = ctx.formXObject(operators, {
    Resources: resources,
    BBox: ctx.obj([0, 0, outer.w, outer.h]),
    Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
  });
  return ctx.register(stream);
}

function freeTextCssFamily(family: FontFamily): string {
  if (family === "notoSansSc") return "'Noto Sans SC', sans-serif";
  if (family === "notoSansJp") return "'Noto Sans JP', sans-serif";
  if (family === "serif") return "serif";
  if (family === "mono") return "monospace";
  return "sans-serif";
}

function buildFreeTextAppearance(
  page: PDFPage,
  o: TextOverlay,
  picked: { entry: FreeTextFontEntry; family: FontFamily; bold: boolean; italic: boolean },
): PDFRef {
  const ctx = page.doc.context;
  const font = picked.entry;
  const color = hexToRgbArr(o.color);
  const lineHeight = o.fontSize * 1.2;
  const appearanceText = normalizeFreeTextAppearanceText(o.text ?? "");
  const lines = wrapText(
    appearanceText,
    font.font,
    o.fontSize,
    o.rect.w,
    font.pathFont,
  );
  const operators = [
    // pdf.js derives FreeText editing style from /AP when an appearance
    // exists, overriding /DA. Path-rendered CJK has no text operators and
    // keeps its color inside q/Q, so pdf.js otherwise falls back to 10pt
    // black. This empty text-state marker exposes the semantic style without
    // painting an extra glyph; the vector paths remain the visible appearance
    // for cross-viewer CJK compatibility.
    beginText(),
    setFontAndSize(font.name, o.fontSize),
    setFillingColor(rgb(color[0], color[1], color[2])),
    endText(),
    pushGraphicsState(),
    rectangle(0, 0, o.rect.w, o.rect.h),
    clip(),
    endPath(),
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const textWidth = measureTextWidth(font.font, line, o.fontSize, font.pathFont);
    let x = 0;
    if (o.align === "center") x = (o.rect.w - textWidth) / 2;
    else if (o.align === "right") x = o.rect.w - textWidth;
    const y = o.rect.h - (i + 1) * lineHeight + (lineHeight - o.fontSize) / 2;
    if (y < -lineHeight) break;
    const syntheticItalic = usesSyntheticFreeTextItalic(picked, line);
    if (font.pathFont && hasNonAscii(line)) {
      operators.push(
        ...drawPathText(
          font.pathFont,
          line,
          x,
          y,
          o.fontSize,
          color,
          syntheticItalic,
        ),
      );
    } else {
      operators.push(
        ...drawTextOperators(font.font.encodeText(line), {
          x,
          y,
          size: o.fontSize,
          font: font.name,
          color: rgb(color[0], color[1], color[2]),
          rotate: degrees(0),
          xSkew: degrees(0),
          ySkew: syntheticItalic
            ? degrees(SYNTHETIC_ITALIC_DEGREES)
            : degrees(0),
        }),
      );
    }
  }

  operators.push(popGraphicsState());

  const fontDict = ctx.obj({});
  fontDict.set(font.name, font.font.ref);
  const resources = ctx.obj({});
  resources.set(PDFName.Font, fontDict);
  const stream = ctx.formXObject(operators, {
    Resources: resources,
    BBox: ctx.obj([0, 0, o.rect.w, o.rect.h]),
    Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
  });
  return ctx.register(stream);
}

function usesSyntheticFreeTextItalic(
  picked: { family: FontFamily; italic: boolean },
  line: string,
): boolean {
  return (
    picked.italic &&
    (picked.family === "notoSansSc" ||
      picked.family === "notoSansJp" ||
      hasNonAscii(line))
  );
}

function stampGlyph(kind: StampOverlay["kind"]): string {
  return kind === "check" ? "✓" : "✗";
}

function stampPaths(
  kind: StampOverlay["kind"],
  width: number,
  height: number,
): Array<Array<{ x: number; y: number }>> {
  const pt = (rx: number, ry: number) => ({ x: width * rx, y: height * ry });
  if (kind === "cross") {
    return [
      [pt(0.18, 0.18), pt(0.82, 0.82)],
      [pt(0.82, 0.18), pt(0.18, 0.82)],
    ];
  }
  return [[pt(0.15, 0.52), pt(0.42, 0.28), pt(0.85, 0.76)]];
}

// ---------------------------------------------------------------------------

function hexToRgbArr(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.length === 6
        ? h
        : "000000";
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

function unionRects(
  rects: { x: number; y: number; w: number; h: number }[],
): { x: number; y: number; w: number; h: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function underlineStrokeWidth(
  rects: Array<{ h: number }>,
): number {
  const minHeight = Math.min(...rects.map((r) => r.h).filter((h) => h > 0));
  if (!Number.isFinite(minHeight)) return 1;
  return Math.max(0.75, Math.min(2, minHeight * 0.08));
}

function underlinePdfY(rect: { y: number; h: number }): number {
  return rect.y + Math.max(0.75, Math.min(2, rect.h * 0.12));
}

function strikethroughPdfY(rect: { y: number; h: number }): number {
  return rect.y + rect.h * 0.45;
}

function fmt(n: number): string {
  // Trim to 4 decimals — full float precision bloats the PDF and most
  // viewers truncate anyway. Also strips trailing zeros.
  return Number(n.toFixed(4)).toString();
}

function stripReplaceableAnnotationsFromPage(page: PDFPage): boolean {
  const annots = page.node.Annots();
  if (!annots) return false;

  let removedAny = false;
  const removedRefs = new Set<string>();
  for (let i = annots.size() - 1; i >= 0; i--) {
    const raw = annots.get(i);
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    if (!isReplaceableAnnotation(dict)) continue;
    annots.remove(i);
    removedAny = true;
    if (raw instanceof PDFRef) {
      removedRefs.add(raw.toString());
      page.doc.context.delete(raw);
    }
  }
  // A /Popup is the pop-up window OF a markup annotation and points at it via
  // /Parent. Popups are not in REPLACED_SOURCE_SUBTYPES, so removing a Text or
  // Highlight used to leave its popup behind holding a reference to an object
  // that no longer exists.
  if (removedAny) removeOrphanedPopups(page, annots, removedRefs);
  if (removedAny) stripShioriFontResources(page);
  return removedAny;
}

function removeOrphanedPopups(
  page: PDFPage,
  annots: PDFArray,
  removedRefs: Set<string>,
): void {
  for (let i = annots.size() - 1; i >= 0; i--) {
    const raw = annots.get(i);
    const dict = annots.lookupMaybe(i, PDFDict);
    if (!dict) continue;
    const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
    if (subtype !== "Popup") continue;
    const parent = dict.get(PDFName.of("Parent"));
    if (!(parent instanceof PDFRef)) continue;
    if (!removedRefs.has(parent.toString())) continue;
    annots.remove(i);
    if (raw instanceof PDFRef) page.doc.context.delete(raw);
  }
}

function isReplaceableAnnotation(dict: PDFDict): boolean {
  const name = decodePdfText(dict.lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString));
  // Written by Shiori: always ours to replace, whatever its current state.
  if (name.startsWith(SHIORI_ANNOT_PREFIX)) return true;
  const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText();
  if (!subtype || !REPLACED_SOURCE_SUBTYPES.has(subtype)) return false;
  // Matching subtype is not enough. Removal is only safe for annotations the
  // editor actually took ownership of, and it only ever saw the ones pdf.js
  // handed over. Anything pdf.js filtered out was never drawn, never became an
  // overlay, and is not re-added on export — so removing it would delete it
  // from the user's file permanently, with no undo (the overlay model never
  // held it). Deliberately NOT keyed on "is it in the model right now":
  // deleting an imported annotation removes it from the model, and that
  // deletion still has to reach the file.
  return pdfjsWouldHaveImported(dict, subtype);
}

// Only what the importer was handed became an overlay; the file reader's
// display filter (pdf.js's) decides that.
const pdfjsWouldHaveImported = isListedForImport;


function shioriAnnotationName(id: string): PDFString {
  return PDFString.of(`${SHIORI_ANNOT_PREFIX}${id}`);
}

// Anchor provenance rides in Shiori's versioned developer dictionary: for a
// callout it joins the Shio dict buildCallout already writes; markups and
// sticky notes get a minimal `Shio: { V: 1, Anchor: {...} }`. Standard
// viewers ignore unknown developer dictionaries, so appearance is untouched.
function setShioAnchor(
  page: PDFPage,
  dict: PDFDict,
  o: { anchor?: OverlayTextAnchor },
): void {
  const anchor = o.anchor;
  if (!anchor) return;
  const ctx = page.doc.context;
  const existing = dict.lookupMaybe(PDFName.of("Shio"), PDFDict);
  const shio = existing ?? (ctx.obj({ V: 1 }) as PDFDict);
  shio.set(
    PDFName.of("Anchor"),
    ctx.obj({
      Q: PDFHexString.fromText(anchor.quote),
      Pg: anchor.page,
      // Optional: in-app selection capture records no occurrence.
      ...(anchor.occurrence !== undefined ? { Occ: anchor.occurrence } : {}),
    }),
  );
  if (!existing) dict.set(PDFName.of("Shio"), shio);
}

function decodePdfText(value: PDFString | PDFHexString | undefined): string {
  try {
    return value?.decodeText() ?? "";
  } catch {
    return "";
  }
}

function richText(
  text: string,
  fontSize: number,
  color: string,
  picked: { family: FontFamily; bold: boolean; italic: boolean },
  align: TextOverlay["align"],
): string {
  const cssFamily = freeTextCssFamily(picked.family);
  const direction = baseTextDirection(text);
  const [r, g, b] = hexToRgbArr(color).map((channel) => Math.round(channel * 255));
  const style = [
    `font:${picked.italic ? "italic" : "normal"} ${picked.bold ? "bold" : "normal"} ${fmt(fontSize)}pt ${cssFamily}`,
    `font-family:${cssFamily}`,
    `font-size:${fmt(fontSize)}pt`,
    `font-weight:${picked.bold ? "bold" : "normal"}`,
    `font-style:${picked.italic ? "italic" : "normal"}`,
    `text-align:${align}`,
    `direction:${direction}`,
    `color:rgb(${r},${g},${b})`,
  ].join(";");
  return [
    '<?xml version="1.0"?>',
    `<body xmlns="http://www.w3.org/1999/xhtml" style="${escapeXml(style)}">`,
    `<p dir="${direction}">${escapeXml(text)}</p>`,
    "</body>",
  ].join("");
}

function normalizeFreeTextAppearanceText(text: string): string {
  return text
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll("\t", "    ")
    // Preserve the exact source in /Contents. Appearance streams cannot
    // encode C0/C1 controls through Standard-14 fonts, so draw a visible,
    // deterministic placeholder instead of throwing during export.
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "?");
}

function escapeXml(s: string): string {
  let escaped = "";
  for (const ch of s) {
    if (ch === "&") escaped += "&amp;";
    else if (ch === "<") escaped += "&lt;";
    else if (ch === ">") escaped += "&gt;";
    else if (ch === '"') escaped += "&quot;";
    else {
      const codePoint = ch.codePointAt(0)!;
      const validXmlCodePoint =
        codePoint === 0x9 ||
        codePoint === 0xa ||
        codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff);
      if (!validXmlCodePoint) escaped += "&#xFFFD;";
      else if (codePoint > 0x7e) {
        escaped += `&#x${codePoint.toString(16).toUpperCase()};`;
      } else escaped += ch;
    }
  }
  return escaped;
}

function stripShioriFontResources(page: PDFPage): void {
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.Font, PDFDict);
  if (!fonts) return;
  for (const key of fonts.keys()) {
    const name = key.decodeText();
    if (SHIORI_FONT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      fonts.delete(key);
    }
  }
}
