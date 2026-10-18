import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import type { PdfEditKind } from "../../pdf/security/permissions";
import { formatEditList } from "../permissionEdits";
import { IconBtn, Modal } from "./ui";

type Props = {
  open: boolean;
  fileName: string;
  /** The edits the password that opened the file does not allow. */
  restricted: readonly PdfEditKind[];
  onClose: () => void;
};

/**
 * An encrypted PDF exports re-encrypted like its source, but only the edits
 * its permissions allow. Name the rest right after open, before annotations
 * accumulate that the export would refuse.
 */
export function EncryptedPdfWarningDialog({
  open,
  fileName,
  restricted,
  onClose,
}: Props) {
  const { t, i18n } = useTranslation();
  if (!open) return null;
  return (
    <Modal
      onClose={onClose}
      title={t("encryptedPdfWarning.title")}
      subtitle={fileName}
      footer={
        <IconBtn tone="primary" onClick={onClose}>
          {t("encryptedPdfWarning.continue")}
        </IconBtn>
      }
    >
      <div
        style={{
          padding: "0 22px 6px",
          color: T.ink2,
          font: `13.5px/1.6 ${T.sans}`,
        }}
      >
        {t("encryptedPdfWarning.body", {
          edits: formatEditList(restricted, t, i18n.language),
        })}
      </div>
    </Modal>
  );
}
