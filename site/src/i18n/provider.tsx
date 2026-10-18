import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DICT, SUPPORTED_LANGS, type Lang } from "./dict";
import { LanguageContext } from "./context";

const STORAGE_KEY = "shiori-site-lang";

function detectFromBrowser(): Lang {
  if (typeof navigator === "undefined") return "en";
  const candidates =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language || "en"];
  for (const raw of candidates) {
    const tag = raw.toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

function detectInitialLang(): Lang {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) {
      return stored as Lang;
    }
  } catch {
    /* private mode */
  }
  return detectFromBrowser();
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  // Sync the document `lang` so the global font-stack swap kicks in
  // (see :root selectors in index.css).
  useEffect(() => {
    document.documentElement.setAttribute("lang", lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({ lang, setLang, t: DICT[lang] }),
    [lang, setLang],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}
