// FreeText callouts: the label, leader and target highlight drawn as one
// FreeTextCallout annotation, plus the /IRT Text replies its conversation
// turns become. Split out of ./annotations.

import {
  LineCapStyle,
  LineJoinStyle,
  PDFHexString,
  PDFName,
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
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import type { CalloutOverlay, CalloutThreadEntry } from "../model/types";
import {
  CALLOUT_LABEL_PADDING_X_PT,
  CALLOUT_LABEL_PADDING_Y_PT,
  CALLOUT_TARGET_OPACITY,
  calloutConnectorGeometry,
} from "../model/callout";
import {
  SYNTHETIC_ITALIC_DEGREES,
  usesSyntheticFreeTextItalic,
  type FontFamily,
  type FreeTextFontEntry,
} from "./annotationFonts";
import {
  fmt,
  formatPdfDate,
  hexToRgbArr,
  setShioAnchor,
  shioriAnnotationName,
  unionRects,
} from "./annotationShared";
import { normalizeFreeTextAppearanceText, richText } from "./freeTextAnnotations";
import { hasNonAscii } from "./textScripts";
import { measureTextWidth, wrapText } from "./textWrap";
import { drawPathText } from "./vectorText";

// A thread turn as a standard Text reply: /IRT to the callout, /RT R —
// Acrobat and friends render that as a comment thread. pdf.js folds "R"
// replies into the parent's popup instead of painting a second icon, and
// Shiori suppresses its own annotations' canvas painting anyway, so the
// icon rect (tucked at the label corner) never actually draws. Role rides
// in the Shio dictionary; /T is only written for turns that carry a real
// author name, mirroring applySourceProvenance's no-invented-author rule.
export function buildCalloutReply(
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
    Name: entry.sourceIcon || "Comment",
    F: replyFlags(entry.sourceFlags),
    RT: "R",
    NM: shioriAnnotationName(`${o.id}/reply/${entry.id}`),
  });
  dict.set(PDFName.of("IRT"), parentRef);
  // What an imported reply became in another reader (see ReplySourceField).
  if (typeof entry.sourceOpen === "boolean") dict.set(PDFName.of("Open"), ctx.obj(entry.sourceOpen));
  if (entry.sourceState && entry.sourceStateModel) {
    dict.set(PDFName.of("State"), PDFHexString.fromText(entry.sourceState));
    dict.set(PDFName.of("StateModel"), PDFHexString.fromText(entry.sourceStateModel));
  }
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

/** An imported reply's /F as it was, else Print. */
function replyFlags(flags: number | undefined): number {
  return typeof flags === "number" && Number.isInteger(flags) && flags >= 0 ? flags : 4;
}

export function buildCallout(
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
