// Text drawn into page content: free text, callout labels, flattened notes
// and original-text (contentText) replacements, with the source-font reuse
// path and the baseline placement those replacements need.
import {
  PDFHexString,
  TextRenderingMode,
  beginText,
  degrees,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFillingColor,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  showText,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  Overlay,
  TextOverlay,
} from "../model/types";
import {
  CALLOUT_LABEL_PADDING_X_PT,
  CALLOUT_LABEL_PADDING_Y_PT,
} from "../model/callout";
import { sourceLinePitchPt } from "../model/baselines";
import type { SourceFontRef } from "./contentTextRedaction";
import { createSourceFontEncoder } from "./contentStreamEdit/sourceFontEncoder";
import {
  pickFont,
  pickPathFont,
  sanitizeFor,
  type FontSet,
} from "./exportFonts";
import { hasNonAscii } from "./textScripts";
import { measureTextWidth, wrapText } from "./textWrap";
import {
  drawPathText,
  pathTextLostChars,
  type PathTextFont,
} from "./vectorText";

const SYNTHETIC_ITALIC_DEGREES = 12;

export function annotationTextLostChars(
  overlays: readonly Overlay[],
  fonts: FontSet,
): number {
  let lostChars = 0;
  for (const overlay of overlays) {
    if (overlay.type !== "text" && overlay.type !== "callout") continue;
    const appearanceText = overlay.text.replace(/\r\n?|\n/g, "");
    const pathFont = pickPathFont(
      appearanceText,
      fonts,
      overlay.fontFamily,
    );
    if (pathFont) {
      lostChars += pathTextLostChars(pathFont, appearanceText);
      continue;
    }
    const font = pickFont(
      appearanceText,
      overlay.bold,
      Boolean(overlay.italic),
      fonts,
      overlay.fontFamily,
    );
    lostChars += sanitizeFor(font, appearanceText).lostChars;
  }
  return lostChars;
}

export function drawContentText(
  out: PDFPage,
  o: ContentTextOverlay,
  fonts: FontSet,
  redaction?: { cleanRects: boolean[]; sourceFont: SourceFontRef | null },
): number {
  const cleanRects = redaction?.cleanRects;
  for (let index = 0; index < o.coverRects.length; index += 1) {
    if (cleanRects?.[index]) continue;
    const rect = o.coverRects[index]!;
    out.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      color: hexToRgb(o.backgroundColor),
      borderWidth: 0,
    });
  }
  // Same-font replacement: when the removed glyphs all came from one source
  // font whose subset can encode the whole replacement, reuse it — the edit
  // becomes visually indistinguishable from untouched text. Any doubt falls
  // through to the bundled-font path below.
  if (
    redaction?.sourceFont &&
    drawContentTextWithSourceFont(out, o, redaction.sourceFont)
  ) {
    return 0;
  }
  return drawText(out, o, fonts);
}

