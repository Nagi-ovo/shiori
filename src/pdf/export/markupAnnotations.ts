// Text markup (highlight, underline, strike-out), sticky notes, squares and
// ink: the annotation dictionaries and appearance streams for overlays that
// carry no text layout of their own. Split out of ./annotations.

import {
  LineCapStyle,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingColor,
  setGraphicsState,
  setLineCap,
  setLineWidth,
  setStrokingColor,
  stroke,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import type {
  HighlightOverlay,
  InkOverlay,
  NoteOverlay,
  RectOverlay,
  StrikeOutOverlay,
  UnderlineOverlay,
} from "../model/types";
import {
  freeRotation,
  hexToRgbArr,
  setShioAnchor,
  shioriAnnotationName,
  unionRects,
  type FreeRotation,
} from "./annotationShared";

export function buildHighlight(page: PDFPage, o: HighlightOverlay): PDFRef {
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
    Contents: commentContents(o),
    Subj: PDFString.of("Highlight"),
    NM: shioriAnnotationName(o.id),
  });
  setShioAnchor(page, dict, o);
  return ctx.register(dict);
}

// The comment imported with the annotation, as a text string (UTF-16BE, so
// a CJK note survives). Markup always carried an empty /Contents; that stays
// when there is nothing to write.
function commentContents(o: { comment?: string }): PDFString | PDFHexString {
  return o.comment ? PDFHexString.fromText(o.comment) : PDFString.of("");
}

export function buildUnderline(page: PDFPage, o: UnderlineOverlay): PDFRef {
  return buildTextLineMarkup(page, o, "Underline", underlinePdfY);
}

export function buildStrikeOut(page: PDFPage, o: StrikeOutOverlay): PDFRef {
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
    Contents: commentContents(o),
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

export function buildStickyNote(page: PDFPage, o: NoteOverlay): PDFRef {
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
    Name: o.sourceIcon || "Note",
    C: color,
    F: 4,
    Open: o.sourceOpen ?? false,
    NM: shioriAnnotationName(o.id),
  });
  if (o.sourceState && o.sourceStateModel) {
    dict.set(PDFName.of("State"), PDFHexString.fromText(o.sourceState));
    dict.set(PDFName.of("StateModel"), PDFHexString.fromText(o.sourceStateModel));
  }
  setShioAnchor(page, dict, o);
  return ctx.register(dict);
}

export function buildSquare(page: PDFPage, o: RectOverlay): PDFRef {
  const ctx = page.doc.context;
  const color = hexToRgbArr(o.color);
  const turn = freeRotation(o.rect, o.angle);
  const dict = ctx.obj({
    Type: "Annot",
    Subtype: "Square",
    Rect: turn?.rect ?? [o.rect.x, o.rect.y, o.rect.x + o.rect.w, o.rect.y + o.rect.h],
    C: color,
    BS: ctx.obj({ W: o.strokeWidth }),
    F: 4,
    NM: shioriAnnotationName(o.id),
  });
  if (o.fill) {
    dict.set(PDFName.of("IC"), ctx.obj(hexToRgbArr(o.fill)));
  }
  if (o.comment) dict.set(PDFName.of("Contents"), commentContents(o));
  setOpacity(dict, o);
  if (turn) dict.set(PDFName.of("AP"), ctx.obj({ N: buildTurnedSquareAppearance(page, o, turn) }));
  return ctx.register(dict);
}

// A Square has no rotation of its own, and a viewer draws one without an
// appearance square to its /Rect. A turned one gets an appearance turned by
// its /Matrix, drawn as viewers draw a Square: the border inside the box.
function buildTurnedSquareAppearance(page: PDFPage, o: RectOverlay, turn: FreeRotation): PDFRef {
  const ctx = page.doc.context;
  const [r, g, b] = hexToRgbArr(o.color);
  const width = Math.max(0, Math.min(o.strokeWidth, o.rect.w, o.rect.h));
  const resources = ctx.obj({});
  const operators = [pushGraphicsState()];
  if (typeof o.opacity === "number" && o.opacity < 1) {
    const alpha = Math.max(0, o.opacity);
    resources.set(PDFName.ExtGState, ctx.obj({ GS0: ctx.obj({ Type: "ExtGState", CA: alpha, ca: alpha }) }));
    operators.push(setGraphicsState(PDFName.of("GS0")));
  }
  if (o.fill) {
    const [fr, fg, fb] = hexToRgbArr(o.fill);
    operators.push(setFillingColor(rgb(fr, fg, fb)), rectangle(0, 0, o.rect.w, o.rect.h), fill());
  }
  if (width > 0) {
    operators.push(
      setStrokingColor(rgb(r, g, b)),
      setLineWidth(width),
      rectangle(width / 2, width / 2, o.rect.w - width, o.rect.h - width),
      stroke(),
    );
  }
  operators.push(popGraphicsState());
  const stream = ctx.formXObject(operators, {
    Resources: resources,
    BBox: ctx.obj([0, 0, o.rect.w, o.rect.h]),
    Matrix: ctx.obj(turn.matrix),
  });
  return ctx.register(stream);
}

// /CA for a translucent square or ink; none for an opaque one, as before.
function setOpacity(dict: PDFDict, o: { opacity?: number }): void {
  if (typeof o.opacity !== "number" || !Number.isFinite(o.opacity) || o.opacity >= 1) return;
  dict.set(PDFName.of("CA"), PDFNumber.of(Math.max(0, o.opacity)));
}

export function buildInk(page: PDFPage, o: InkOverlay): PDFRef {
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
  if (o.comment) dict.set(PDFName.of("Contents"), commentContents(o));
  setOpacity(dict, o);
  return ctx.register(dict);
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
