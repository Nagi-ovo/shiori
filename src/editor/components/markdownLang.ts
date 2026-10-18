import { T } from "../../design/tokens";

// Language + font helpers for the shared MarkdownView. Kept in a plain `.ts`
// module (not the component file) so React Fast Refresh stays happy — a `.tsx`
// that exports a component must not also export helpers.

export type MarkdownLanguage = "zh" | "en" | "ja";
export type MarkdownFontStacks = {
  serif: string;
  sans: string;
  mono: string;
};

export function normalizeLanguage(language: string | undefined): MarkdownLanguage {
  const lang = (language ?? "en").toLowerCase();
  if (lang.startsWith("ja")) return "ja";
  if (lang.startsWith("zh")) return "zh";
  return "en";
}

export function pickFonts(language: MarkdownLanguage): MarkdownFontStacks {
  if (language === "zh") {
    return { serif: T.serifZh, sans: T.sansZh, mono: T.monoZh };
  }
  if (language === "ja") {
    return { serif: T.serifJa, sans: T.sansJa, mono: T.monoJa };
  }
  return { serif: T.serif, sans: T.sans, mono: T.mono };
}
