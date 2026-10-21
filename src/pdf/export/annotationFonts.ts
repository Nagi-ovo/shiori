// Font routing for editable FreeText and callout annotations: which
// registered page font a given family / weight / script resolves to, and the
// style hints written beside it. Split out of ./annotations.

import type { PDFFont, PDFName } from "pdf-lib";
import type { Font as FontkitFont } from "@pdf-lib/fontkit";
import type { TextOverlay } from "../model/types";
import { hasKana, hasNonAscii } from "./textScripts";
import type { PathTextFont } from "./vectorText";

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

export type FontFamily = TextOverlay["fontFamily"];
export type FreeTextFontEntry = {
  name: PDFName;
  font: PDFFont;
  pathFont?: PathTextFont | null;
};
export type FreeTextFontNames = {
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

export const SYNTHETIC_ITALIC_DEGREES = 12;
export const SHIORI_FONT_PREFIXES = [
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

export function pickFreeTextFont(
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

export function freeTextCssFamily(family: FontFamily): string {
  if (family === "notoSansSc") return "'Noto Sans SC', sans-serif";
  if (family === "notoSansJp") return "'Noto Sans JP', sans-serif";
  if (family === "serif") return "serif";
  if (family === "mono") return "monospace";
  return "sans-serif";
}

export function usesSyntheticFreeTextItalic(
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
