// Text drawn into page content: free text, callout labels, flattened notes
// and original-text (contentText) replacements, with the source-font reuse
// path and the baseline placement those replacements need.
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  TextRenderingMode,
  beginText,
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
  PdfRect,
  TextOverlay,
} from "../model/types";
import {
  CALLOUT_LABEL_PADDING_X_PT,
  CALLOUT_LABEL_PADDING_Y_PT,
} from "../model/callout";
import { sourceLinePitchPt } from "../model/baselines";
import { fontNamesLookBold, fontNamesLookItalic } from "../model/fontStyle";
import type { SourceFontRef } from "./contentTextRedaction";
import { createSourceFontEncoder } from "./contentStreamEdit/sourceFontEncoder";
import {
  pickFont,
  pickPathFont,
  sanitizeFor,
  type FontSet,
} from "./exportFonts";
import {
  measureTextWidth,
  usesPathFont,
  wrapText,
  type PathFontUse,
} from "./textWrap";
import { drawPathText, pathTextLostChars } from "./vectorText";

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

// What drawing an overlay's text could not keep: characters no font could
// encode (drawn as "?") and characters on lines that did not fit their box
// (left out of the page). Both reach the export dialog's confirmation.
export type TextDrawLoss = { lostChars: number; clippedChars: number };

export function addTextLoss(a: TextDrawLoss, b: TextDrawLoss): TextDrawLoss {
  return {
    lostChars: a.lostChars + b.lostChars,
    clippedChars: a.clippedChars + b.clippedChars,
  };
}

export const NO_TEXT_LOSS: TextDrawLoss = { lostChars: 0, clippedChars: 0 };

export function drawContentText(
  out: PDFPage,
  o: ContentTextOverlay,
  fonts: FontSet,
  redaction?: { cleanRects: boolean[]; sourceFont: SourceFontRef | null },
): TextDrawLoss {
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
    return NO_TEXT_LOSS;
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
  // A style the source run already has is not a toggle: a bold heading
  // edited as bold keeps its own font. Only a style the user added or
  // removed sends the edit to a bundled face.
  const source = sourceFontStyle(sourceFont.dict);
  if (o.bold !== source.bold || Boolean(o.italic) !== source.italic) {
    return false;
  }
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
    // Every line is drawn, past the edit box too: the editor shows the edit
    // with overflow visible, and dropping lines here lost text silently.
    const y = contentTextSourceBaselineY(baselines, i, lineHeight);
    operators.push(
      setTextMatrix(1, 0, 0, 1, x, y),
      showText(PDFHexString.of(bytesToHex(line.bytes))),
    );
  }
  operators.push(endText(), popGraphicsState());
  out.pushOperators(...operators);
  return true;
}

// The source font's own style, by the detector the edit inferred its style
// with (fontNamesLookBold/Italic over the /BaseFont the text layer reports).
// A Type0 font names its style on the descendant as well.
function sourceFontStyle(dict: PDFDict): { bold: boolean; italic: boolean } {
  const names = [baseFontName(dict)];
  const descendants = dict.lookup(PDFName.of("DescendantFonts"));
  const first = descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
  if (first instanceof PDFDict) names.push(baseFontName(first));
  return { bold: fontNamesLookBold(names), italic: fontNamesLookItalic(names) };
}

function baseFontName(dict: PDFDict): string | undefined {
  const name = dict.lookup(PDFName.of("BaseFont"));
  return name instanceof PDFName ? name.decodeText() : undefined;
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

// `clipRect`: the clip the caller pushed around this text (a flattened
// callout clips its label to its rect). Every drawn character that falls
// outside it — a baseline below its bottom, a long word past its side — is
// counted as clipped, not only the lines left undrawn.
export function drawText(
  out: PDFPage,
  o: TextOverlay | ContentTextOverlay | CalloutOverlay,
  fonts: FontSet,
  clipRect?: PdfRect,
): TextDrawLoss {
  if (!o.text) return NO_TEXT_LOSS;
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
  // Wrapping, measuring and drawing must use ONE font per line, so all three
  // route through usesPathFont with the same mode. A Noto family draws every
  // line as Noto outlines; otherwise only a line the PDF font cannot encode
  // does — WinAnsi Latin (curly quotes, dashes, accents) stays searchable
  // text in the chosen Times/Helvetica/Courier face. See measureTextWidth.
  const pathFontUse: PathFontUse =
    o.fontFamily === "notoSansSc" || o.fontFamily === "notoSansJp"
      ? "always"
      : "unencodable";
  const lines = wrapText(
    o.text,
    font,
    o.fontSize,
    textRect.w,
    pathFont,
    pathFontUse,
  );
  let lostChars = 0;
  let clippedChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const asPath = usesPathFont(font, line, pathFont, pathFontUse);
    // Measured in the face this line is drawn in, prefixes included.
    const widthOf = (text: string) =>
      measureTextWidth(font, text, o.fontSize, asPath ? pathFont : null, asPath);
    const textWidth = widthOf(line);
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
    // A box (free text, callout label, flattened note) clips at its edge, as
    // the editor does: the lines left out are counted for the export
    // dialog's confirmation, never dropped silently. An original-text edit
    // renders with overflow visible in the editor, so all its lines draw.
    if (!isContentEdit && y < textRect.y - lineHeight) {
      clippedChars += visibleCharCount(lines.slice(i));
      break;
    }
    if (clipRect) {
      clippedChars += charsOutsideClip(line, x, y, textWidth, clipRect, widthOf);
    }
    if (asPath && pathFont) {
      lostChars += pathTextLostChars(pathFont, line);
      out.pushOperators(
        ...drawPathText(
          pathFont,
          line,
          x,
          y,
          o.fontSize,
          [color.red, color.green, color.blue],
          // Outlines have no italic face; a Times/Helvetica line already
          // got one from pickFont and must not be slanted twice.
          Boolean(o.italic),
        ),
      );
      continue;
    }
    const sanitized = sanitizeFor(font, line);
    lostChars += sanitized.lostChars;
    out.drawText(sanitized.text, { x, y, size: o.fontSize, font, color });
  }
  return { lostChars, clippedChars };
}

function visibleCharCount(lines: readonly string[]): number {
  return Array.from(lines.join("").replace(/\s/gu, "")).length;
}

// Characters of a drawn line the clip hides: the whole line when its
// baseline is below the clip (at most the tops of its glyphs show), else
// each character whose advance crosses the clip's left or right edge. A
// half-point tolerance keeps a line that ends exactly on the edge whole.
function charsOutsideClip(
  line: string,
  x: number,
  y: number,
  lineWidth: number,
  clip: PdfRect,
  widthOf: (text: string) => number,
): number {
  if (y < clip.y) return visibleCharCount([line]);
  const left = clip.x - 0.5;
  const right = clip.x + clip.w + 0.5;
  if (x >= left && x + lineWidth <= right) return 0;
  let count = 0;
  let prefix = "";
  for (const ch of Array.from(line)) {
    const start = x + widthOf(prefix);
    prefix += ch;
    const end = x + widthOf(prefix);
    if (/\s/u.test(ch)) continue;
    if (start < left || end > right) count += 1;
  }
  return count;
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
