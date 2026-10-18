import { useEffect, useMemo, useRef } from "react";
import { renderRich, useLang } from "../i18n/context";
import { getReleases } from "../content/changelog";
import {
  changelogHref,
  releaseAnchorId,
  useChangelogVersion,
} from "../router/route";

export function Changelog() {
  const { t, lang } = useLang();
  const releases = useMemo(() => getReleases(lang), [lang]);
  const version = useChangelogVersion();
  // The version this page last landed on; undefined until the first run.
  const landed = useRef<string | null | undefined>(undefined);

  // `#/changelog/<version>` lands on that release. useRoute leaves the scroll
  // alone for these hashes, so an unknown version must go to the top here.
  // Keyed on the version only: switching language keeps the reader's place.
  useEffect(() => {
    // Arrival, not an in-page version link. Comparing versions rather than
    // keeping a boolean also holds when StrictMode re-runs the effect.
    const first = landed.current === undefined || landed.current === version;
    landed.current = version;
    if (!version) return;
    const target = document.getElementById(releaseAnchorId(version));
    // Instant on arrival (html has `scroll-behavior: smooth`, which would make
    // a cold load glide down the page); smooth for in-page version links.
    const behavior: ScrollBehavior = first ? "instant" : "smooth";
    if (!target) {
      window.scrollTo({ top: 0, behavior });
      return;
    }
    target.scrollIntoView({ block: "start", behavior });
    if (!first || document.fonts.status === "loaded") return;
    // On a cold load the web fonts swap in after this scroll and reflow
    // everything above the release, leaving it off its mark. Land again
    // once they are in, unless the reader has already started scrolling.
    // (Not judged by scrollY: scroll anchoring moves it during the reflow.)
    let cancelled = false;
    const INTENT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    const stop = () => {
      cancelled = true;
    };
    INTENT.forEach((type) => window.addEventListener(type, stop, { once: true, passive: true }));
    const release = () => INTENT.forEach((type) => window.removeEventListener(type, stop));
    void document.fonts.ready.then(() => {
      release();
      if (!cancelled) target.scrollIntoView({ block: "start", behavior: "instant" });
    });
    return () => {
      stop();
      release();
    };
  }, [version]);

  return (
    <section className="doc-section doc-changelog">
      <div className="wrap">
        <header className="doc-head">
          <div className="mono label">{t.changelogKicker}</div>
          <h1 className="doc-h1">{renderRich(t.changelogTitle)}</h1>
          <p className="doc-lede">{t.changelogLede}</p>
        </header>

        <ol className="cl-list">
          {releases.map((r) => (
            <li className="cl-release" key={r.version} id={releaseAnchorId(r.version)}>
              <div className="cl-rail">
                <a className="cl-ver" href={changelogHref(r.version)}>
                  <span className="cl-ver-tag">v</span>
                  {r.version}
                </a>
                {r.date && <div className="cl-date">{r.date}</div>}
              </div>
              <div className="cl-body">
                {r.epigraph && (
                  <p className="cl-epigraph">{r.epigraph}</p>
                )}
                {r.groups.map((g) => (
                  <div className="cl-group" key={g.kind}>
                    <div className="mono cl-kind">{g.kind}</div>
                    <ul className="cl-items">
                      {g.items.map((item, i) => (
                        <li className="cl-item" key={i}>
                          {item.lead && (
                            <strong className="cl-lead">{item.lead}</strong>
                          )}
                          {item.lead && item.rest && " "}
                          {item.rest && (
                            <span className="cl-rest">{item.rest}</span>
                          )}
                          {item.table && (
                            <div className="cl-table-wrap">
                              <table className="cl-table">
                                <thead>
                                  <tr>
                                    {item.table.header.map((cell, c) => (
                                      <th key={c} style={{ textAlign: item.table!.align[c] ?? undefined }}>
                                        {cell}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.table.rows.map((row, r) => (
                                    <tr key={r}>
                                      {item.table!.header.map((_, c) => (
                                        <td key={c} style={{ textAlign: item.table!.align[c] ?? undefined }}>
                                          {row[c] ?? ""}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
