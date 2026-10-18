import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  BUILTIN_MARKDOWN_FONTS,
  MARKDOWN_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  MARKDOWN_LINE_HEIGHT_MAX,
  MARKDOWN_LINE_HEIGHT_MIN,
  isValidMarkdownFontFamily,
  markdownFontChoiceKey,
  markdownFontFamilyCss,
  markdownFontsEqual,
  type MarkdownAppearance,
  type MarkdownAppearanceOverride,
  type MarkdownFontChoice,
} from "../../documents/markdownAppearance";
import {
  listSystemFonts,
  SYSTEM_FONT_ACCESS_MODE,
  type SystemFontAccessMode,
  type SystemFontListResult,
} from "../../platform";
import { T } from "../../design/tokens";
import { resolveReadableColor } from "../../design/color";
import { LIGHT_PALETTE, type ThemePalette } from "../../design/theme";
import { Ic } from "./icons";
import { ThemeColorControl } from "./ThemeColorControl";

type AppearanceTab = "body" | "code" | "layout" | "color";
type FontProperty = "bodyFont" | "codeFont";

type Props = {
  appearance: MarkdownAppearance;
  override?: MarkdownAppearanceOverride;
  globalAppearance: MarkdownAppearance;
  recentFonts: readonly MarkdownFontChoice[];
  onOverrideChange: (value: MarkdownAppearanceOverride) => void;
  onSetGlobalAppearance: (value: MarkdownAppearance) => void;
  onUseFont: (font: MarkdownFontChoice) => void;
  themePalette?: ThemePalette;
  /** Test seam; production always calls the platform abstraction. */
  loadSystemFonts?: () => Promise<SystemFontListResult>;
  /** Test seam for native auto-discovery vs browser permission gating. */
  systemFontAccessMode?: SystemFontAccessMode;
};

const MAX_VISIBLE_SYSTEM_FONTS = 100;
const POPOVER_WIDTH = 384;
const POPOVER_FALLBACK_HEIGHT = 560;
const POPOVER_MARGIN = 8;
const SYSTEM_FONT_REFRESH_MS = 60_000;
const APPEARANCE_TABS: readonly AppearanceTab[] = [
  "body",
  "code",
  "layout",
  "color",
];

