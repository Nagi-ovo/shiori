import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { useAppStore } from "../store/store";
import { IconBtn, Modal } from "./ui";

export function BetaDisclaimerDialog() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.showBetaDisclaimer);
  const acknowledge = useAppStore((s) => s.acknowledgeBetaDisclaimer);
  const setOpen = useAppStore((s) => s.setShowBetaDisclaimer);
  if (!open) return null;

  // Backdrop click and the Modal's X button should dismiss for this
  // session only — persisting the acknowledgement from an accidental
  // misclick would strip the user of the warning forever. Only the
  // explicit "Got it" button writes to localStorage.
  const softClose = () => setOpen(false);

  return (
    <Modal onClose={softClose} title={t("betaDisclaimer.title")} width={480}>
      <div
        style={{
          font: `14px/1.6 ${T.sans}`,
          color: T.ink2,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <p style={{ margin: 0 }}>{t("betaDisclaimer.body1")}</p>
        <p style={{ margin: 0 }}>{t("betaDisclaimer.body2")}</p>
      </div>
      <div
        style={{
          marginTop: 18,
          paddingTop: 14,
          borderTop: `1px solid ${T.ruleSoft}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            font: `12.5px/1.45 ${T.sans}`,
            color: T.dim,
            flex: 1,
            minWidth: 0,
          }}
        >
          {t("betaDisclaimer.footerHint")}
        </div>
        <IconBtn tone="primary" onClick={acknowledge}>
          {t("betaDisclaimer.acknowledge")}
        </IconBtn>
      </div>
    </Modal>
  );
}
