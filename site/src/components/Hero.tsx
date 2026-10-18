import { getDownloadTarget, recommendDownloadFor } from "../downloads";
import { useLang } from "../i18n/context";
import type { Dict } from "../i18n/dict";
import { usePlatform } from "../platform";
import { HeroDemo } from "./HeroDemo";

export function Hero() {
  const { t } = useLang();
  const platform = usePlatform();
  const recommended = recommendDownloadFor(platform);
  const target = getDownloadTarget(recommended);
  const primaryCta = getHeroPrimaryCta(t, recommended);

  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="dot" />
            <span>{t.heroEyebrow}</span>
          </span>
          <h1 className="h1">
            <span className="h1-line">
              {renderHeroLine(t.heroLine1, t.heroFocus)}
            </span>
            <br />
            <span className="h1-line">
              {renderHeroLine(`${t.heroLine2}${t.heroAccent}`, t.heroFocus)}
            </span>
            {t.heroSubKana && <span className="h1-jp">{t.heroSubKana}</span>}
          </h1>
          <p className="lede">{t.heroLede}</p>
          <div className="hero-actions">
            <a className="btn" href={target?.href ?? "#download"}>
              <span>{primaryCta}</span>
            </a>
            <a
              className="btn btn-ghost"
              href="https://app.shiori.nagi.fun"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.heroCtaSecondary}
            </a>
          </div>
          <div className="checks">
            <span>{t.heroCheckSize}</span>
            <span>{t.heroCheckLocal}</span>
            <span>{t.heroCheckOffline}</span>
          </div>
        </div>
        <HeroDemo />
      </div>
    </section>
  );
}

const FINAL_PUNCTUATION = /[.!?。！？]$/u;

function renderHeroLine(text: string, focus: string) {
  const focusStart = focus ? text.indexOf(focus) : -1;
  if (focusStart < 0) return renderWithoutOrphanPunctuation(text);

  const before = text.slice(0, focusStart);
  const focusText = text.slice(focusStart, focusStart + focus.length);
  const after = text.slice(focusStart + focus.length);

  if (after.length === 1 && FINAL_PUNCTUATION.test(after)) {
    return (
      <>
        {renderWithoutOrphanPunctuation(before)}
        <span className="h1-no-orphan">
          <em>{focusText}</em>
          {after}
        </span>
      </>
    );
  }

  return (
    <>
      {renderWithoutOrphanPunctuation(before)}
      <em>{focusText}</em>
      {renderWithoutOrphanPunctuation(after)}
    </>
  );
}

function renderWithoutOrphanPunctuation(text: string) {
  if (!text) return null;

  const dashBreak = text.lastIndexOf(" — ");
  if (dashBreak > 0) {
    return (
      <>
        {text.slice(0, dashBreak)}{" "}
        <span className="h1-no-orphan">{text.slice(dashBreak + 1)}</span>
      </>
    );
  }

  const lastSpace = text.lastIndexOf(" ");
  if (lastSpace > 0 && lastSpace < text.length - 1) {
    return (
      <>
        {text.slice(0, lastSpace + 1)}
        <span className="h1-no-orphan">{text.slice(lastSpace + 1)}</span>
      </>
    );
  }

  const chars = Array.from(text);
  if (chars.length > 1 && FINAL_PUNCTUATION.test(text)) {
    return (
      <>
        {chars.slice(0, -2).join("")}
        <span className="h1-no-orphan">{chars.slice(-2).join("")}</span>
      </>
    );
  }

  return text;
}

function getHeroPrimaryCta(
  t: Dict,
  recommended: ReturnType<typeof recommendDownloadFor>,
): string {
  switch (recommended) {
    case "macSilicon":
      return t.heroCtaPrimary;
    case "macIntel":
      return t.heroCtaMacIntel;
    case "windows":
      return t.heroCtaWindows;
    case "linuxAppImage":
      return t.heroCtaLinux;
    case "androidApk":
      return t.heroCtaAndroid;
    default:
      return t.heroCtaOptions;
  }
}
