// FreeText annotations: text boxes and check / cross stamps, with their
// appearance streams and the rich-text (/RC) body. Split out of ./annotations.

import {
  LineCapStyle,
  LineJoinStyle,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
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
import type { StampOverlay, TextOverlay } from "../model/types";
import {
  SYNTHETIC_ITALIC_DEGREES,
  freeTextCssFamily,
  usesSyntheticFreeTextItalic,
  type FontFamily,
  type FreeTextFontEntry,
} from "./annotationFonts";
import { fmt, hexToRgbArr, shioriAnnotationName } from "./annotationShared";
import { baseTextDirection, hasNonAscii } from "./textScripts";
import { measureTextWidth, wrapText } from "./textWrap";
import { drawPathText } from "./vectorText";

export function buildStampFreeText(
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

export function buildFreeText(
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
  if (o.fill) dict.set(PDFName.of("C"), ctx.obj(hexToRgbArr(o.fill)));
  if (o.borderWidth !== undefined) {
    dict.set(PDFName.of("BS"), ctx.obj({ W: o.borderWidth }));
  }
  const opacity = freeTextOpacity(o);
  if (opacity !== undefined) dict.set(PDFName.of("CA"), PDFNumber.of(opacity));
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
  const gsName = PDFName.of("GS0");
  const alpha = freeTextOpacity(o);
  const opacity = alpha !== undefined && alpha < 1;
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
    ...freeTextBoxOperators(o, opacity ? gsName : null),
    pushGraphicsState(),
    ...(opacity ? [setGraphicsState(gsName)] : []),
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
  if (opacity) {
    const extGState = ctx.obj({});
    extGState.set(gsName, ctx.obj({ Type: "ExtGState", ca: alpha, CA: alpha }));
    resources.set(PDFName.ExtGState, extGState);
  }
  const stream = ctx.formXObject(operators, {
    Resources: resources,
    BBox: ctx.obj([0, 0, o.rect.w, o.rect.h]),
    Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
  });
  return ctx.register(stream);
}

function freeTextOpacity(o: TextOverlay): number | undefined {
  if (typeof o.opacity !== "number" || !Number.isFinite(o.opacity)) return undefined;
  return Math.min(1, Math.max(0, o.opacity));
}

// An imported box's fill and frame, under the text. Kept inside q/Q: pdf.js
// reads the FreeText style from the appearance's top-level operators only,
// so these colours never pass for the text colour.
function freeTextBoxOperators(o: TextOverlay, gsName: PDFName | null) {
  const border = o.borderWidth ?? 0;
  if (!o.fill && border <= 0) return [];
  const operators = [pushGraphicsState(), ...(gsName ? [setGraphicsState(gsName)] : [])];
  if (o.fill) {
    const [r, g, b] = hexToRgbArr(o.fill);
    operators.push(setFillingColor(rgb(r, g, b)), rectangle(0, 0, o.rect.w, o.rect.h), fill());
  }
  if (border > 0) {
    const [r, g, b] = hexToRgbArr(o.borderColor ?? o.color);
    const inset = border / 2;
    operators.push(
      setStrokingColor(rgb(r, g, b)),
      setLineWidth(border),
      rectangle(inset, inset, Math.max(0, o.rect.w - border), Math.max(0, o.rect.h - border)),
      stroke(),
    );
  }
  operators.push(popGraphicsState());
  return operators;
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

export function richText(
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

export function normalizeFreeTextAppearanceText(text: string): string {
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
