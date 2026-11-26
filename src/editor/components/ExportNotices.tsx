import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";

import type { AcceptanceFinding, AcceptanceFindingKind } from "../../pdf/export/acceptance";

const findingLabels: Record<AcceptanceFindingKind, { title: string; count?: string }> = {
  "lost-text": { title: "export.lostCharsConfirmTitle", count: "export.lostCharsConfirmBody" },
  "unexcised-edit": { title: "export.unexcisedConfirmTitle", count: "export.unexcisedConfirmBody" },
  "clipped-text": { title: "export.clippedConfirmTitle", count: "export.clippedConfirmBody" },
  "new-collision": { title: "export.review.new-collision" },
  "overflow-envelope": { title: "export.review.overflow-envelope" },
  "uncertain-contact": { title: "export.review.uncertain-contact" },
  "stripped-equivalent": { title: "export.review.stripped-equivalent" },
};

export function ExportReviewNotice({ findings }: { findings: readonly AcceptanceFinding[] }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      style={{
        padding: "11px 12px",
        borderRadius: 4,
        background: "#fff2cf",
        border: `1px solid #d9b65f`,
        // A fixed dark amber, not T.ink: the background does not follow the
        // theme, and dark themes' near-white ink vanished on it (~1.05:1).
        color: "#5a4210",
        font: `13px/1.45 ${T.sans}`,
        marginBottom: 10,
      }}
    >
      <ul style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 8 }}>
        {findings.map(({ kind, pageIndex, region, count }, index) => {
          const labels = findingLabels[kind];
          return (
            <li key={index}>
              <strong>{t(labels.title)}</strong>
              {pageIndex !== undefined && <div>{t("export.review.page", { page: pageIndex + 1 })}</div>}
              {region && <div>{t("export.review.region", region)}</div>}
              {count !== undefined && (
                <div>{t(labels.count ?? "export.review.count", { count })}</div>
              )}
            </li>
          );
        })}
      </ul>
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
