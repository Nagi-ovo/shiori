import { normalizeHexColor } from "../design/color";

export const MARKDOWN_FONT_SIZE_MIN = 12;
export const MARKDOWN_FONT_SIZE_MAX = 24;
export const MARKDOWN_LINE_HEIGHT_MIN = 1.3;
export const MARKDOWN_LINE_HEIGHT_MAX = 2.2;
export const MARKDOWN_CONTENT_WIDTH_MIN = 640;
export const MARKDOWN_CONTENT_WIDTH_MAX = 1200;
export const MARKDOWN_RECENT_FONTS_MAX = 6;
export const MARKDOWN_FONT_FAMILY_MAX_LENGTH = 128;

export type MarkdownFontSource = "builtin" | "system";

export type MarkdownFontChoice = {
  source: MarkdownFontSource;
  family: string;
};

export type MarkdownBuiltinFont = MarkdownFontChoice & {
  source: "builtin";
  category: "sans" | "serif" | "mono";
};

export type MarkdownAppearance = {
  bodyFont: MarkdownFontChoice | null;
  codeFont: MarkdownFontChoice | null;
  headingColor: string | null;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
};

// Missing keys follow the global preference. A present `null` font or color
// explicitly asks Shiori to use its automatic theme-aware fallback instead.
export type MarkdownAppearanceOverride = Partial<MarkdownAppearance>;

// Brand-only subsets (Klee One / Shippori Mincho) and the terminal-only Nerd
// Symbols face must never appear here: they cannot render normal documents.
export const BUILTIN_MARKDOWN_FONTS: readonly MarkdownBuiltinFont[] = [
  { source: "builtin", family: "Inter Tight", category: "sans" },
  { source: "builtin", family: "Instrument Serif", category: "serif" },
  { source: "builtin", family: "JetBrains Mono", category: "mono" },
  { source: "builtin", family: "Noto Sans SC", category: "sans" },
  { source: "builtin", family: "Noto Sans JP", category: "sans" },
  { source: "builtin", family: "Liberation Sans", category: "sans" },
  { source: "builtin", family: "Liberation Serif", category: "serif" },
  { source: "builtin", family: "Liberation Mono", category: "mono" },
] as const;

const BUILTIN_FONT_FAMILIES = new Set(
  BUILTIN_MARKDOWN_FONTS.map((font) => font.family),
);

export const DEFAULT_MARKDOWN_APPEARANCE: MarkdownAppearance = {
  bodyFont: null,
  codeFont: null,
  headingColor: null,
  fontSize: 16,
  lineHeight: 1.7,
  contentWidth: 960,
};

export function isValidMarkdownFontFamily(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MARKDOWN_FONT_FAMILY_MAX_LENGTH &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint >= 32 &&
        codePoint !== 127 &&
        codePoint !== 0x061c &&
        !(codePoint >= 0x200b && codePoint <= 0x200f) &&
        !(codePoint >= 0x202a && codePoint <= 0x202e) &&
        !(codePoint >= 0x2060 && codePoint <= 0x206f) &&
        codePoint !== 0xfeff
      );
    })
  );
}

export function isMarkdownFontChoice(
  value: unknown,
): value is MarkdownFontChoice {
  if (!value || typeof value !== "object") return false;
  const font = value as Record<string, unknown>;
  if (!isValidMarkdownFontFamily(font.family)) return false;
  if (font.source === "builtin") {
    return BUILTIN_FONT_FAMILIES.has(font.family);
  }
  return font.source === "system";
}

function normalizeFontValue(
  value: unknown,
): MarkdownFontChoice | null | undefined {
  if (value === null) return null;
  return isMarkdownFontChoice(value)
    ? { source: value.source, family: value.family }
    : undefined;
}

function normalizeColorValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return normalizeHexColor(value) ?? undefined;
}

function finiteInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function normalizeMarkdownAppearance(
  value: unknown,
): MarkdownAppearance {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_MARKDOWN_APPEARANCE };
  }
  const raw = value as Record<string, unknown>;
  const bodyFont = normalizeFontValue(raw.bodyFont);
  const codeFont = normalizeFontValue(raw.codeFont);
  const headingColor = normalizeColorValue(raw.headingColor);
  return {
    bodyFont:
      bodyFont === undefined
        ? DEFAULT_MARKDOWN_APPEARANCE.bodyFont
        : bodyFont,
    codeFont:
      codeFont === undefined
        ? DEFAULT_MARKDOWN_APPEARANCE.codeFont
        : codeFont,
    headingColor:
      headingColor === undefined
        ? DEFAULT_MARKDOWN_APPEARANCE.headingColor
        : headingColor,
    fontSize: finiteInRange(
      raw.fontSize,
      MARKDOWN_FONT_SIZE_MIN,
      MARKDOWN_FONT_SIZE_MAX,
    )
      ? raw.fontSize
      : DEFAULT_MARKDOWN_APPEARANCE.fontSize,
    lineHeight: finiteInRange(
      raw.lineHeight,
      MARKDOWN_LINE_HEIGHT_MIN,
      MARKDOWN_LINE_HEIGHT_MAX,
    )
      ? raw.lineHeight
      : DEFAULT_MARKDOWN_APPEARANCE.lineHeight,
    contentWidth: finiteInRange(
      raw.contentWidth,
      MARKDOWN_CONTENT_WIDTH_MIN,
      MARKDOWN_CONTENT_WIDTH_MAX,
    )
      ? raw.contentWidth
      : DEFAULT_MARKDOWN_APPEARANCE.contentWidth,
  };
}

export function normalizeMarkdownAppearanceOverride(
  value: unknown,
): MarkdownAppearanceOverride {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const normalized: MarkdownAppearanceOverride = {};
  if (Object.hasOwn(raw, "bodyFont")) {
    const font = normalizeFontValue(raw.bodyFont);
    if (font !== undefined) normalized.bodyFont = font;
  }
  if (Object.hasOwn(raw, "codeFont")) {
    const font = normalizeFontValue(raw.codeFont);
    if (font !== undefined) normalized.codeFont = font;
  }
  if (Object.hasOwn(raw, "headingColor")) {
    const color = normalizeColorValue(raw.headingColor);
    if (color !== undefined) normalized.headingColor = color;
  }
  if (
    finiteInRange(
      raw.fontSize,
      MARKDOWN_FONT_SIZE_MIN,
      MARKDOWN_FONT_SIZE_MAX,
    )
  ) {
    normalized.fontSize = raw.fontSize;
  }
  if (
    finiteInRange(
      raw.lineHeight,
      MARKDOWN_LINE_HEIGHT_MIN,
      MARKDOWN_LINE_HEIGHT_MAX,
    )
  ) {
    normalized.lineHeight = raw.lineHeight;
  }
  if (
    finiteInRange(
      raw.contentWidth,
      MARKDOWN_CONTENT_WIDTH_MIN,
      MARKDOWN_CONTENT_WIDTH_MAX,
    )
  ) {
    normalized.contentWidth = raw.contentWidth;
  }
  return normalized;
}

export function resolveMarkdownAppearance(
  globalAppearance: MarkdownAppearance,
  override: MarkdownAppearanceOverride | undefined,
): MarkdownAppearance {
  return { ...globalAppearance, ...(override ?? {}) };
}

export function markdownFontChoiceKey(font: MarkdownFontChoice): string {
  return `${font.source}:${font.family.toLowerCase()}`;
}

export function markdownFontsEqual(
  left: MarkdownFontChoice | null | undefined,
  right: MarkdownFontChoice | null | undefined,
): boolean {
  if (left == null || right == null) return left === right;
  return markdownFontChoiceKey(left) === markdownFontChoiceKey(right);
}

export function normalizeRecentMarkdownFonts(
  value: unknown,
): MarkdownFontChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const fonts: MarkdownFontChoice[] = [];
  for (const entry of value) {
    if (!isMarkdownFontChoice(entry)) continue;
    const key = markdownFontChoiceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    fonts.push({ source: entry.source, family: entry.family });
    if (fonts.length >= MARKDOWN_RECENT_FONTS_MAX) break;
  }
  return fonts;
}

export function pushRecentMarkdownFont(
  recent: readonly MarkdownFontChoice[],
  font: MarkdownFontChoice,
): MarkdownFontChoice[] {
  const key = markdownFontChoiceKey(font);
  return [
    { source: font.source, family: font.family },
    ...recent.filter((entry) => markdownFontChoiceKey(entry) !== key),
  ].slice(0, MARKDOWN_RECENT_FONTS_MAX);
}

function quoteCssFontFamily(family: string): string {
  return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function markdownFontFamilyCss(
  font: MarkdownFontChoice | null,
  fallback: "body" | "code",
): string {
  const builtin =
    font?.source === "builtin"
      ? BUILTIN_MARKDOWN_FONTS.find((entry) => entry.family === font.family)
      : undefined;
  const fallbackCss =
    fallback === "code" || builtin?.category === "mono"
      ? "var(--opx-font-mono)"
      : builtin?.category === "serif"
        ? "var(--opx-font-serif)"
        : "var(--opx-font-sans)";
  return font ? `${quoteCssFontFamily(font.family)}, ${fallbackCss}` : fallbackCss;
}
