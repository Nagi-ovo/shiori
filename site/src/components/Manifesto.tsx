import { renderRich, useLang } from "../i18n/context";

export function Manifesto() {
  const { t } = useLang();
  return (
    <section className="section" id="manifesto">
      <div className="wrap">
        <div className="section-h">
          <div className="mono label">{t.manifestoKicker}</div>
          <h2>{renderRich(t.manifestoTitle)}</h2>
        </div>
        <div className="manifesto">
          <div className="mono label">{t.manifestoSide}</div>
          <div>
            <p>
              <span>{t.manifestoP1}</span>
              {t.manifestoP1Kana && (
                <span className="jp">{t.manifestoP1Kana}</span>
              )}
            </p>
            <p>
              <span>{t.manifestoP2}</span>
              {t.manifestoP2Kana && (
                <span className="jp">{t.manifestoP2Kana}</span>
              )}
            </p>
            <p>{t.manifestoP3}</p>

            <div className="manifesto-quote">
              {t.manifestoQuote}
              <span className="src">{t.manifestoQuoteSrc}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
