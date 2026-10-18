import { Fragment } from "react";
import { renderRich, useLang } from "../i18n/context";
import { GROUPS, SHORTCUT_COPY } from "../content/shortcuts";
import { usesAppleKeys } from "../platform";

// Reuses the chip styling from <Kbd> but accepts the space-separated
// chord notation the in-app sheet uses (e.g. "⇧ ⌘ Z", "↑ ↓ ← →", "Space").
// `<Kbd>` itself is built for single-token chords like "⌘E" / "⇧⌘D" —
// switching it to handle both forms would touch the marketing pages, so
// instead we render here and let Kbd stay simple.

const IS_MAC = usesAppleKeys();
const MAC_TO_PC: Record<string, string> = {
  "⌘": "Ctrl",
  "⌥": "Alt",
  "⌃": "Ctrl",
};

function translateToken(tok: string): string {
  if (IS_MAC) return tok;
  return MAC_TO_PC[tok] ?? tok;
}

function Chord({ value }: { value: string }) {
  // " / " separates alternative chords (press any of these).
  const alternatives = value.split(/\s+\/\s+/);
  return (
    <span className="sc-chord">
      {alternatives.map((alt, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="sc-or" aria-hidden>
              /
            </span>
          )}
          <span className="kbd" aria-label={alt}>
            {alt
              .trim()
              .split(/\s+/)
              .map((rawTok, j) => {
                const tok = translateToken(rawTok);
                return (
                  <span
                    key={j}
                    className={
                      tok.length > 1 ? "kbd-key kbd-key-wide" : "kbd-key"
                    }
                  >
                    {tok}
                  </span>
                );
              })}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

export function Shortcuts() {
  const { t, lang } = useLang();
  const copy = SHORTCUT_COPY[lang];

  return (
    <section className="doc-section doc-shortcuts">
      <div className="wrap">
        <header className="doc-head">
          <div className="mono label">{t.shortcutsKicker}</div>
          <h1 className="doc-h1">{renderRich(t.shortcutsTitle)}</h1>
          <p className="doc-lede">{t.shortcutsLede}</p>
        </header>

        <div className="sc-grid">
          {GROUPS.map((g) => (
            <section className="sc-group" key={g.id}>
              <div className="mono sc-kind">{copy.groups[g.id]}</div>
              <dl className="sc-rows">
                {g.rows.map((row) => (
                  <div className="sc-row" key={row.rowKey}>
                    <dt>{copy.rows[row.rowKey]}</dt>
                    <dd>
                      <Chord value={row.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
