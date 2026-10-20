import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Radio, Section, type RadioOption } from "./ui";
import type { ExportRange } from "../../pdf/export/pageRanges";

// The export dialog's Pages section: all pages, the current page, or a typed
// custom range.

export function ExportPagesSection({
  range,
  onRangeChange,
  customRange,
  onCustomRangeChange,
  pageCount,
  currentPage,
}: {
  range: ExportRange;
  onRangeChange: (range: ExportRange) => void;
  customRange: string;
  onCustomRangeChange: (customRange: string) => void;
  pageCount: number;
  currentPage: number;
}) {
  const { t } = useTranslation();
  const rangeOpts: RadioOption<ExportRange>[] = [
    {
      v: "all",
      label: t("export.range.all"),
      hint: t("export.range.allHint", { count: pageCount }),
    },
    {
      v: "current",
      label: t("export.range.current"),
      hint: t("export.range.currentHint", { page: currentPage }),
    },
    {
      v: "range",
      label: t("export.range.custom"),
      hint: customRange,
    },
  ];
  return (
    <Section label={t("export.sections.pages")}>
      <Radio
        label={t("export.sections.pages")}
        options={rangeOpts}
        value={range}
        onChange={onRangeChange}
      />
      {range === "range" ? (
        <input
          type="text"
          value={customRange}
          onChange={(e) => onCustomRangeChange(e.target.value)}
          // The placeholder is an example, not a name.
          aria-label={t("export.range.custom")}
          placeholder={t("export.range.customPlaceholder")}
          style={{
            marginTop: 8,
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 12px",
            borderRadius: 4,
            border: `1px solid ${T.rule}`,
            background: T.surface,
            font: `500 13px/1 ${T.mono}`,
            color: T.ink,
          }}
        />
      ) : null}
      {range !== "all" ? (
        <div
          style={{
            marginTop: 8,
            color: T.dim,
            font: `12.5px/1.45 ${T.sans}`,
          }}
        >
          {t("export.range.attachmentsOmitted")}
        </div>
      ) : null}
    </Section>
  );
}
