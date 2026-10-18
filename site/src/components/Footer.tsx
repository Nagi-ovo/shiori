import { useLang } from "../i18n/context";
import { useRelease } from "../release/context";
import { Brand } from "./Brand";

export function Footer() {
  const { t } = useLang();
  const release = useRelease();
  const versionLabel = release ? `V ${release.version} · ` : "";
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-grid">
          <div className="footer-brand">
            <Brand />
            <p className="colophon">
              <span>{t.footerColophon}</span>
              {t.footerColophonKana && (
                <span className="jp">{t.footerColophonKana}</span>
              )}
            </p>
          </div>
          <div className="foot-col">
            <h4>{t.footerProduct}</h4>
            <a href="#features">{t.navFeatures}</a>
            <a href="#specs">{t.navSpecs}</a>
            <a href="#download">{t.navDownload}</a>
            <a href="#/changelog">{t.footerChangelog}</a>
          </div>
          <div className="foot-col">
            <h4>{t.footerResources}</h4>
            <a href="#/shortcuts">{t.footerKeymap}</a>
            <a href="#/privacy">{t.footerPrivacy}</a>
            <a href="#/support">{t.footerSupport}</a>
          </div>
        </div>
        <div className="footer-base">
          <span>
            SHIORI{t.brandKana ? ` · ${t.brandKana}` : ""} · {versionLabel}
            BETA · © 2026
          </span>
          <span className="ip">{t.footerTagline}</span>
          <span>{t.footerPrivacyShort}</span>
        </div>
      </div>
    </footer>
  );
}
