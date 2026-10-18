import { useState } from "react";
import { useTranslation } from "react-i18next";
// User-facing changelogs live under `docs/changelog/` and are written
// in plain-language prose — no commit SHAs, no postmortem links, no
// maintainer-facing preamble. The root `CHANGELOG.md` keeps the full
// maintainer history with SHAs; never import that one here.
import zhChangelog from "../../../docs/changelog/zh.md?raw";
import enChangelog from "../../../docs/changelog/en.md?raw";
import jaChangelog from "../../../docs/changelog/ja.md?raw";
import { T } from "../../design/tokens";
import { appVersion } from "../../runtime/version";
import { Modal } from "./ui";
import { Ic } from "./icons";
import { SponsorModal } from "./SponsorModal";
import { MarkdownView } from "./markdownView";
import { normalizeLanguage, pickFonts } from "./markdownLang";

type Props = {
  onClose: () => void;
};

const changelogs = {
  zh: zhChangelog,
  en: enChangelog,
  ja: jaChangelog,
} as const;

export function ChangelogModal({ onClose }: Props) {
  const { t, i18n } = useTranslation();
  // Changelog language always tracks the active UI language. Switch
  // language from the dedicated picker next to the version button —
  // the modal never owns a separate language toggle of its own.
  const language = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
  const markdown = changelogs[language];
  const fonts = pickFonts(language);
  const [showSponsor, setShowSponsor] = useState(false);

  return (
    <>
    <Modal
      onClose={onClose}
      title={t("changelog.title")}
      subtitle={`Shiori ${appVersion}`}
      width={760}
      // Suspend our own close wiring while the sponsor modal is
      // stacked on top, so its Escape/backdrop-click doesn't also
      // dismiss the changelog underneath.
      closeDisabled={showSponsor}
      footer={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <button
            type="button"
            onClick={() => setShowSponsor(true)}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              font: `500 11px/1.4 ${T.mono}`,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: T.dim,
              cursor: "pointer",
            }}
          >
            <Ic.heart width={12} height={12} />
            {t("sponsor.entry")}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: `1px solid ${T.ink}`,
              background: T.ink,
              color: T.surface,
              borderRadius: 4,
              padding: "8px 14px",
              font: `600 13px/1 ${fonts.sans}`,
              cursor: "pointer",
            }}
          >
            {t("changelog.close")}
          </button>
        </div>
      }
    >
      {/* `lang` attribute hints the browser's per-character font
          resolution so Simplified Chinese text picks SC variants and
          Japanese text picks JP variants even when a single fallback
          face covers both scripts. Works alongside our explicit
          per-language font stacks below. The Modal body is the only
          scroll container — wrapping the markdown in another
          `overflowY: auto` div used to nest two scrollbars and pinch
          the close button into a few invisible pixels at the bottom. */}
      <div lang={language}>
        <MarkdownView key={language} markdown={markdown} fonts={fonts} />
      </div>
    </Modal>
    {/* Sibling of the Modal, not a child — the changelog backdrop's
        backdrop-filter creates a containing block that would re-anchor
        a nested fixed overlay. Sponsor state stays local so App.tsx
        doesn't need to know this entry exists. */}
    {showSponsor ? (
      <SponsorModal onClose={() => setShowSponsor(false)} />
    ) : null}
    </>
  );
}