// Draw a contentText replacement with the source PDF's own font, via raw
// text operators against the font's existing resource name. Returns false —
// having drawn nothing — whenever the source font cannot express the text
// exactly: no usable /ToUnicode, a character outside the (possibly subset)
// font, styling the source run didn't have (bold/italic toggles), a line
// too wide for the edit rect (the bundled path wraps instead), or a legacy
// overlay without captured baselines.
function drawContentTextWithSourceFont(
  out: PDFPage,
  o: ContentTextOverlay,
  sourceFont: SourceFontRef,
): boolean {
  if (!o.text) return false;
  if (o.bold || o.italic) return false;
  const baselines = o.sourceBaselinesPt;
  if (!baselines || baselines.length === 0) return false;

  const encoder = createSourceFontEncoder(sourceFont.dict);
  if (!encoder) return false;

  const lines = o.text.split("\n");
  const encoded: Array<{ bytes: Uint8Array; widthPt: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const result = encoder.encodeLine(lines[i]!);
    if (!result) return false;
    const widthPt = result.widthEm * o.fontSize;
    // Wider than the available room means the bundled path would wrap the
    // line; this path draws single runs only, so let it handle the
    // overflow. Line 0 loses the mid-line-start indent.
    const room = o.rect.w - (i === 0 ? (o.firstLineIndentPt ?? 0) : 0);
    if (widthPt > room + 1) return false;
    encoded.push({ bytes: result.bytes, widthPt });
  }

  const color = hexToRgb(o.color);
  const lineHeight = o.fontSize;
  const operators = [
    pushGraphicsState(),
    beginText(),
    // The appended content stream inherits defaults (pdf-lib wraps the
    // original page content in q/Q), but earlier overlay draws share this
    // stream — pin every text-state parameter the run depends on.
    setCharacterSpacing(0),
    setWordSpacing(0),
    setCharacterSqueeze(100),
    setTextRise(0),
    setTextRenderingMode(TextRenderingMode.Fill),
    setFillingColor(color),
    setFontAndSize(sourceFont.name, o.fontSize),
  ];
  for (let i = 0; i < lines.length; i += 1) {
    const line = encoded[i]!;
    if (line.bytes.length === 0) continue;
    let x = o.rect.x;
    if (o.align === "center") x = o.rect.x + (o.rect.w - line.widthPt) / 2;
    else if (o.align === "right") x = o.rect.x + (o.rect.w - line.widthPt);
    // Mid-line selection start (matches the on-screen CSS text-indent).
    if (i === 0 && o.align === "left") x += o.firstLineIndentPt ?? 0;
    const y = contentTextSourceBaselineY(baselines, i, lineHeight);
    if (y < o.rect.y - lineHeight) break;
    operators.push(
      setTextMatrix(1, 0, 0, 1, x, y),
      showText(PDFHexString.of(bytesToHex(line.bytes))),
    );
  }
  operators.push(endText(), popGraphicsState());
  out.pushOperators(...operators);
  return true;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

// Baseline for line i: the captured source baseline when the line existed in
// the source, continuing downward at the measured source pitch (lineHeight
// as fallback) when the edit has more lines. Mirrors contentTextBaselineY's
// preferred branch.
function contentTextSourceBaselineY(
  baselines: readonly number[],
  lineIndex: number,
  lineHeight: number,
): number {
  const exact = baselines[lineIndex];
  if (typeof exact === "number" && Number.isFinite(exact)) return exact;
  const pitch = sourceLinePitchPt(baselines) ?? lineHeight;
  const last = baselines[baselines.length - 1]!;
  return last - (lineIndex - (baselines.length - 1)) * pitch;
}

export function drawText(
  out: PDFPage,
  o: TextOverlay | ContentTextOverlay | CalloutOverlay,
  fonts: FontSet,
): number {
  if (!o.text) return 0;
  const font = pickFont(o.text, o.bold, Boolean(o.italic), fonts, o.fontFamily);
  const pathFont = pickPathFont(o.text, fonts, o.fontFamily);
  const color = hexToRgb(o.color);
  const isContentEdit = o.type === "contentText";
  const textRect = o.type === "callout"
    ? {
        x: o.rect.x + CALLOUT_LABEL_PADDING_X_PT,
        y: o.rect.y + CALLOUT_LABEL_PADDING_Y_PT,
        w: Math.max(1, o.rect.w - CALLOUT_LABEL_PADDING_X_PT * 2),
        h: Math.max(1, o.rect.h - CALLOUT_LABEL_PADDING_Y_PT * 2),
      }
    : o.rect;
  const lineHeight = o.fontSize * (isContentEdit ? 1 : 1.2);
  // Wrapping, measuring and drawing must use ONE font. shouldDrawTextLineAsPath
  // switches to the path font for a Noto family regardless of the line's script,
  // so measurement has to do the same or ASCII lines are laid out on Helvetica
  // advances and drawn with Noto outlines. See measureTextWidth.
  const drawsWithPathFont =
    o.fontFamily === "notoSansSc" || o.fontFamily === "notoSansJp";
  const lines = wrapText(
    o.text,
    font,
    o.fontSize,
    textRect.w,
    pathFont,
    drawsWithPathFont,
  );
  let lostChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const textWidth = measureTextWidth(
      font,
      line,
      o.fontSize,
      pathFont,
      drawsWithPathFont,
    );
    let x = textRect.x;
    if (o.align === "center") x = textRect.x + (textRect.w - textWidth) / 2;
    else if (o.align === "right") x = textRect.x + (textRect.w - textWidth);
    // Mid-line selection start: the first covered line begins right of the
    // box edge (matches the on-screen CSS text-indent).
    if (i === 0 && o.type === "contentText" && o.align === "left") {
      x += o.firstLineIndentPt ?? 0;
    }
    const y = isContentEdit
      ? contentTextBaselineY(o, font, i, lineHeight)
      : textRect.y + textRect.h - (i + 1) * lineHeight +
        (lineHeight - o.fontSize) / 2;
    if (y < textRect.y - lineHeight) break;
    if (shouldDrawTextLineAsPath(o, line, pathFont)) {
      lostChars += pathTextLostChars(pathFont, line);
      out.pushOperators(
        ...drawPathText(
          pathFont,
          line,
          x,
          y,
          o.fontSize,
          [color.red, color.green, color.blue],
          usesSyntheticItalic(o, line),
        ),
      );
      continue;
    }
    const sanitized = sanitizeFor(font, line);
    lostChars += sanitized.lostChars;
    out.drawText(sanitized.text, {
      x,
      y,
      size: o.fontSize,
      font,
      color,
      ySkew: usesSyntheticItalic(o, line)
        ? degrees(SYNTHETIC_ITALIC_DEGREES)
        : undefined,
    });
  }
  return lostChars;
}