export function MarkdownAppearancePicker({
  appearance,
  override = {},
  globalAppearance,
  recentFonts,
  onOverrideChange,
  onSetGlobalAppearance,
  onUseFont,
  themePalette = LIGHT_PALETTE,
  loadSystemFonts = listSystemFonts,
  systemFontAccessMode = SYSTEM_FONT_ACCESS_MODE,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AppearanceTab>("body");
  const [query, setQuery] = useState("");
  const [systemResult, setSystemResult] = useState<SystemFontListResult | null>(
    null,
  );
  const [loadingFonts, setLoadingFonts] = useState(false);
  const [manualFamily, setManualFamily] = useState("");
  const [manualError, setManualError] = useState(false);
  const [position, setPosition] = useState({
    left: 8,
    top: 8,
    maxHeight: 560,
    ready: false,
  });
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const lastSystemLoadRef = useRef(0);
  const appearanceId = useId();
  const panelId = `${appearanceId}-panel`;
  const tabId = (tab: AppearanceTab) => `${appearanceId}-${tab}-tab`;

  const refreshSystemFonts = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadingFonts(true);
    try {
      const result = await loadSystemFonts();
      if (requestId !== requestIdRef.current) return;
      setSystemResult(result);
      lastSystemLoadRef.current = Date.now();
    } catch {
      if (requestId !== requestIdRef.current) return;
      setSystemResult({ status: "error", source: "web", fonts: [] });
    } finally {
      if (requestId === requestIdRef.current) setLoadingFonts(false);
    }
  }, [loadSystemFonts]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const openPanel = () => {
    setOpen(true);
    if (systemFontAccessMode === "unavailable" && !systemResult) {
      setSystemResult({ status: "unsupported", source: "mobile", fonts: [] });
      return;
    }
    if (
      systemFontAccessMode === "native" &&
      !loadingFonts &&
      (!systemResult ||
        Date.now() - lastSystemLoadRef.current >= SYSTEM_FONT_REFRESH_MS)
    ) {
      void refreshSystemFonts();
    }
  };

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      ) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`${appearanceId}-${activeTab}-tab`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, appearanceId, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const visualViewport = window.visualViewport;
      const viewportLeft = visualViewport?.offsetLeft ?? 0;
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportWidth = visualViewport?.width ?? window.innerWidth;
      const viewportHeight = visualViewport?.height ?? window.innerHeight;
      const width = Math.min(
        POPOVER_WIDTH,
        viewportWidth - POPOVER_MARGIN * 2,
      );
      const maxHeight = Math.max(
        160,
        viewportHeight - POPOVER_MARGIN * 2,
      );
      const measuredHeight =
        panelRef.current?.offsetHeight || POPOVER_FALLBACK_HEIGHT;
      const height = Math.min(measuredHeight, maxHeight);
      const left = Math.max(
        viewportLeft + POPOVER_MARGIN,
        Math.min(
          anchor.right - width,
          viewportLeft + viewportWidth - width - POPOVER_MARGIN,
        ),
      );
      const below = anchor.bottom + 6;
      const above = anchor.top - height - 6;
      const top =
        below + height <= viewportTop + viewportHeight - POPOVER_MARGIN ||
        above < viewportTop + POPOVER_MARGIN
          ? Math.min(
              below,
              viewportTop + viewportHeight - height - POPOVER_MARGIN,
            )
          : above;
      setPosition({
        left,
        top: Math.max(viewportTop + POPOVER_MARGIN, top),
        maxHeight,
        ready: true,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [activeTab, loadingFonts, open, systemResult]);

  const fontProperty: FontProperty =
    activeTab === "code" ? "codeFont" : "bodyFont";
  const selectedFont = appearance[fontProperty];
  const globalFont = globalAppearance[fontProperty];
  const selectedSystemMissing = useMemo(() => {
    if (
      !selectedFont ||
      selectedFont.source !== "system" ||
      systemResult?.status !== "available"
    ) {
      return false;
    }
    const selectedKey = selectedFont.family.toLowerCase();
    return !systemResult.fonts.some(
      (font) =>
        font.family.toLowerCase() === selectedKey ||
        font.aliases.some(
          (alias) => alias.toLowerCase() === selectedKey,
        ),
    );
  }, [selectedFont, systemResult]);

  const setOverride = (patch: MarkdownAppearanceOverride) => {
    onOverrideChange({ ...override, ...patch });
  };

  const clearOverrideKeys = (keys: Array<keyof MarkdownAppearance>) => {
    const next = { ...override };
    for (const key of keys) delete next[key];
    onOverrideChange(next);
  };

  const chooseFont = (font: MarkdownFontChoice | null) => {
    setOverride({ [fontProperty]: font });
    if (font) onUseFont(font);
  };

  const addManualFont = (event: FormEvent) => {
    event.preventDefault();
    const family = manualFamily.trim();
    if (!isValidMarkdownFontFamily(family)) {
      setManualError(true);
      return;
    }
    const font: MarkdownFontChoice = { source: "system", family };
    chooseFont(font);
    setManualFamily("");
    setManualError(false);
  };

  const hasOverride = Object.keys(override).length > 0;
  const fontTab = activeTab === "body" || activeTab === "code";
  const onTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tab: AppearanceTab,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const currentIndex = APPEARANCE_TABS.indexOf(tab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? APPEARANCE_TABS.length - 1
          : (currentIndex + (event.key === "ArrowLeft" ? -1 : 1) +
              APPEARANCE_TABS.length) %
            APPEARANCE_TABS.length;
    setActiveTab(APPEARANCE_TABS[nextIndex] ?? "body");
    setQuery("");
  };

  return (
    <div
      ref={anchorRef}
      className="shioriMarkdownAppearancePicker"
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}
    >
      <style>{`
        .shioriMarkdownAppearancePicker button:focus-visible,
        .shioriMarkdownAppearancePanel button:focus-visible,
        .shioriMarkdownAppearancePanel input:focus-visible {
          outline: 2px solid ${T.accent};
          outline-offset: 2px;
        }
        .shioriMarkdownAppearanceButton:hover,
        .shioriMarkdownAppearancePanel .shioriAppearanceHover:hover {
          background: ${T.hoverTint} !important;
          color: ${T.ink} !important;
        }
        .shioriMarkdownAppearanceButton:active,
        .shioriMarkdownAppearancePanel button:active:not(:disabled) {
          transform: translateY(1px);
        }
        .shioriMarkdownAppearancePanel input[type="range"] {
          accent-color: ${T.accent};
        }
      `}</style>
      <button
        ref={buttonRef}
        type="button"
        className="shioriMarkdownAppearanceButton"
        aria-label={t("documents.appearance.open")}
        title={t("documents.appearance.open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else openPanel();
        }}
        style={{
          width: 32,
          height: 32,
          padding: 0,
          border: `1px solid ${open || hasOverride ? T.rule : "transparent"}`,
          borderRadius: 6,
          background: open ? T.surface : "transparent",
          color: hasOverride ? T.accentText : T.ink2,
          cursor: "pointer",
          font: `600 14px/1 ${T.serif}`,
          letterSpacing: "-0.04em",
          transition:
            "background 120ms ease, color 120ms ease, border-color 120ms ease, transform 90ms ease",
        }}
      >
        Aa
      </button>

      {open ? (
        <div
          ref={panelRef}
          className="shioriMarkdownAppearancePanel"
          role="dialog"
          aria-label={t("documents.appearance.title")}
          style={{
            position: "fixed",
            left: position.left,
            top: position.top,
            zIndex: 80,
            width: POPOVER_WIDTH,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: position.maxHeight,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            visibility: position.ready ? "visible" : "hidden",
            border: `1px solid ${T.rule}`,
            borderRadius: 12,
            background: T.surface,
            color: T.ink,
            boxShadow:
              "0 22px 56px -22px rgba(28,24,19,.34), 0 5px 16px rgba(28,24,19,.10)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 12px 10px 14px",
              borderBottom: `1px solid ${T.ruleSoft}`,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ font: `600 14px/1.2 ${T.sans}` }}>
                {t("documents.appearance.title")}
              </div>
              <div
                style={{
                  marginTop: 3,
                  color: T.dim,
                  font: `500 11px/1.25 ${T.sans}`,
                }}
              >
                {hasOverride
                  ? t("documents.appearance.documentOverride")
                  : t("documents.appearance.followingGlobal")}
              </div>
            </div>
            <button
              type="button"
              className="shioriAppearanceHover"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={() => {
                close();
                buttonRef.current?.focus();
              }}
              style={iconButtonStyle}
            >
              <Ic.x aria-hidden />
            </button>
          </div>

          <div
            role="tablist"
            aria-label={t("documents.appearance.title")}
            style={{
              margin: "10px 12px 0",
              padding: 3,
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 3,
              borderRadius: 8,
              background: T.cream,
            }}
          >
            {APPEARANCE_TABS.map((tab) => (
              <button
                key={tab}
                id={tabId(tab)}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls={panelId}
                tabIndex={activeTab === tab ? 0 : -1}
                onKeyDown={(event) => onTabKeyDown(event, tab)}
                onClick={() => {
                  setActiveTab(tab);
                  setQuery("");
                }}
                style={{
                  height: 30,
                  border: "none",
                  borderRadius: 6,
                  background: activeTab === tab ? T.surface : "transparent",
                  color: activeTab === tab ? T.ink : T.dim,
                  boxShadow:
                    activeTab === tab ? `0 0 0 1px ${T.rule}` : "none",
                  cursor: "pointer",
                  font: `600 12px/1 ${T.sans}`,
                }}
              >
                {t(`documents.appearance.tabs.${tab}`)}
              </button>
            ))}
          </div>

          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={tabId(activeTab)}
            style={{
              minHeight: 0,
              overflowY: "auto",
              padding: "12px",
              scrollbarGutter: "stable",
            }}
          >
            {fontTab ? (
              <FontChooser
                target={activeTab === "code" ? "code" : "body"}
                selected={selectedFont}
                globalFont={globalFont}
                followsGlobal={!Object.hasOwn(override, fontProperty)}
                recentFonts={recentFonts}
                systemResult={systemResult}
                loading={loadingFonts}
                query={query}
                onQueryChange={setQuery}
                onChoose={chooseFont}
                onFollowGlobal={() => clearOverrideKeys([fontProperty])}
                onRetry={() => void refreshSystemFonts()}
                manualFamily={manualFamily}
                manualError={manualError}
                onManualFamilyChange={(value) => {
                  setManualFamily(value);
                  setManualError(false);
                }}
                onAddManual={addManualFont}
              />
            ) : activeTab === "layout" ? (
              <LayoutControls
                appearance={appearance}
                globalAppearance={globalAppearance}
                onChange={setOverride}
                onFollowGlobal={() =>
                  clearOverrideKeys(["fontSize", "lineHeight", "contentWidth"])
                }
              />
            ) : (
              <HeadingColorControls
                appearance={appearance}
                override={override}
                globalAppearance={globalAppearance}
                themePalette={themePalette}
                onChange={setOverride}
                onFollowGlobal={() => clearOverrideKeys(["headingColor"])}
              />
            )}

            {selectedSystemMissing && fontTab ? (
              <div
                role="status"
                style={{
                  marginTop: 10,
                  padding: "9px 10px",
                  borderRadius: 7,
                  background: T.cream,
                  color: T.dim,
                  font: `500 11.5px/1.45 ${T.sans}`,
                }}
              >
                {t("documents.appearance.fontMissing", {
                  family: selectedFont?.family,
                })}
              </div>
            ) : null}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "10px 12px",
              borderTop: `1px solid ${T.ruleSoft}`,
              background: T.cream,
            }}
          >
            <button
              type="button"
              className="shioriAppearanceHover"
              disabled={!hasOverride}
              onClick={() => onOverrideChange({})}
              style={footerButtonStyle(!hasOverride)}
            >
              {t("documents.appearance.resetDocument")}
            </button>
            <button
              type="button"
              onClick={() => {
                onSetGlobalAppearance(appearance);
                onOverrideChange({});
              }}
              style={{
                ...footerButtonStyle(false),
                borderColor: T.ink,
                background: T.ink,
                color: T.cream,
              }}
            >
              {t("documents.appearance.setGlobal")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FontChooser({
  target,
  selected,
  globalFont,
  followsGlobal,
  recentFonts,
  systemResult,
  loading,
  query,
  onQueryChange,
  onChoose,
  onFollowGlobal,
  onRetry,
  manualFamily,
  manualError,
  onManualFamilyChange,
  onAddManual,
}: {
  target: "body" | "code";
  selected: MarkdownFontChoice | null;
  globalFont: MarkdownFontChoice | null;
  followsGlobal: boolean;
  recentFonts: readonly MarkdownFontChoice[];
  systemResult: SystemFontListResult | null;
  loading: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onChoose: (font: MarkdownFontChoice | null) => void;
  onFollowGlobal: () => void;
  onRetry: () => void;
  manualFamily: string;
  manualError: boolean;
  onManualFamilyChange: (value: string) => void;
  onAddManual: (event: FormEvent) => void;
}) {
  const { t } = useTranslation();
  const manualHelpId = `markdown-manual-${target}-help`;
  const normalizedQuery = query.trim().toLowerCase();
  const builtinFamilyKeys = useMemo(
    () =>
      new Set(
        BUILTIN_MARKDOWN_FONTS.map((font) =>
          font.family.toLowerCase(),
        ),
      ),
    [],
  );
  const matches = (family: string, aliases: readonly string[] = []) =>
    !normalizedQuery ||
    family.toLowerCase().includes(normalizedQuery) ||
    aliases.some((alias) =>
      alias.toLowerCase().includes(normalizedQuery),
    );
  const builtins = BUILTIN_MARKDOWN_FONTS.filter((font) =>
    matches(font.family),
  ).sort((left, right) => {
    if (target !== "code") return 0;
    return Number(right.category === "mono") - Number(left.category === "mono");
  });
  const recent = recentFonts.filter((font) => matches(font.family));
  const allSystemFonts =
    systemResult?.status === "available"
      ? systemResult.fonts
          .filter(
            (font) =>
              !builtinFamilyKeys.has(font.family.toLowerCase()) &&
              matches(font.family, font.aliases),
          )
          .sort((left, right) => {
            if (target === "code" && left.monospaced !== right.monospaced) {
              return Number(right.monospaced) - Number(left.monospaced);
            }
            return left.family.localeCompare(right.family);
          })
      : [];
  const systemFonts = allSystemFonts.slice(0, MAX_VISIBLE_SYSTEM_FONTS);
  const globalLabel = globalFont?.family ?? t("documents.appearance.automatic");
  return (
    <>
      <label
        style={{
          position: "relative",
          display: "block",
          marginBottom: 10,
        }}
      >
        <Ic.search
          aria-hidden
          style={{
            position: "absolute",
            left: 10,
            top: 9,
            color: T.dim,
          }}
        />
        <input
          type="search"
          value={query}
          aria-label={t("documents.appearance.searchFonts")}
          placeholder={t("documents.appearance.searchFonts")}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          style={{
            width: "100%",
            height: 34,
            boxSizing: "border-box",
            padding: "0 10px 0 32px",
            border: `1px solid ${T.rule}`,
            borderRadius: 7,
            background: T.paper,
            color: T.ink,
            font: `500 12.5px/1 ${T.sans}`,
          }}
        />
      </label>

      <FontOption
        label={t("documents.appearance.useGlobal", { family: globalLabel })}
        font={globalFont}
        target={target}
        selected={followsGlobal}
        meta={t("documents.appearance.globalBadge")}
        onClick={onFollowGlobal}
      />
      <FontOption
        label={t("documents.appearance.automatic")}
        font={null}
        target={target}
        selected={!followsGlobal && selected === null}
        meta={t("documents.appearance.fallbackBadge")}
        onClick={() => onChoose(null)}
      />

      {recent.length > 0 ? (
        <FontSection label={t("documents.appearance.recentFonts")}>
          {recent.map((font) => (
            <FontOption
              key={`recent:${markdownFontChoiceKey(font)}`}
              label={font.family}
              font={font}
              target={target}
              selected={!followsGlobal && markdownFontsEqual(selected, font)}
              onClick={() => onChoose(font)}
            />
          ))}
        </FontSection>
      ) : null}

      {builtins.length > 0 ? (
        <FontSection label={t("documents.appearance.builtinFonts")}>
          {builtins.map((font) => (
            <FontOption
              key={font.family}
              label={font.family}
              font={font}
              target={target}
              selected={!followsGlobal && markdownFontsEqual(selected, font)}
              meta={t(`documents.appearance.fontKinds.${font.category}`)}
              onClick={() =>
                onChoose({ source: "builtin", family: font.family })
              }
            />
          ))}
        </FontSection>
      ) : null}

      <FontSection label={t("documents.appearance.systemFonts")}>
        {loading ? (
          <FontLoadingRows label={t("documents.appearance.loadingSystemFonts")} />
        ) : !systemResult ? (
          <SystemFontAccessPrompt onRequest={onRetry} />
        ) : systemResult.status === "available" ? (
          systemFonts.length > 0 ? (
            <>
              {systemFonts.map((font) => (
                <FontOption
                  key={font.family}
                  label={font.family}
                  font={{ source: "system", family: font.family }}
                  target={target}
                  selected={
                    !followsGlobal &&
                    markdownFontsEqual(selected, {
                      source: "system",
                      family: font.family,
                    })
                  }
                  meta={
                    font.monospaced
                      ? t("documents.appearance.fontKinds.mono")
                      : undefined
                  }
                  onClick={() =>
                    onChoose({ source: "system", family: font.family })
                  }
                />
              ))}
              {allSystemFonts.length > MAX_VISIBLE_SYSTEM_FONTS ? (
                <div style={helperTextStyle}>
                  {t("documents.appearance.refineSearch", {
                    count: allSystemFonts.length,
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <div style={helperTextStyle}>
              {normalizedQuery
                ? t("documents.appearance.noFontResults")
                : t("documents.appearance.noSystemFonts")}
            </div>
          )
        ) : (
          <SystemFontUnavailable state={systemResult?.status} onRetry={onRetry} />
        )}
      </FontSection>

      <form
        onSubmit={onAddManual}
        style={{
          marginTop: 12,
          paddingTop: 11,
          borderTop: `1px solid ${T.ruleSoft}`,
        }}
      >
        <label
          htmlFor={`markdown-manual-${target}`}
          style={{
            display: "block",
            marginBottom: 6,
            color: T.dim,
            font: `600 11px/1.2 ${T.sans}`,
          }}
        >
          {t("documents.appearance.manualFont")}
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            id={`markdown-manual-${target}`}
            value={manualFamily}
            aria-invalid={manualError}
            aria-describedby={manualHelpId}
            placeholder={t("documents.appearance.manualFontPlaceholder")}
            onChange={(event) =>
              onManualFamilyChange(event.currentTarget.value)
            }
            style={{
              flex: 1,
              minWidth: 0,
              height: 32,
              boxSizing: "border-box",
              padding: "0 9px",
              border: `1px solid ${manualError ? T.rect : T.rule}`,
              borderRadius: 6,
              background: T.paper,
              color: T.ink,
              font: `500 12px/1 ${T.sans}`,
            }}
          />
          <button
            type="submit"
            disabled={manualFamily.trim().length === 0}
            style={footerButtonStyle(manualFamily.trim().length === 0)}
          >
            {t("documents.appearance.addFont")}
          </button>
        </div>
        <div
          id={manualHelpId}
          role={manualError ? "alert" : undefined}
          style={{
            ...helperTextStyle,
            color: manualError ? T.rect : T.dim,
          }}
        >
          {manualError
            ? t("documents.appearance.manualFontInvalid")
            : t("documents.appearance.manualFontHint")}
        </div>
      </form>
    </>
  );
}

function FontSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 13 }}>
      <div
        style={{
          margin: "0 2px 6px",
          color: T.dim,
          font: `600 10.5px/1 ${T.sans}`,
          letterSpacing: ".035em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {children}
      </div>
    </section>
  );
}

function FontOption({
  label,
  font,
  target,
  selected,
  meta,
  onClick,
}: {
  label: string;
  font: MarkdownFontChoice | null;
  target: "body" | "code";
  selected: boolean;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="shioriAppearanceHover"
      aria-pressed={selected}
      onClick={onClick}
      style={{
        width: "100%",
        minHeight: 36,
        boxSizing: "border-box",
        padding: "7px 8px 7px 10px",
        display: "flex",
        alignItems: "center",
        gap: 9,
        border: "none",
        borderRadius: 7,
        background: selected ? T.accentGhost : "transparent",
        color: selected ? T.accentText : T.ink,
        cursor: "pointer",
        textAlign: "left",
        transition: "background 100ms ease, color 100ms ease, transform 90ms ease",
      }}
    >
      <span
        style={{
          width: 17,
          flex: "0 0 17px",
          color: selected ? T.accent : "transparent",
          display: "inline-flex",
        }}
      >
        <Ic.check aria-hidden />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: markdownFontFamilyCss(font, target),
          fontSize: 13.5,
          lineHeight: 1.2,
          fontWeight: 500,
        }}
      >
        {label}
      </span>
      {meta ? (
        <span
          style={{
            flex: "0 0 auto",
            color: selected ? T.accentText : T.dim2,
            font: `600 9.5px/1 ${T.sans}`,
            letterSpacing: ".025em",
          }}
        >
          {meta}
        </span>
      ) : null}
    </button>
  );
}

function FontLoadingRows({ label }: { label: string }) {
  return (
    <div aria-label={label} style={{ display: "grid", gap: 5, padding: "3px 6px" }}>
      {[72, 54, 81].map((width) => (
        <div
          key={width}
          style={{
            width: `${width}%`,
            height: 18,
            borderRadius: 5,
            background: T.soft,
            opacity: 0.75,
          }}
        />
      ))}
    </div>
  );
}

function SystemFontUnavailable({
  state,
  onRetry,
}: {
  state: SystemFontListResult["status"] | undefined;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const key =
    state === "denied"
      ? "denied"
      : state === "error"
        ? "error"
        : "unsupported";
  return (
    <div
      style={{
        padding: "8px 9px",
        borderRadius: 7,
        background: T.cream,
        color: T.dim,
        font: `500 11.5px/1.4 ${T.sans}`,
      }}
    >
      <div>{t(`documents.appearance.systemFontState.${key}`)}</div>
      {state === "denied" || state === "error" ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 6,
            padding: 0,
            border: "none",
            background: "transparent",
            color: T.accentText,
            cursor: "pointer",
            font: `600 11.5px/1.2 ${T.sans}`,
          }}
        >
          {t("documents.appearance.retrySystemFonts")}
        </button>
      ) : null}
    </div>
  );
}

function SystemFontAccessPrompt({ onRequest }: { onRequest: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        padding: "9px 10px",
        borderRadius: 7,
        background: T.cream,
        color: T.dim,
        font: `500 11.5px/1.45 ${T.sans}`,
      }}
    >
      <div>{t("documents.appearance.systemFontPrivacy")}</div>
      <button
        type="button"
        onClick={onRequest}
        style={{
          marginTop: 7,
          minHeight: 30,
          padding: "0 10px",
          border: `1px solid ${T.rule}`,
          borderRadius: 6,
          background: T.surface,
          color: T.ink2,
          cursor: "pointer",
          font: `600 11.5px/1 ${T.sans}`,
        }}
      >
        {t("documents.appearance.requestSystemFonts")}
      </button>
    </div>
  );
}

