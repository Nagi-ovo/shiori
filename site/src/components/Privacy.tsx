import { renderRich, useLang } from "../i18n/context";
import { linkify } from "./linkify";

export function Privacy() {
  const { t } = useLang();
  const items: Array<{ k: string; v: string }> = [
    { k: t.privacyKeep, v: t.privacyKeepBody },
    { k: t.privacyKnow, v: t.privacyKnowBody },
    { k: t.privacyUpdate, v: t.privacyUpdateBody },
    { k: t.privacyContact, v: t.privacyContactBody },
  ];

  return (
    <section className="section section-privacy" id="privacy">
      <div className="wrap">
        <div className="section-h">
          <div className="mono label">{t.privacyKicker}</div>
          <h2>{renderRich(t.privacyTitle)}</h2>
        </div>

        <div className="privacy">
          <p className="privacy-lede">{t.privacyLede}</p>
          <dl className="privacy-list">
            {items.map((item) => (
              <div className="privacy-row" key={item.k}>
                <dt>{item.k}</dt>
                <dd>{linkify(item.v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
