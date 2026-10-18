import { renderRich, useLang } from "../i18n/context";
import { useRelease } from "../release/context";

export function Specs() {
  const { t } = useLang();
  const release = useRelease();
  // Apple Silicon native dmg is the smallest, freshest representative
  // of the current build. Fall back to a sensible static figure while
  // the /api/release fetch is in flight or unavailable.
  const siliconBytes = release?.platforms?.["mac-silicon"]?.size;
  const diskMb =
    typeof siliconBytes === "number"
      ? Math.floor(siliconBytes / 1_000_000)
      : 14;
  return (
    <section className="section" id="specs">
      <div className="wrap">
        <div className="section-h">
          <div className="mono label">{t.specsKicker}</div>
          <h2>{renderRich(t.specsTitle)}</h2>
        </div>

        <div className="specs">
          <div className="spec">
            <div className="k">{t.s1K}</div>
            <div className="v">
              &lt; <em>180</em>ms
            </div>
            <div className="sub">{t.s1Sub}</div>
          </div>
          <div className="spec">
            <div className="k">{t.s2K}</div>
            <div className="v">
              <em>{diskMb}</em>MB
            </div>
            <div className="sub">{t.s2Sub}</div>
          </div>
          <div className="spec">
            <div className="k">{t.s3K}</div>
            <div className="v">
              0<em>/</em>0
            </div>
            <div className="sub">{t.s3Sub}</div>
          </div>
          <div className="spec">
            <div className="k">{t.s4K}</div>
            <div className="v">
              <em>PDF</em>
              <span className="sep">/</span>
              MD
              <span className="sep">/</span>
              HTML
            </div>
            <div className="sub">{t.s4Sub}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
