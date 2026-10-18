import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "../../editor/components/icons";

export function MobilePdfChromeToggle({
  collapsed,
  fixed = false,
  topInset,
  onClick,
}: {
  collapsed: boolean;
  fixed?: boolean;
  topInset?: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const label = collapsed
    ? t("nav.pdfChromeExpand")
    : t("nav.pdfChromeCollapse");
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="shioriPrintHide"
      style={{
        position: fixed ? "fixed" : "absolute",
        top: topInset ?? 10,
        right: "calc(10px + var(--shiori-safe-right, 0px))",
        height: 34,
        minWidth: 34,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        border: `1px solid ${T.rule}`,
        background: T.cream,
        color: T.ink2,
        borderRadius: 999,
        cursor: "pointer",
        padding: "0 11px",
        zIndex: 46,
        boxShadow: "0 6px 18px rgba(20,16,10,0.16)",
        font: `600 12px/1 ${T.sans}`,
        letterSpacing: 0,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <Ic.reader width={15} height={15} />
      <span>{label}</span>
    </button>
  );
}