function HeadingColorControls({
  appearance,
  override,
  globalAppearance,
  themePalette,
  onChange,
  onFollowGlobal,
}: {
  appearance: MarkdownAppearance;
  override: MarkdownAppearanceOverride;
  globalAppearance: MarkdownAppearance;
  themePalette: ThemePalette;
  onChange: (patch: MarkdownAppearanceOverride) => void;
  onFollowGlobal: () => void;
}) {
  const { t } = useTranslation();
  const followsGlobal = !Object.hasOwn(override, "headingColor");
  const resolved = resolveReadableColor(
    appearance.headingColor ?? themePalette.ink,
    themePalette.paper,
    themePalette.ink,
  );
  const globalLabel =
    globalAppearance.headingColor?.toUpperCase() ??
    t("documents.appearance.automatic");

  return (
    <div>
      <button
        type="button"
        className="shioriAppearanceHover"
        aria-pressed={followsGlobal}
        onClick={onFollowGlobal}
        style={{
          width: "100%",
          minHeight: 36,
          padding: "7px 9px",
          display: "flex",
          alignItems: "center",
          gap: 9,
          border: "none",
          borderRadius: 7,
          background: followsGlobal ? T.accentGhost : "transparent",
          color: followsGlobal ? T.accentText : T.ink,
          cursor: "pointer",
          textAlign: "left",
          font: `600 12px/1.25 ${T.sans}`,
        }}
      >
        <span
          style={{
            width: 17,
            flex: "0 0 17px",
            display: "inline-flex",
            color: followsGlobal ? T.accent : "transparent",
          }}
        >
          <Ic.check aria-hidden />
        </span>
        <span>
          {t("documents.appearance.useGlobalColor", { color: globalLabel })}
        </span>
      </button>

      <div style={{ marginTop: 3 }}>
        <ThemeColorControl
          key={
            followsGlobal
              ? `global:${resolved.color}`
              : `document:${appearance.headingColor ?? "automatic"}:${resolved.color}`
          }
          label={t("documents.appearance.headingColor")}
          value={followsGlobal ? undefined : appearance.headingColor}
          resolvedColor={resolved.color}
          adjusted={resolved.adjusted}
          automaticLabel={t("documents.appearance.automaticHeadingColor")}
          customLabel={t("documents.appearance.customColor")}
          applyLabel={t("documents.appearance.applyColor")}
          invalidLabel={t("documents.appearance.invalidColor")}
          effectiveLabel={t("documents.appearance.effectiveColor", {
            color: resolved.color.toUpperCase(),
          })}
          adjustedLabel={t("documents.appearance.contrastAdjusted")}
          onChange={(headingColor) => onChange({ headingColor })}
        />
      </div>
    </div>
  );
}

