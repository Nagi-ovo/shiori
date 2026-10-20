// The fonts an export draws with: the standard-14 faces every export embeds,
// the bundled CJK outline fonts loaded only when some overlay's text needs
// them, and the per-run choice between them.
import { StandardFonts, type PDFDocument, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Font as FontkitFont } from "@pdf-lib/fontkit";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  NoteOverlay,
  Overlay,
  TextOverlay,
} from "../model/types";
import type { AnnotationFonts } from "./annotations";
import type { ExportMode, ExportOptions } from "./exportPdf";
import { hasCjkText, hasKana, hasNonAscii } from "./textScripts";
import type { PathTextFont } from "./vectorText";

export type FontSet = {
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
  unicodeFont: PDFFont | null;
  unicodeBoldFont: PDFFont | null;
  unicodePathFont: FontkitFont | null;
  unicodeJpFont: PDFFont | null;
  unicodeJpBoldFont: PDFFont | null;
  unicodeJpPathFont: FontkitFont | null;
};

export async function loadExportFonts(
  out: PDFDocument,
  exportedOverlays: Overlay[],
  mode: ExportMode,
  options: ExportOptions,
): Promise<FontSet> {
  const helv = await out.embedFont(StandardFonts.Helvetica);
  const helvBold = await out.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await out.embedFont(StandardFonts.HelveticaOblique);
  const helvBoldOblique = await out.embedFont(StandardFonts.HelveticaBoldOblique);
  const times = await out.embedFont(StandardFonts.TimesRoman);
  const timesBold = await out.embedFont(StandardFonts.TimesRomanBold);
  const timesItalic = await out.embedFont(StandardFonts.TimesRomanItalic);
  const timesBoldItalic = await out.embedFont(StandardFonts.TimesRomanBoldItalic);
  const courier = await out.embedFont(StandardFonts.Courier);
  const courierBold = await out.embedFont(StandardFonts.CourierBold);
  const courierOblique = await out.embedFont(StandardFonts.CourierOblique);
  const courierBoldOblique = await out.embedFont(StandardFonts.CourierBoldOblique);
  const zapf = await out.embedFont(StandardFonts.ZapfDingbats);

  // Editable sticky notes carry text only in /Contents; flattened notes draw
  // their text into the page and need the same Unicode path as text overlays.
  const textOverlays = exportedOverlays.filter(
    (
      overlay,
    ): overlay is
      | TextOverlay
      | ContentTextOverlay
      | CalloutOverlay
      | NoteOverlay =>
      overlay.type === "text" ||
      overlay.type === "contentText" ||
      overlay.type === "callout" ||
      (mode === "flatten" && overlay.type === "note"),
  );
  // SC and JP are a fallback pair for CJK path text. Loading only the
  // script's primary face makes mixed kana/Han or rare Han silently fall back
  // to '?', even though the other bundled face contains the glyph.
  const needsCjkFallbackPair = textOverlays.some((o) => hasCjkText(o.text));
  const needsScPrimary = textOverlays.some(
    (o) =>
      ("fontFamily" in o && o.fontFamily === "notoSansSc") ||
      ((!("fontFamily" in o) || o.fontFamily !== "notoSansJp") &&
        hasNonAscii(o.text) &&
        !hasKana(o.text)),
  );
  const needsJpPrimary = textOverlays.some(
    (o) =>
      ("fontFamily" in o && o.fontFamily === "notoSansJp") ||
      ((!("fontFamily" in o) || o.fontFamily !== "notoSansSc") &&
        hasKana(o.text)),
  );
  const needsSc = needsScPrimary || needsCjkFallbackPair;
  const needsJp = needsJpPrimary || needsCjkFallbackPair;
  // CJK text is routed through fontkit outlines instead of pdf-lib's
  // subset-font content-stream path. The subset font path is structurally
  // valid enough for pdf-lib, but PDFKit/QuickLook replaces those embedded
  // CID fonts with Helvetica and renders tofu/garbage. Path text keeps the
  // visible output deterministic across Preview, QuickLook, and Poppler.
  const unicodeFont: PDFFont | null = null;
  const unicodeBoldFont: PDFFont | null = null;
  let unicodePathFont: FontkitFont | null = null;
  const unicodeJpFont: PDFFont | null = null;
  const unicodeJpBoldFont: PDFFont | null = null;
  let unicodeJpPathFont: FontkitFont | null = null;
  let missingUnicodeFont = false;
  if (needsSc && (options.unicodeFontBytes || options.unicodeFontUrl)) {
    try {
      const bytes = options.unicodeFontBytes
        ? new Uint8Array(options.unicodeFontBytes)
        : await fetchBytes(options.unicodeFontUrl!, options.fontFetchTimeoutMs);
      unicodePathFont = fontkit.create(bytes);
    } catch (err) {
      console.warn("Failed to load SC export font.", err);
      missingUnicodeFont ||= needsScPrimary;
    }
  } else if (needsScPrimary) {
    missingUnicodeFont = true;
  }
  if (needsJp && (options.unicodeJpFontBytes || options.unicodeJpFontUrl)) {
    try {
      const bytes = options.unicodeJpFontBytes
        ? new Uint8Array(options.unicodeJpFontBytes)
        : await fetchBytes(options.unicodeJpFontUrl!, options.fontFetchTimeoutMs);
      unicodeJpPathFont = fontkit.create(bytes);
    } catch (err) {
      console.warn("Failed to load JP export font.", err);
      missingUnicodeFont ||= needsJpPrimary;
    }
  } else if (needsJpPrimary) {
    missingUnicodeFont = true;
  }
  if (missingUnicodeFont && options.requireUnicodeFont) {
    throw new Error(
      options.unicodeFontErrorMessage ??
        "Unable to load the Unicode export font.",
    );
  }

  return {
    helv,
    helvBold,
    helvOblique,
    helvBoldOblique,
    times,
    timesBold,
    timesItalic,
    timesBoldItalic,
    courier,
    courierBold,
    courierOblique,
    courierBoldOblique,
    zapf,
    unicodeFont,
    unicodeBoldFont,
    unicodePathFont,
    unicodeJpFont,
    unicodeJpBoldFont,
    unicodeJpPathFont,
  };
}

