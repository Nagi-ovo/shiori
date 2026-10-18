import { useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import type { CanvasCapabilityReport } from "../../platform/canvasCapabilities";
import { IconBtn, Modal } from "./ui";

type Props = {
  report: CanvasCapabilityReport;
  onClose: () => void;
  onRetry: () => Promise<boolean>;
};

export function CanvasCapabilityDialog({ report, onClose, onRetry }: Props) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [checking, setChecking] = useState(false);

  const copyOrigin = async () => {
    try {
      await navigator.clipboard.writeText(report.origin);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  };

  const retry = async () => {
    setChecking(true);
    try {
      await onRetry();
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t("canvasWarning.title")} width={520}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          font: `14px/1.58 ${T.sans}`,
          color: T.ink2,
        }}
      >
        <p style={{ margin: 0 }}>{t("canvasWarning.body")}</p>
        <div>
          <div
            style={{
              font: `600 12px/1.2 ${T.sans}`,
              color: T.ink,
              marginBottom: 7,
            }}
          >
            {t("canvasWarning.siteLabel")}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            <code
              style={{
                flex: 1,
                minWidth: 0,
                overflowWrap: "anywhere",
                padding: "8px 9px",
                border: `1px solid ${T.rule}`,
                borderRadius: 4,
                background: T.surface,
                color: T.ink,
                font: `12px/1.35 ${T.mono}`,
              }}
            >
              {report.origin}
            </code>
            <IconBtn tone="outline" onClick={copyOrigin}>
              {copyState === "copied"
                ? t("canvasWarning.copied")
                : copyState === "error"
                  ? t("canvasWarning.copyFailed")
                  : t("canvasWarning.copySite")}
            </IconBtn>
          </div>
        </div>
        <div
          style={{
            padding: "10px 12px",
            border: `1px solid ${T.ruleSoft}`,
            borderRadius: 4,
            background: T.tint,
          }}
        >
          <div
            style={{
              font: `600 12px/1.2 ${T.sans}`,
              color: T.ink,
              marginBottom: 7,
            }}
          >
            {t("canvasWarning.effectsTitle")}
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              display: "grid",
              gap: 4,
            }}
          >
            <li>{t("canvasWarning.effectRender")}</li>
            <li>{t("canvasWarning.effectThumbs")}</li>
            <li>{t("canvasWarning.effectExport")}</li>
          </ul>
        </div>
        <p style={{ margin: 0, color: T.dim }}>
          {t("canvasWarning.footer")}
        </p>
      </div>
      <div
        style={{
          marginTop: 18,
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <IconBtn tone="outline" onClick={retry} disabled={checking}>
          {checking ? t("canvasWarning.checking") : t("canvasWarning.retry")}
        </IconBtn>
        <IconBtn tone="primary" onClick={onClose}>
          {t("canvasWarning.continue")}
        </IconBtn>
      </div>
    </Modal>
  );
}
