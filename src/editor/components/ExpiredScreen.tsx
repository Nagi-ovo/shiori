import { useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { ShioriTile } from "../../brand/Mark";
import { IconBtn } from "./ui";
import { buildDate, expiresAt, releaseUrl } from "../../runtime/expiry";
import { CAPABILITIES, IS_MAC } from "../../platform";
import { WINDOW_CAPTION_WIDTH } from "../../platform/windowCaption";

function formatDate(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function ExpiredScreen() {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);

  const built = buildDate();
  const expired = expiresAt();
  const builtLabel = built ? formatDate(built, i18n.language) : "—";
  const expiredLabel = expired ? formatDate(expired, i18n.language) : "—";

  // With tauri.conf.json's titleBarStyle: "Overlay" the macOS traffic lights
  // float in the top-left of the webview; reserve ~82px so the tile +
  // wordmark doesn't collide with the close/min/max buttons.
  const overlayPadLeft = CAPABILITIES.nativeWindowChrome && IS_MAC;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(releaseUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can fail in some webview configurations; ignore
      // and let the user select the URL text manually.
    }
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: T.paper,
        display: "flex",
        flexDirection: "column",
        fontFamily: T.sans,
        color: T.ink,
        overflow: "hidden",
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          // Left clears the macOS traffic lights, right the Windows caption.
          padding: `14px ${
            CAPABILITIES.customWindowCaption ? WINDOW_CAPTION_WIDTH + 12 : 20
          }px 14px ${overlayPadLeft ? 82 : 20}px`,
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: `1px solid ${T.rule}`,
          background: T.cream,
          flex: "0 0 auto",
        }}
      >
        <ShioriTile size={20} radius={0.22} />
        <span
          style={{
            fontFamily: T.klee,
            fontWeight: 600,
            fontSize: 16,
            lineHeight: 1,
            color: T.ink,
          }}
        >
          {t("app.brand")}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          overflow: "auto",
        }}
      >
        <div style={{ maxWidth: 520, textAlign: "center" }}>
          <div
            style={{
              font: `${T.displayStyle} 32px/1.1 ${T.serif}`,
              color: T.ink,
              letterSpacing: "-.01em",
              marginBottom: 12,
            }}
          >
            {t("expired.title")}
          </div>
          <div
            style={{
              font: `14.5px/1.6 ${T.sans}`,
              color: T.ink2,
              marginBottom: 20,
            }}
          >
            {t("expired.body", { built: builtLabel, expired: expiredLabel })}
          </div>
          <div
            style={{
              font: `500 12.5px/1.5 ${T.mono}`,
              color: T.ink,
              background: T.surface,
              border: `1px solid ${T.rule}`,
              borderRadius: 4,
              padding: "10px 14px",
              wordBreak: "break-all",
              userSelect: "all",
              marginBottom: 16,
            }}
          >
            {releaseUrl}
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <IconBtn tone="primary" onClick={copy}>
              {copied ? t("expired.copied") : t("expired.copy")}
            </IconBtn>
          </div>
          <div
            style={{
              marginTop: 22,
              font: `12.5px/1.5 ${T.sans}`,
              color: T.dim,
            }}
          >
            {t("expired.footnote")}
          </div>
        </div>
      </div>
    </div>
  );
}
