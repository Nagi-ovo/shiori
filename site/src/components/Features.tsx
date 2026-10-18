import { renderRich, useLang } from "../i18n/context";
import { Kbd } from "./Kbd";

export function Features() {
  const { t } = useLang();
  return (
    <section className="section" id="features">
      <div className="wrap">
        <div className="section-h">
          <div className="mono label">{t.featuresKicker}</div>
          <h2>{renderRich(t.featuresTitle)}</h2>
        </div>
        <div className="feat-grid">
          <article className="feat">
            <div className="num">{t.feat1Num}</div>
            <h3>
              <span>{t.feat1Title}</span>
              {t.feat1Kana && <span className="jp">{t.feat1Kana}</span>}
            </h3>
            <p>{renderRich(t.feat1Body)}</p>
            <div className="art art-jar">
              <div className="row">
                <b>Application Support/Shiori</b>
                <span className="ok">{t.feat1Local}</span>
              </div>
              <div className="row">
                <span>document.pdf</span>
                <span>5.4 MB</span>
              </div>
              <div className="row">
                <span>annotations.shiori</span>
                <span>14 kB</span>
              </div>
              <div className="row">
                <span>{t.feat1Cloud}</span>
                <span className="x">{t.feat1Never}</span>
              </div>
              <div className="row full">
                <span>{t.feat1Telemetry}</span>
                <span className="x">{t.feat1Never}</span>
              </div>
            </div>
          </article>

          <article className="feat">
            <div className="num">{t.feat2Num}</div>
            <h3>
              <span>{t.feat2Title}</span>
              {t.feat2Kana && <span className="jp">{t.feat2Kana}</span>}
            </h3>
            <p>{t.feat2Body}</p>
            <div className="art art-tools">
              <div className="art-tool">
                <span className="art-tool-icon">
                  <span
                    className="swatch"
                    style={{ background: "#f4d674" }}
                  />
                </span>
                <span className="art-tool-name">{t.toolHighlight}</span>
                <Kbd keys="H" />
              </div>
              <div className="art-tool">
                <span className="art-tool-icon">✎</span>
                <span className="art-tool-name">{t.toolInk}</span>
                <Kbd keys="I" />
              </div>
              <div className="art-tool">
                <span className="art-tool-icon">✓</span>
                <span className="art-tool-name">{t.toolStamp}</span>
                <Kbd keys="S" />
              </div>
              <div className="art-tool">
                <span className="art-tool-icon">▭</span>
                <span className="art-tool-name">{t.toolRect}</span>
                <Kbd keys="R" />
              </div>
              <div className="art-tool">
                <span className="art-tool-icon">☐</span>
                <span className="art-tool-name">{t.toolNote}</span>
                <Kbd keys="N" />
              </div>
              <div className="art-tool">
                <span className="art-tool-icon">T</span>
                <span className="art-tool-name">{t.toolText}</span>
                <Kbd keys="T" />
              </div>
            </div>
          </article>

          <article className="feat">
            <div className="num">{t.feat3Num}</div>
            <h3>
              <span>{t.feat3Title}</span>
              {t.feat3Kana && <span className="jp">{t.feat3Kana}</span>}
            </h3>
            <p>{t.feat3Body}</p>
            <div className="art art-export">
              <div className="opt">
                <span className="ext">PDF</span>
                <span className="opt-desc">{t.feat3Opt1}</span>
                <span className="opt-kbd">
                  <Kbd keys="⌘E" />
                </span>
              </div>
              <div className="opt">
                <span className="ext">PDF</span>
                <span className="opt-desc">{t.feat3Opt2}</span>
                <span className="opt-kbd">
                  <Kbd keys="⇧⌘E" />
                </span>
              </div>
              <div className="opt">
                <span className="ext alt">JSON</span>
                <span className="opt-desc">{t.feat3Opt3}</span>
                <span className="opt-kbd">
                  <Kbd keys="⌥⌘E" />
                </span>
              </div>
              <div className="opt">
                <span className="ext">PNG</span>
                <span className="opt-desc">{t.feat3Opt4}</span>
                <span className="opt-kbd">
                  <Kbd keys="⌘⇧4" />
                </span>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
