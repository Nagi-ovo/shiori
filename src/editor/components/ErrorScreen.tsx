import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { IconBtn } from "./ui";
import type { ErrorInfo } from "../store/store";
import { ShioriTile } from "../../brand/Mark";
import { CAPABILITIES, IS_MAC } from "../../platform";
import { WINDOW_CAPTION_WIDTH } from "../../platform/windowCaption";
import { copyDiagnosticReport } from "../../runtime/diagnostics";

type Props = {
  info: ErrorInfo;
  onRetry: () => void;
  onDismiss: () => void;
};

export function ErrorScreen({ info, onRetry, onDismiss }: Props) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const copyResetTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );
  const showCopyState = (state: "copied" | "error") => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    setCopyState(state);
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyResetTimerRef.current = null;
    }, 1800);
  };
  // titleBarStyle: "Overlay" floats macOS traffic lights over the webview;
  // reserve ~82px so the tile + wordmark don't collide with close/min/max.
  const overlayPadLeft = CAPABILITIES.nativeWindowChrome && IS_MAC;
  const onCopyDiagnostic = async () => {
    if (!info.diagnosticReport) return;
    try {
      await copyDiagnosticReport(info.diagnosticReport);
      showCopyState("copied");
    } catch {
      showCopyState("error");
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
        <div style={{ maxWidth: 460, textAlign: "center" }}>
          <div
            style={{
              width: 72,
              height: 86,
              margin: "0 auto 24px",
              border: `1.5px solid ${T.ink}`,
              background: T.surface,
              position: "relative",
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width="46"
              height="46"
              viewBox="0 0 46 46"
              fill="none"
              stroke={T.rect}
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M10 10L36 36M36 10L10 36" />
            </svg>
            <div
              style={{
                position: "absolute",
                top: -1,
                right: -1,
                width: 14,
                height: 14,
                background: T.paper,
                borderLeft: `1.5px solid ${T.ink}`,
                borderBottom: `1.5px solid ${T.ink}`,
              }}
            />
          </div>
          <div
            style={{
              font: `${T.displayStyle} 32px/1.1 ${T.serif}`,
              color: T.ink,
              letterSpacing: "-.01em",
              marginBottom: 12,
            }}
          >
            {info.title || t("error.title")}
          </div>
          <div
            style={{
              font: `14.5px/1.55 ${T.sans}`,
              color: T.ink2,
            }}
          >
            <code
              style={{
                font: `500 13px ${T.mono}`,
                color: T.ink,
                wordBreak: "break-all",
              }}
            >
              {info.file}
            </code>{" "}
            {info.message || t("error.message")}
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "center",
              marginTop: 24,
              flexWrap: "wrap",
            }}
          >
            <IconBtn tone="outline" onClick={onRetry}>
              {t("error.retry")}
            </IconBtn>
            {info.diagnosticReport ? (
              <IconBtn tone="outline" onClick={onCopyDiagnostic}>
                {copyState === "copied"
                  ? t("diagnostics.copied")
                  : copyState === "error"
                    ? t("diagnostics.copyFailed")
                    : t("diagnostics.copy")}
              </IconBtn>
            ) : null}
            <IconBtn tone="primary" onClick={onDismiss}>
              {t("error.dismiss")}
            </IconBtn>
          </div>
          {info.code ? (
            <div
              style={{
                marginTop: 22,
                font: `500 11px/1.4 ${T.mono}`,
                color: T.dim2,
                letterSpacing: ".06em",
                textTransform: "uppercase",
              }}
            >
              {t("diagnostics.code", { code: info.code })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
