import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { openExternalUrl } from "../../platform";
import { Modal } from "./ui";
import wechatQr from "../../assets/sponsor/wechat.png";
import alipayQr from "../../assets/sponsor/alipay.png";

type Props = {
  onClose: () => void;
};

export function SponsorModal({ onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Modal onClose={onClose} title={t("sponsor.title")} width={400}>
      <div
        style={{
          font: `13px/1.6 ${T.sans}`,
          color: T.ink2,
          marginBottom: 16,
        }}
      >
        {t("sponsor.thanks")}
      </div>
      <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
        <QrSlot src={wechatQr} caption={t("sponsor.wechat")} />
        <QrSlot src={alipayQr} caption={t("sponsor.alipay")} />
      </div>
      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: `1px solid ${T.rule}`,
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            font: `500 11px/1 ${T.mono}`,
            color: T.dim,
            letterSpacing: ".08em",
            textTransform: "uppercase",
          }}
        >
          {t("sponsor.more")}
        </span>
        {SPONSOR_CHANNELS.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => void openExternalUrl(c.url)}
            style={{
              border: "none",
              background: "none",
              padding: 0,
              cursor: "pointer",
              font: `500 11px/1 ${T.mono}`,
              color: T.ink2,
              letterSpacing: ".06em",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

// Proper nouns — not localized.
const SPONSOR_CHANNELS = [
  { label: "GitHub Sponsors", url: "https://github.com/sponsors/Nagi-ovo" },
  { label: "Buy Me a Coffee", url: "https://www.buymeacoffee.com/Nag1ovo" },
  { label: "爱发电 Afdian", url: "https://afdian.com/a/nagi-ovo" },
];

function QrSlot({ src, caption }: { src: string; caption: string }) {
  return (
    <figure
      style={{
        margin: 0,
        flex: "1 1 0",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}
    >
      <img
        src={src}
        alt={caption}
        style={{
          width: "100%",
          maxWidth: 150,
          aspectRatio: "1",
          objectFit: "contain",
          background: T.surface,
          border: `1px solid ${T.rule}`,
          borderRadius: 6,
          padding: 8,
        }}
      />
      <figcaption
        style={{
          font: `500 11px/1 ${T.mono}`,
          color: T.dim,
          letterSpacing: ".08em",
          textTransform: "uppercase",
        }}
      >
        {caption}
      </figcaption>
    </figure>
  );
}
