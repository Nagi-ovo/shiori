import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Modal } from "./ui";

// The two stand-in dialogs deferModal renders while a modal's code is on
// its way or failed to arrive. Separate file so deferModal.tsx exports only
// its factory (react-refresh wants component files to be component-only).

/** Lets the load stay invisible unless it is genuinely slow. */
const SLOW_LOAD_NOTICE_DELAY_MS = 400;

export function SlowLoadNotice({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSlow(true), SLOW_LOAD_NOTICE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);
  if (!slow) return null;
  return (
    <Modal title={t("deferred.loading")} onClose={onClose} width={360}>
      <p style={{ margin: 0, color: T.dim, font: `14px/1.5 ${T.sans}` }}>
        {t("deferred.loadingBody")}
      </p>
    </Modal>
  );
}

export function LoadFailed({
  onClose,
  onRetry,
}: {
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      title={t("deferred.failedTitle")}
      onClose={onClose}
      width={360}
      footer={
        <button
          type="button"
          onClick={onRetry}
          style={{
            font: `500 13px/1 ${T.sans}`,
            color: T.onAccent,
            background: T.accent,
            border: "none",
            borderRadius: 6,
            padding: "8px 14px",
            cursor: "pointer",
          }}
        >
          {t("deferred.retry")}
        </button>
      }
    >
      <p style={{ margin: 0, color: T.ink2, font: `14px/1.5 ${T.sans}` }}>
        {t("deferred.failedBody")}
      </p>
    </Modal>
  );
}