function LayoutControls({
  appearance,
  globalAppearance,
  onChange,
  onFollowGlobal,
}: {
  appearance: MarkdownAppearance;
  globalAppearance: MarkdownAppearance;
  onChange: (patch: MarkdownAppearanceOverride) => void;
  onFollowGlobal: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <RangeControl
        key={`font-size-${appearance.fontSize}`}
        label={t("documents.appearance.fontSize")}
        value={appearance.fontSize}
        valueLabel={`${appearance.fontSize}px`}
        min={MARKDOWN_FONT_SIZE_MIN}
        max={MARKDOWN_FONT_SIZE_MAX}
        step={1}
        onChange={(fontSize) => onChange({ fontSize })}
      />
      <RangeControl
        key={`line-height-${appearance.lineHeight}`}
        label={t("documents.appearance.lineHeight")}
        value={appearance.lineHeight}
        valueLabel={appearance.lineHeight.toFixed(2).replace(/0$/, "")}
        min={MARKDOWN_LINE_HEIGHT_MIN}
        max={MARKDOWN_LINE_HEIGHT_MAX}
        step={0.05}
        onChange={(lineHeight) =>
          onChange({ lineHeight: Math.round(lineHeight * 100) / 100 })
        }
      />
      <div>
        <div style={rangeHeaderStyle}>
          <span>{t("documents.appearance.contentWidth")}</span>
          <span style={rangeValueStyle}>{appearance.contentWidth}px</span>
        </div>
        <div
          role="group"
          aria-label={t("documents.appearance.contentWidth")}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 5,
          }}
        >
          {([
            [720, "narrow"],
            [960, "standard"],
            [1200, "wide"],
          ] as const).map(([width, label]) => {
            const selected = appearance.contentWidth === width;
            return (
              <button
                key={width}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange({ contentWidth: width })}
                style={{
                  height: 36,
                  border: `1px solid ${selected ? T.accent : T.rule}`,
                  borderRadius: 7,
                  background: selected ? T.accentGhost : T.paper,
                  color: selected ? T.accentText : T.ink2,
                  cursor: "pointer",
                  font: `600 11.5px/1 ${T.sans}`,
                }}
              >
                {t(`documents.appearance.widths.${label}`)}
              </button>
            );
          })}
        </div>
      </div>
      <div
        style={{
          padding: "10px 11px",
          borderRadius: 8,
          background: T.cream,
          color: T.dim,
          font: `500 11.5px/1.45 ${T.sans}`,
        }}
      >
        {t("documents.appearance.globalLayoutSummary", {
          size: globalAppearance.fontSize,
          lineHeight: globalAppearance.lineHeight,
          width: globalAppearance.contentWidth,
        })}
        <button
          type="button"
          onClick={onFollowGlobal}
          style={{
            display: "block",
            marginTop: 7,
            padding: 0,
            border: "none",
            background: "transparent",
            color: T.accentText,
            cursor: "pointer",
            font: `600 11.5px/1.2 ${T.sans}`,
          }}
        >
          {t("documents.appearance.useGlobalLayout")}
        </button>
      </div>
    </div>
  );
}