function shouldDrawTextLineAsPath(
  o: TextOverlay | ContentTextOverlay | CalloutOverlay,
  line: string,
  pathFont: PathTextFont | null,
): pathFont is PathTextFont {
  return Boolean(
    pathFont &&
      (hasNonAscii(line) ||
        o.fontFamily === "notoSansSc" ||
        o.fontFamily === "notoSansJp"),
  );
}

function contentTextBaselineY(
  o: ContentTextOverlay,
  font: PDFFont,
  lineIndex: number,
  lineHeight: number,
): number {
  // Preferred: the source line's own baseline, captured from the text at edit
  // time. drawText/drawPathText y IS the baseline, so the replacement font's
  // ascent no longer influences placement. Lines beyond the covered source
  // lines (edited text wrapped longer) continue downward at the measured
  // source pitch (falling back to lineHeight for single-baseline overlays).
  const baselines = o.sourceBaselinesPt;
  if (baselines && baselines.length > 0) {
    const exact = baselines[lineIndex];
    if (typeof exact === "number" && Number.isFinite(exact)) return exact;
    const pitch = sourceLinePitchPt(baselines) ?? lineHeight;
    const last = baselines[baselines.length - 1]!;
    return last - (lineIndex - (baselines.length - 1)) * pitch;
  }
  // Legacy overlays (pre-baseline capture): derive from the edit rect. The
  // 0.8 mirrors the cover-rect pad the edit rect was built with.
  const coverPadPt = 0.8;
  const sourceTop = o.rect.y + o.rect.h - coverPadPt;
  return sourceTop - font.heightAtSize(o.fontSize, { descender: false }) -
    lineIndex * lineHeight;
}

function usesSyntheticItalic(
  o: TextOverlay | ContentTextOverlay | CalloutOverlay,
  line: string,
): boolean {
  return (
    Boolean(o.italic) &&
    (o.fontFamily === "notoSansSc" ||
      o.fontFamily === "notoSansJp" ||
      hasNonAscii(line))
  );
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h.length === 6
        ? h
        : "000000";
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}
