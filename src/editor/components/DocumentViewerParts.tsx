import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { IconBtn } from "./ui";
import type { MarkdownViewMode } from "./DocumentViewer";

export function MarkdownEditorLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        justifyContent: "center",
        padding: "clamp(28px, 5vw, 72px) 16px",
        background: T.paper,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: "min(100%, 720px)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          opacity: 0.5,
        }}
      >
        {["42%", "78%", "64%"].map((width) => (
          <span
            key={width}
            style={{
              display: "block",
              width,
              height: 10,
              borderRadius: 3,
              background: T.rule,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function MarkdownModeToggle({
  mode,
  onChange,
}: {
  mode: MarkdownViewMode;
  onChange: (mode: MarkdownViewMode) => void;
}) {
  const { t } = useTranslation();
  const editing = mode === "edit";
  return (
    <IconBtn
      title={t(
        editing ? "documents.previewMarkdown" : "documents.editMarkdown",
      )}
      active={editing}
      onClick={() => onChange(editing ? "preview" : "edit")}
    >
      {editing ? <Ic.edit aria-hidden /> : <Ic.bookOpen aria-hidden />}
    </IconBtn>
  );
}

export function RemoteImageNotice({
  count,
  onLoad,
  onDismiss,
}: {
  count: number;
  onLoad: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        color: T.dim,
        font: `500 12px/1.35 ${T.sans}`,
      }}
    >
      <span style={{ minWidth: 0, flex: 1 }}>
        {t("documents.remoteImagesBlocked", { count })}
      </span>
      <button
        type="button"
        onClick={onLoad}
        style={{
          flex: "0 0 auto",
          height: 26,
          padding: "0 12px",
          borderRadius: 6,
          border: `1px solid ${T.accent}`,
          background: T.accent,
          color: T.onAccent,
          font: `600 12px/1 ${T.sans}`,
          cursor: "pointer",
        }}
      >
        {t("documents.loadRemoteImages")}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          flex: "0 0 auto",
          height: 26,
          padding: "0 9px",
          borderRadius: 6,
          border: `1px solid ${T.rule}`,
          background: T.surface,
          color: T.ink2,
          font: `500 12px/1 ${T.sans}`,
          cursor: "pointer",
        }}
      >
        {t("documents.dismissRemoteImages")}
      </button>
    </div>
  );
}

export function DocumentControlBar({
  leading,
  trailing,
}: {
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  if (!leading && !trailing) return null;
  return (
    <div
      style={{
        flex: "0 0 auto",
        minHeight: 36,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "4px 12px",
        // The active tab's colour, so the tab above joins this bar (see the
        // PDF toolbar in ContextualToolbar).
        background: T.paper,
        borderBottom: `1px solid ${T.rule}`,
      }}
    >
      <div
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {leading}
      </div>
      {trailing ? (
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}

export function RenderError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        border: `1px solid ${T.rule}`,
        background: T.cream,
        color: T.rect,
        padding: 16,
        borderRadius: 6,
        font: `500 13px/1.5 ${T.sans}`,
      }}
    >
      {message}
    </div>
  );
}

export function LoadingBlock() {
  return (
    <div
      aria-hidden
      style={{
        height: 96,
        borderRadius: 6,
        background: T.cream,
        border: `1px solid ${T.rule}`,
      }}
    />
  );
}
