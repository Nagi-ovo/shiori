import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { IconBtn, Modal } from "../../editor/components/ui";
import type { DraftConflictChoice } from "../draftConflictChoice";

type Props = {
  choice: DraftConflictChoice;
  fileName: string;
  /** Opens the existing export flow. */
  onExport: () => void;
};

/**
 * Shown when closing the tab or the window, quitting, or opening another
 * document was blocked because another window saved newer work on this file
 * (audit B034). Exporting is the default; discarding drops this window's
 * copy and lets the blocked leave go on.
 */
export function DraftConflictDialog({ choice, fileName, onExport }: Props) {
  const { t } = useTranslation();
  const open = useSyncExternalStore(choice.subscribe, choice.pending);
  if (!open) return null;
  return (
    <Modal
      onClose={choice.dismiss}
      title={t("drafts.conflictLeaveTitle")}
      subtitle={fileName}
      footer={
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <IconBtn tone="ghost" onClick={choice.dismiss}>
            {t("drafts.conflictLeaveKeep")}
          </IconBtn>
          <IconBtn tone="outline" onClick={choice.discard}>
            {t("drafts.conflictLeaveDiscard")}
          </IconBtn>
          <IconBtn tone="primary" onClick={() => choice.exportCopy(onExport)}>
            {t("drafts.conflictLeaveExport")}
          </IconBtn>
        </div>
      }
    >
      <div
        style={{
          padding: "0 22px 6px",
          color: T.ink2,
          font: `13.5px/1.6 ${T.sans}`,
        }}
      >
        {t("drafts.conflictLeaveBody")}
      </div>
    </Modal>
  );
}