// The editable-annotation writer takes the same faces under its own names.
export function annotationFonts(fonts: FontSet): AnnotationFonts {
  return {
    helv: fonts.helv,
    helvBold: fonts.helvBold,
    helvOblique: fonts.helvOblique,
    helvBoldOblique: fonts.helvBoldOblique,
    times: fonts.times,
    timesBold: fonts.timesBold,
    timesItalic: fonts.timesItalic,
    timesBoldItalic: fonts.timesBoldItalic,
    courier: fonts.courier,
    courierBold: fonts.courierBold,
    courierOblique: fonts.courierOblique,
    courierBoldOblique: fonts.courierBoldOblique,
    zapf: fonts.zapf,
    unicode: fonts.unicodeFont,
    unicodePath: fonts.unicodePathFont,
    unicodeJp: fonts.unicodeJpFont,
    unicodeJpPath: fonts.unicodeJpPathFont,
  };
}

export function pickFont(
  text: string,
  bold: boolean,
  italic: boolean,
  fonts: FontSet,
  family: TextOverlay["fontFamily"] = "sans",
): PDFFont {
  if (family === "notoSansJp" && fonts.unicodeJpFont) {
    return bold
      ? fonts.unicodeJpBoldFont ?? fonts.unicodeJpFont
      : fonts.unicodeJpFont;
  }
  if (family === "notoSansSc" && fonts.unicodeFont) {
    return bold
      ? fonts.unicodeBoldFont ?? fonts.unicodeFont
      : fonts.unicodeFont;
  }
  // After explicit bundled-font choices, prefer the JP font whenever
  // the overlay carries kana, even if it also has kanji. Pure-kanji or
  // pure-Chinese text falls through to the SC font. Standard PDF fonts
  // can't encode CJK, so any non-ASCII routes through one of these two.
  if (hasKana(text) && fonts.unicodeJpFont) {
    return bold
      ? fonts.unicodeJpBoldFont ?? fonts.unicodeJpFont
      : fonts.unicodeJpFont;
  }
  if (hasNonAscii(text) && fonts.unicodeFont) {
    return bold
      ? fonts.unicodeBoldFont ?? fonts.unicodeFont
      : fonts.unicodeFont;
  }
  if (family === "serif") {
    if (bold && italic) return fonts.timesBoldItalic;
    if (bold) return fonts.timesBold;
    if (italic) return fonts.timesItalic;
    return fonts.times;
  }
  if (family === "mono") {
    if (bold && italic) return fonts.courierBoldOblique;
    if (bold) return fonts.courierBold;
    if (italic) return fonts.courierOblique;
    return fonts.courier;
  }
  if (bold && italic) return fonts.helvBoldOblique;
  if (bold) return fonts.helvBold;
  if (italic) return fonts.helvOblique;
  return fonts.helv;
}

export function pickPathFont(
  text: string,
  fonts: FontSet,
  family: TextOverlay["fontFamily"] = "sans",
): PathTextFont | null {
  if (family === "notoSansJp" || hasKana(text)) {
    return pathFontWithFallback(fonts.unicodeJpPathFont, fonts.unicodePathFont);
  }
  if (family === "notoSansSc" || hasNonAscii(text)) {
    return pathFontWithFallback(fonts.unicodePathFont, fonts.unicodeJpPathFont);
  }
  return null;
}

function pathFontWithFallback(
  primary: FontkitFont | null,
  fallback: FontkitFont | null,
): PathTextFont | null {
  if (!primary) return fallback;
  if (!fallback || fallback === primary) return primary;
  return { primary, fallbacks: [fallback] };
}

type SanitizeResult = { text: string; lostChars: number };

export function sanitizeFor(font: PDFFont, text: string): SanitizeResult {
  try {
    font.encodeText(text);
    return { text, lostChars: 0 };
  } catch {
    let lostChars = 0;
    const sanitized = [...text]
      .map((ch) => {
        try {
          font.encodeText(ch);
          return ch;
        } catch {
          lostChars++;
          return "?";
        }
      })
      .join("");
    return { text: sanitized, lostChars };
  }
}

async function fetchBytes(
  url: string,
  timeoutMs: number = 6000,
): Promise<Uint8Array> {
  const controller =
    typeof AbortController === "undefined" ? null : new AbortController();
  const timeout =
    controller && timeoutMs > 0
      ? globalThis.setTimeout(() => controller.abort(), timeoutMs)
      : null;
  try {
    const res = await fetch(url, { signal: controller?.signal });
    if (!res.ok) throw new Error(`Failed to load font: ${res.status}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } catch (err) {
    if (controller?.signal.aborted) {
      throw new Error("Timed out loading export font.");
    }
    throw err;
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}
