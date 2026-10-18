import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { subscribe, toast, type ToastItem } from "../toast";

export function ToastHost() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<ToastItem[]>([]);
  useEffect(() => subscribe(setCurrent), []);
  // Resolve structured payloads emitted by toast.showSaved into the active
  // locale. Keeping this logic in the host (not the helper) lets the helper
  // stay i18n-agnostic and callable from non-React code.
  const display = current.map((i) => {
    const m = i.message;
    if (typeof m === "string") return { ...i, message: m };
    if (m.kind === "savedTo") {
      return { ...i, message: t("toast.savedTo", { path: m.path }) };
    }
    if (m.kind === "sharedAs") {
      return { ...i, message: t("toast.sharedAs", { path: m.path }) };
    }
    if (m.kind === "liveAnnotations") {
      return { ...i, message: t("toast.liveAnnotations", { count: m.added }) };
    }
    return {
      ...i,
      message: t("toast.savedAs", { path: m.path }),
      detail: t("toast.savedAsHint"),
    };
  });
  const politeText = display
    .filter((i) => i.tone !== "error")
    .map(toAnnouncementText)
    .join("\n");
  const assertiveText = display
    .filter((i) => i.tone === "error")
    .map(toAnnouncementText)
    .join("\n");
  return (
    <div
      className="shioriPrintHide"
      style={{
        position: "fixed",
        right: 20,
        // Above the phone's gesture bar (0 on desktop).
        bottom: "calc(48px + var(--shiori-safe-bottom, 0px))",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "flex-end",
        zIndex: 50,
        pointerEvents: "none",
      }}
    >
      <div role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
        {politeText}
      </div>
      <div role="alert" aria-live="assertive" style={VISUALLY_HIDDEN}>
        {assertiveText}
      </div>
      {display.map((i) => (
        <div
          key={i.id}
          style={{
            background: i.tone === "error" ? "#5a1f18" : T.ink,
            color: i.tone === "error" ? "#ffd7d0" : T.cream,
            border: `1px solid ${i.tone === "error" ? "#7a2a20" : T.ink2}`,
            borderRadius: 6,
            padding: "10px 14px",
            font: `500 12.5px/1.35 ${T.sans}`,
            boxShadow: "0 14px 40px rgba(10,8,6,0.28)",
            pointerEvents: "auto",
            maxWidth: 420,
            minWidth: 200,
            animation: "opxToastIn 180ms ease",
          }}
        >
          <style>{`@keyframes opxToastIn { from { transform: translateY(8px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }`}</style>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span
              style={{
                flex: "0 0 auto",
                marginTop: 1,
                color: i.tone === "error" ? "#ffd7d0" : T.cream,
              }}
            >
              {/* Not an X: a status glyph shaped like a close button reads as
                  one, and clicking it did nothing (reported on Windows). */}
              {i.tone === "error" ? <Ic.alert /> : <Ic.check />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ wordBreak: "break-word" }}>{i.message}</div>
              {i.detail ? (
                <div
                  style={{
                    marginTop: 4,
                    font: `11.5px/1.3 ${T.mono}`,
                    color: i.tone === "error" ? "#ffb4a8" : T.dim2,
                    letterSpacing: ".02em",
                  }}
                >
                  {i.detail}
                </div>
              ) : null}
            </div>
            {i.action ? (
              <button
                type="button"
                onClick={() => {
                  i.action?.onClick();
                  toast.dismiss(i.id);
                }}
                style={{
                  flex: "0 0 auto",
                  alignSelf: "center",
                  marginLeft: 4,
                  padding: "4px 10px",
                  border: `1px solid ${T.dim2}`,
                  background: "transparent",
                  color: T.cream,
                  borderRadius: 4,
                  font: `600 12px/1.2 ${T.sans}`,
                  cursor: "pointer",
                  letterSpacing: ".02em",
                }}
              >
                {i.action.label}
              </button>
            ) : null}
            {i.actions?.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => {
                  action.onClick();
                  toast.dismiss(i.id);
                }}
                style={{
                  flex: "0 0 auto",
                  alignSelf: "center",
                  marginLeft: 4,
                  padding: "4px 10px",
                  border: `1px solid ${T.dim2}`,
                  background: "transparent",
                  color: T.cream,
                  borderRadius: 4,
                  font: `600 12px/1.2 ${T.sans}`,
                  cursor: "pointer",
                  letterSpacing: ".02em",
                }}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => toast.dismiss(i.id)}
              style={{
                flex: "0 0 auto",
                alignSelf: "flex-start",
                display: "grid",
                placeItems: "center",
                width: 22,
                height: 22,
                margin: "-2px -6px 0 2px",
                padding: 0,
                border: 0,
                borderRadius: 4,
                background: "transparent",
                color: i.tone === "error" ? "#ffb4a8" : T.dim2,
                cursor: "pointer",
              }}
            >
              <Ic.x width={14} height={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Display items have already resolved structured payloads to strings.
function toAnnouncementText(item: { message: string; detail?: string }): string {
  return item.detail ? `${item.message}. ${item.detail}` : item.message;
}

const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
} satisfies CSSProperties;
