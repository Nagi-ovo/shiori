import { useState } from "react";
import { useTranslation } from "react-i18next";
import { paletteForTheme } from "../../design/theme";
import { T } from "../../design/tokens";
import { useEffectiveTheme } from "../hooks/useEffectiveTheme";
import type { PrefsColorMode, PrefsTheme } from "../store/store";
import { Ic } from "./icons";
import { ThemeColorControl } from "./ThemeColorControl";

type Props = {
  accentColor: string | null;
  colorMode: PrefsColorMode;
  theme: PrefsTheme;
  onChange: (value: string | null) => void;
};

export function AccentColorSetting({
  accentColor,
  colorMode,
  theme,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const effectiveTheme = useEffectiveTheme(colorMode);
  const palette = paletteForTheme(theme, effectiveTheme, accentColor);
  const automaticPalette = paletteForTheme(theme, effectiveTheme);
  const summary = accentColor?.toUpperCase() ?? t("settings.accentThemeDefault");

  return (
    <div
      style={{
        padding: "10px 0",
        borderBottom: `1px solid ${T.ruleSoft}`,
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={t("settings.accentCustomize")}
        onClick={() => setExpanded((value) => !value)}
        style={{
          width: "100%",
          padding: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
          border: "none",
          background: "transparent",
          color: T.ink,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", font: `500 13.5px/1.3 ${T.sans}` }}>
            {t("settings.accentColor")}
          </span>
          <span
            style={{
              display: "block",
              marginTop: 2,
              color: T.dim,
              font: `12.5px/1.45 ${T.sans}`,
            }}
          >
            {t("settings.accentColorHint")}
          </span>
        </span>
        <span
          style={{
            flex: "0 0 auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            color: T.dim,
            font: `500 10.5px/1 ${T.mono}`,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              border: `1px solid ${T.rule}`,
              background: palette.accent,
              boxShadow: `0 0 0 2px ${T.surface}`,
            }}
          />
          <span>{summary}</span>
          <Ic.chev
            aria-hidden
            style={{
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 120ms ease",
            }}
          />
        </span>
      </button>

      {expanded ? (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px dashed ${T.rule}`,
          }}
        >
          <ThemeColorControl
            key={`${theme}:${effectiveTheme}`}
            label={t("settings.accentColor")}
            value={accentColor}
            resolvedColor={palette.accent}
            automaticLabel={t("settings.accentReset")}
            automaticColor={automaticPalette.accent}
            customLabel={t("settings.accentCustom")}
            invalidLabel={t("settings.accentInvalid")}
            immediate
            showResolvedColor={false}
            onChange={onChange}
          />
        </div>
      ) : null}
    </div>
  );
}
