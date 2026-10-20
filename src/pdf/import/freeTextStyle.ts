import type { TextOverlay } from "../model/types";

// FreeText style recovery for the importer (./annotations.ts): the bold,
// italic, family and alignment Shiori wrote, read back from /RC rich text and
// from the font named in /DA.

type PdfjsAnnotation = Record<string, unknown>;

type FreeTextRichTextStyle = Partial<
  Pick<TextOverlay, "bold" | "italic" | "fontFamily" | "align">
>;

/**
 * pdf.js intentionally sanitizes /RC XHTML into a JSON-like HTML tree. Read
 * only four enumerated style values from the root node that Shiori writes;
 * never forward arbitrary PDF-provided CSS into the DOM.
 */
export function freeTextRichTextStyle(annot: PdfjsAnnotation): FreeTextRichTextStyle {
  const richText = recordValue(annot.richText);
  const html = recordValue(richText?.html);
  const attributes = recordValue(html?.attributes);
  const style = recordValue(attributes?.style);
  if (!style) return {};

  const shorthand = parseRichTextFontShorthand(style.font);
  const fontFamily =
    parseRichTextFontFamily(style.fontFamily) ?? shorthand?.fontFamily;
  const bold = parseRichTextFontWeight(style.fontWeight) ?? shorthand?.bold;
  const italic = parseRichTextFontStyle(style.fontStyle) ?? shorthand?.italic;
  const align = parseRichTextAlignment(style.textAlign);

  return {
    ...(fontFamily ? { fontFamily } : {}),
    ...(bold !== null && bold !== undefined ? { bold } : {}),
    ...(italic !== null && italic !== undefined ? { italic } : {}),
    ...(align ? { align } : {}),
  };
}

function parseRichTextFontShorthand(value: unknown):
  | Pick<TextOverlay, "bold" | "italic" | "fontFamily">
  | null {
  if (typeof value !== "string" || value.length > 160) return null;
  const match = value
    .trim()
    .match(
      /^(normal|italic|oblique)\s+(normal|bold|[1-9]00)\s+\d+(?:\.\d+)?(?:pt|px)\s+(.+)$/i,
    );
  if (!match) return null;
  const fontFamily = parseRichTextFontFamily(match[3]);
  if (!fontFamily) return null;
  return {
    italic: match[1]!.toLowerCase() !== "normal",
    bold: richTextFontWeightValue(match[2]!) ?? false,
    fontFamily,
  };
}

function parseRichTextFontFamily(value: unknown): TextOverlay["fontFamily"] | null {
  if (typeof value !== "string" || value.length > 96) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll('"', "'")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*,\s*/g, ",");
  if (
    normalized === "'noto sans sc',sans-serif" ||
    normalized === "noto sans sc,sans-serif"
  ) {
    return "notoSansSc";
  }
  if (
    normalized === "'noto sans jp',sans-serif" ||
    normalized === "noto sans jp,sans-serif"
  ) {
    return "notoSansJp";
  }
  if (normalized === "serif") return "serif";
  if (normalized === "monospace") return "mono";
  if (normalized === "sans-serif") return "sans";
  return null;
}

function parseRichTextFontWeight(value: unknown): boolean | null {
  return typeof value === "string" ? richTextFontWeightValue(value) : null;
}

function richTextFontWeightValue(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "bold" || /^[6-9]00$/.test(normalized)) return true;
  if (normalized === "normal" || /^[1-5]00$/.test(normalized)) return false;
  return null;
}

function parseRichTextFontStyle(value: unknown): boolean | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "italic" || normalized === "oblique") return true;
  if (normalized === "normal") return false;
  return null;
}

function parseRichTextAlignment(value: unknown): TextOverlay["align"] | null {
  if (value === "left" || value === "center" || value === "right") return value;
  return null;
}

export function freeTextStyle(
  appearance: Record<string, unknown> | null,
): Pick<TextOverlay, "bold" | "italic" | "fontFamily"> {
  const fontName = String(appearance?.fontName ?? "")
    .split("-", 1)[0]!
    .toLowerCase();
  const known: Record<
    string,
    Pick<TextOverlay, "bold" | "italic" | "fontFamily">
  > = {
    shelv: { bold: false, italic: false, fontFamily: "sans" },
    shelvb: { bold: true, italic: false, fontFamily: "sans" },
    shelvo: { bold: false, italic: true, fontFamily: "sans" },
    shelvbo: { bold: true, italic: true, fontFamily: "sans" },
    stimes: { bold: false, italic: false, fontFamily: "serif" },
    stimesb: { bold: true, italic: false, fontFamily: "serif" },
    stimesi: { bold: false, italic: true, fontFamily: "serif" },
    stimesbi: { bold: true, italic: true, fontFamily: "serif" },
    scour: { bold: false, italic: false, fontFamily: "mono" },
    scourb: { bold: true, italic: false, fontFamily: "mono" },
    scouro: { bold: false, italic: true, fontFamily: "mono" },
    scourbo: { bold: true, italic: true, fontFamily: "mono" },
  };
  return (
    known[fontName] ?? {
      bold: false,
      italic: false,
      fontFamily: "sans",
    }
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