function RangeControl({
  label,
  value,
  valueLabel,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const draftValueRef = useRef(value);

  const updateDraft = (next: number) => {
    draftValueRef.current = next;
    setDraftValue(next);
  };
  const commitDraft = () => {
    if (draftValueRef.current !== value) onChange(draftValueRef.current);
  };

  return (
    <label>
      <div style={rangeHeaderStyle}>
        <span>{label}</span>
        <span style={rangeValueStyle}>
          {draftValue === value ? valueLabel : formatRangeValue(draftValue, step)}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        value={draftValue}
        min={min}
        max={max}
        step={step}
        onInput={(event) => updateDraft(Number(event.currentTarget.value))}
        onPointerUp={commitDraft}
        onKeyUp={commitDraft}
        onBlur={commitDraft}
        onPointerCancel={() => updateDraft(value)}
        style={{ width: "100%", margin: 0 }}
      />
    </label>
  );
}

function formatRangeValue(value: number, step: number): string {
  return step >= 1
    ? `${Math.round(value)}px`
    : value.toFixed(2).replace(/0$/, "");
}

const iconButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: T.dim,
  cursor: "pointer",
};

const helperTextStyle: CSSProperties = {
  margin: "6px 2px 0",
  color: T.dim,
  font: `500 11px/1.4 ${T.sans}`,
};

const rangeHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 9,
  color: T.ink2,
  font: `600 12px/1.2 ${T.sans}`,
};

const rangeValueStyle: CSSProperties = {
  color: T.dim,
  font: `600 11px/1 ${T.mono}`,
};

function footerButtonStyle(disabled: boolean): CSSProperties {
  return {
    minHeight: 32,
    padding: "0 11px",
    border: `1px solid ${T.rule}`,
    borderRadius: 7,
    background: T.surface,
    color: T.ink2,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    font: `600 11.5px/1 ${T.sans}`,
    transition: "transform 90ms ease, background 100ms ease",
  };
}
