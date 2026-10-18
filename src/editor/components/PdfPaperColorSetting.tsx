import { useTranslation } from "react-i18next";
import {
  EVERFOREST_PDF_PAPER,
  PDF_PAPER_COLOR_SWATCHES,
  resolvePdfPaperCustomColor,
} from "../../design/pdfPaperTone";
import { T } from "../../design/tokens";
import { ThemeColorControl } from "./ThemeColorControl";

type Props = {
  color: string;
  onChange: (color: string) => void;
};

export function PdfPaperColorSetting({ color, onChange }: Props) {
  const { t } = useTranslation();
  const resolved = resolvePdfPaperCustomColor(color);

  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: `1px dashed ${T.rule}`,
      }}
    >
      <ThemeColorControl
        key={`${color}:${resolved.color}`}
        label={t("settings.pdfPaperCustom")}
        value={color === EVERFOREST_PDF_PAPER ? null : color}
        resolvedColor={resolved.color}
        adjusted={resolved.adjusted}
        automaticLabel={t("settings.pdfPaperCustomReset")}
        customLabel={t("settings.pdfPaperCustomHex")}
        applyLabel={t("settings.pdfPaperCustomApply")}
        invalidLabel={t("settings.pdfPaperCustomInvalid")}
        effectiveLabel={t("settings.pdfPaperCustomEffective", {
          color: resolved.color.toUpperCase(),
        })}
        adjustedLabel={t("settings.pdfPaperCustomAdjusted")}
        swatches={PDF_PAPER_COLOR_SWATCHES}
        onChange={(next) => onChange(next ?? EVERFOREST_PDF_PAPER)}
      />
    </div>
  );
}
