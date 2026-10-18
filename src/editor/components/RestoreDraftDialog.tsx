import { useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { IconBtn, Modal } from "./ui";
import {
  formatRelative,
  relativeLabelsFor,
} from "../../shared/format";
import { useNow } from "../hooks/useNow";

type Props = {
  open: boolean;
  fileName: string;
  lastTouched: number;
  onRestore: () => void;
  onCancel: () => void;
  onDiscard: () => void;
};

export function RestoreDraftDialog({
  open,
  fileName,
  lastTouched,
  onRestore,
  onCancel,
  onDiscard,
}: Props) {
  const { t, i18n } = useTranslation();
  const now = useNow(30_000);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  if (!open) return null;
  const rel = formatRelative(
    lastTouched,
    now,
    relativeLabelsFor(i18n.resolvedLanguage ?? i18n.language),
  );
  return (
    <Modal
      onClose={onCancel}
      title={
        confirmingDiscard
          ? t("drafts.discardConfirmTitle")
          : t("drafts.restoreTitle")
      }
      subtitle={fileName}
    >
      <div
        style={{
          font: `14px/1.55 ${T.sans}`,
          color: T.ink2,
          marginBottom: 14,
        }}
      >
        {confirmingDiscard
          ? t("drafts.discardConfirmBody")
          : t("drafts.restoreBody", { rel })}
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          justifyContent: "flex-end",
          flexWrap: "wrap",
        }}
      >
        {confirmingDiscard ? (
          <>
            <IconBtn tone="outline" onClick={() => setConfirmingDiscard(false)}>
              {t("drafts.discardCancel")}
            </IconBtn>
            <IconBtn tone="primary" onClick={onDiscard}>
              {t("drafts.discardConfirm")}
            </IconBtn>
          </>
        ) : (
          <>
            <IconBtn tone="outline" onClick={() => setConfirmingDiscard(true)}>
              {t("drafts.discard")}
            </IconBtn>
            <IconBtn tone="primary" onClick={onRestore}>
              {t("drafts.restore")}
            </IconBtn>
          </>
        )}
      </div>
    </Modal>
  );
}
