import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { k } from "../platform/keys";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import ja from "./locales/ja.json";

export const SUPPORTED_LANGUAGES = ["en", "zh", "ja"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

const STORAGE_KEY = "shiori:lang:v1";

// Locale strings carry Mac key glyphs (⌘⇧⌥) as the design tokens; convert
// them to Ctrl/Shift/Alt labels for Windows/Linux on every translation so no
// individual call site can forget to. k() is the identity on macOS.
const platformKeysPostProcessor = {
  type: "postProcessor" as const,
  name: "platformKeys",
  process: (value: string): string => k(value),
};

void i18n
  .use(LanguageDetector)
  .use(platformKeysPostProcessor)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ja: { translation: ja },
    },
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES as readonly string[] as string[],
    load: "languageOnly",
    nonExplicitSupportedLngs: true,
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: STORAGE_KEY,
      caches: ["localStorage"],
    },
    interpolation: {
      escapeValue: false,
    },
    postProcess: ["platformKeys"],
    returnNull: false,
  })
  .then(() => syncDocumentLang());

// Keep `<html lang>` pinned to the resolved UI language so the CSS
// variable overrides in app.css (`html[lang^="zh"]`, `html[lang^="ja"]`)
// can swap the font stack, and so WebKit's per-glyph CJK fallback picks
// the right regional glyph variants (Han characters render differently
// on Chinese vs Japanese fonts — 说 vs 說 vs 説).
function syncDocumentLang(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = currentLanguage();
}

i18n.on("languageChanged", syncDocumentLang);

export function changeLanguage(lng: SupportedLanguage): Promise<unknown> {
  return i18n.changeLanguage(lng);
}

export function currentLanguage(): SupportedLanguage {
  const raw = i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LANGUAGE;
  const base = raw.split("-")[0] as SupportedLanguage;
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base)
    ? (base as SupportedLanguage)
    : DEFAULT_LANGUAGE;
}

export default i18n;
