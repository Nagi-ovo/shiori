import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "../../editor/components/icons";
import { IconBtn } from "../../editor/components/ui";
import type { WorkspaceRuntimeTab } from "../../workspace/types";
import { describeRestoreError } from "./restoreError";

/** The viewport of a tab whose document is loading or could not be restored. */
export function DocumentLoadingState({
  tab,
  onRetry,
}: {
  tab: WorkspaceRuntimeTab;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: T.dim,
        font: `500 13px/1.5 ${T.sans}`,
      }}
    >
      {tab.status === "unavailable" ? (
        <UnavailableTabMessage tab={tab} t={t} onRetry={onRetry} />
      ) : (
        t("documents.loading")
      )}
    </div>
  );
}

function UnavailableTabMessage({
  tab,
  t,
  onRetry,
}: {
  tab: WorkspaceRuntimeTab;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onRetry: () => void;
}) {
  const detail = tab.unavailableDetail
    ? describeRestoreError(tab.unavailableDetail, t)
    : null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        textAlign: "center",
        maxWidth: 420,
      }}
    >
      <div style={{ color: T.ink, font: `600 15px/1.3 ${T.sans}` }}>
        {t("tabs.restoreFailed")}
      </div>
      {detail ? (
        <div style={{ color: T.dim, font: `500 12.5px/1.45 ${T.sans}` }}>
          {tab.title} · {detail}
        </div>
      ) : null}
      <IconBtn tone="primary" onClick={onRetry}>
        <Ic.lock />
        <span>
          {tab.unavailableDetail === "pdf-password-required"
            ? t("password.unlock")
            : tab.unavailableDetail === "runtime-storage-admission-failed"
              ? t("tabs.restoreRetry")
            : tab.source.type === "webFileHandle"
            ? t("tabs.restoreAuthorize")
            : t("tabs.restorePickAgain")}
        </span>
      </IconBtn>
    </div>
  );
}
