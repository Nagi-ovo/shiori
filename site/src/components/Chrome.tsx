import { useEffect, useRef, useState } from "react";
import { useLang } from "../i18n/context";
import { SUPPORTED_LANGS, type Lang } from "../i18n/dict";
import { useTheme } from "../theme/context";

const LANG_LABELS: Record<Lang, { label: string; tag: string }> = {
  en: { label: "English", tag: "EN" },
  zh: { label: "简体中文", tag: "ZH" },
  ja: { label: "日本語", tag: "JA" },
};

// Bottom-right floating chrome — theme toggle + language picker. The
// design echoes the corner widget on the real Landing screen.
export function Chrome() {
  const { theme, toggle } = useTheme();
  const { lang, setLang, t } = useLang();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="chrome" role="toolbar" aria-label={t.a11yDisplayPrefs}>
      <button
        type="button"
        className="chrome-btn"
        onClick={toggle}
        aria-label={theme === "dark" ? t.a11yThemeToLight : t.a11yThemeToDark}
        title={theme === "dark" ? t.a11yThemeToLight : t.a11yThemeToDark}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
      <div className="lang-picker" ref={rootRef}>
        <button
          type="button"
          className="chrome-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="site-lang-menu"
          title={t.a11yLanguage}
          aria-label={t.a11yLanguage}
        >
          <span className="lang-glyph">
            <span className="lang-cjk">文</span>
            <span className="lang-latin">A</span>
          </span>
        </button>
        {open && (
          <div className="lang-menu" id="site-lang-menu">
            {SUPPORTED_LANGS.map((code) => {
              const meta = LANG_LABELS[code];
              const active = code === lang;
              return (
                <button
                  key={code}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  className={active ? "active" : undefined}
                  onClick={() => {
                    setLang(code);
                    setOpen(false);
                  }}
                >
                  <span>{meta.label}</span>
                  <span className="tag">{meta.tag}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.2 9.6A5 5 0 1 1 6.4 2.8a4 4 0 0 0 6.8 6.8z" />
    </svg>
  );
}
