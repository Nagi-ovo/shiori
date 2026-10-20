import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";

// The two notices the export dialog shows above its buttons: the warning that
// asks the user to confirm a lossy export, and the export failure with its
// copyable diagnostic code.

export function LossyExportNotice({ lostChars }: { lostChars: number }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      style={{
        padding: "11px 12px",
        borderRadius: 4,
        background: "#fff2cf",
        border: `1px solid #d9b65f`,
        color: T.ink,
        font: `13px/1.45 ${T.sans}`,
        marginBottom: 10,
      }}
    >
      <strong>{t("export.lostCharsConfirmTitle")}</strong>
      <div style={{ marginTop: 4 }}>
        {t("export.lostCharsConfirmBody", {
          count: lostChars,
        })}
      </div>
    </div>
  );
}

export function ExportErrorNotice({
  message,
  code,
  copyState,
  onCopy,
}: {
  message: string;
  code: string;
  copyState: "idle" | "copied" | "error";
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 4,
        background: "#f7e2de",
        border: `1px solid #e0b5ab`,
        color: "#7a2418",
        font: `13px/1.4 ${T.sans}`,
        marginBottom: 10,
      }}
    >
      <div>{message}</div>
      <div
        style={{
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <code
          style={{
            font: `500 11px/1 ${T.mono}`,
            color: "#7a2418",
            letterSpacing: ".04em",
          }}
        >
          {t("diagnostics.code", { code })}
        </code>
        <button
          type="button"
          onClick={onCopy}
          style={{
            appearance: "none",
            border: "1px solid #c78378",
            borderRadius: 4,
            background: "#fff7f4",
            color: "#7a2418",
            padding: "4px 8px",
            font: `600 11.5px/1 ${T.sans}`,
            cursor: "pointer",
          }}
        >
          {copyState === "copied"
            ? t("diagnostics.copied")
            : copyState === "error"
              ? t("diagnostics.copyFailed")
              : t("diagnostics.copy")}
        </button>
      </div>
    </div>
  );
}
