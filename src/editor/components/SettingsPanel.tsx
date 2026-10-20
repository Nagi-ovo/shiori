import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { COLOR_MODE_OPTIONS, THEME_OPTIONS } from "../../design/theme";
import { PDF_PAPER_TONE_OPTIONS } from "../../design/pdfPaperTone";
import { Ic } from "./icons";
import {
  IconBtn,
  MiniIconBtn,
  Section,
  SegButtons,
  Switch,
} from "./ui";
import { useEscapeClose } from "./useEscapeClose";
import { useFocusTrap } from "./useFocusTrap";
import {
  useAppStore,
  type PrefsColorMode,
  type PrefsMargin,
  type PrefsPdfPaperTone,
  type PrefsTheme,
  type PrefsTerminalTheme,
  type RemoteImagePolicy,
} from "../store/store";
import { appVersion } from "../../runtime/version";
import {
  CAPABILITIES,
  closeWebPanel,
  openExternalUrl,
} from "../../platform";
import { WINDOW_CAPTION_HEIGHT } from "../../platform/windowCaption";
import { ShioriTile } from "../../brand/Mark";
import { toast } from "../toast";
import {
  FEEDBACK_URL,
  RELEASES_URL,
  WEBSITE_URL,
} from "../../shared/links";
import {
  SUPPORTED_LANGUAGES,
  changeLanguage,
  currentLanguage,
  type SupportedLanguage,
} from "../../i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { ResourceMetricsPanel } from "./ResourceMetricsPanel";
import { SponsorModal } from "./SponsorModal";
import { AccentColorSetting } from "./AccentColorSetting";
import { PdfPaperColorSetting } from "./PdfPaperColorSetting";
import { StorageControls } from "./SettingsStorage";

type UpdateCheckState = "idle" | "checking" | "uptodate" | "error";

const REMOTE_IMAGE_POLICIES = [
  "ask",
  "always",
  "never",
] as const satisfies readonly RemoteImagePolicy[];

type Props = {
  open: boolean;
  storageFocusKey?: number;
  onClose: () => void;
  // The auto-update story is owned by App.tsx — this panel only exposes
  // the trigger and reflects the result. Web builds simply hide the
  // section since there's no app to update.
  updateCheckState?: UpdateCheckState;
  updateCheckError?: string | null;
  onCheckForUpdates?: () => void;
  onOpenChangelog?: () => void;
};

export function SettingsPanel({ open, ...rest }: Props) {
  // The view mounts only while open so transient state inside it (the
  // sponsor modal, scroll position) resets naturally on close instead
  // of leaking into the next opening.
  if (!open) return null;
  return <SettingsPanelView {...rest} />;
}

function SettingsPanelView({
  storageFocusKey = 0,
  onClose,
  updateCheckState = "idle",
  updateCheckError = null,
  onCheckForUpdates,
  onOpenChangelog,
}: Omit<Props, "open">) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const backdropPressRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const storageRef = useRef<HTMLDivElement | null>(null);
  const prefs = useAppStore((s) => s.prefs);
  const setPrefs = useAppStore((s) => s.setPrefs);
  const resetWebPanel = useAppStore((s) => s.resetWebPanel);
  const setShowBetaDisclaimer = useAppStore((s) => s.setShowBetaDisclaimer);
  const [showSponsor, setShowSponsor] = useState(false);

  useEffect(() => {
    if (storageFocusKey === 0) return;
    window.setTimeout(() => {
      storageRef.current?.scrollIntoView({ block: "start" });
    }, 0);
  }, [storageFocusKey]);

  // SettingsPanel doesn't sit on the Modal shell, so it owns its own
  // Escape wiring. Without this, Esc fell through to the Canvas
  // shortcut handler — which guards on `[data-shiori-modal-open]` —
  // so the panel never closed. Add the attribute below for symmetry
  // with Modal. Suspended while the sponsor modal is stacked on top,
  // so one Escape dismisses the modal without also taking the panel.
  useEscapeClose(!showSponsor, onClose);
  useFocusTrap(panelRef, !showSponsor);

  useEffect(() => {
    const restoreFocus = restoreFocusRef.current;
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) {
        panel.focus({ preventScroll: true });
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (restoreFocus?.isConnected) {
        restoreFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const lang = currentLanguage();

  const colorModeLabel = (v: PrefsColorMode) =>
    t(`settings.colorModeOptions.${v}`);
  const terminalColorModeLabel = (v: PrefsColorMode) =>
    v === "Auto" ? t("settings.terminalColorModeAuto") : colorModeLabel(v);
  const themeLabel = (v: PrefsTheme) => t(`settings.themeOptions.${v}`);
  const terminalThemeLabel = (v: PrefsTerminalTheme) =>
    v === "Auto" ? t("settings.terminalThemeAuto") : themeLabel(v);
  const marginLabel = (v: PrefsMargin) => t(`settings.marginOptions.${v}`);
  const pdfPaperToneLabel = (v: PrefsPdfPaperTone) =>
    t(`settings.pdfPaperToneOptions.${v}`);
  const remoteImagePolicyLabel = (v: RemoteImagePolicy) =>
    t(`settings.remoteImagePolicyOptions.${v}`);
  const langLabel = (v: SupportedLanguage) =>
    t(`settings.languageOptions.${v}`);

  return (
    <>
    <div
      onPointerDown={(event) => {
        backdropPressRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!backdropPressRef.current) return;
        onClose();
      }}
      data-shiori-modal-open=""
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26,24,21,0.32)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        zIndex: 30,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          width: "min(100vw, clamp(320px, 28vw, 440px))",
          height: "100%",
          background: T.cream,
          borderLeft: `1px solid ${T.rule}`,
          display: "flex",
          flexDirection: "column",
          animation: "opxSlideIn .2s ease",
        }}
      >
        <style>{`@keyframes opxSlideIn { from { transform: translateX(24px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }`}</style>
        <div
          style={{
            // Full-height from the window's top edge: on Windows the caption
            // buttons float over this corner, so the header starts below them.
            padding: `calc(${
              20 + (CAPABILITIES.customWindowCaption ? WINDOW_CAPTION_HEIGHT : 0)
            }px + var(--shiori-safe-top, 0px)) calc(22px + var(--shiori-safe-right, 0px)) 14px 22px`,
            borderBottom: `1px solid ${T.rule}`,
            display: "flex",
            alignItems: "flex-start",
            flex: "0 0 auto",
          }}
        >
          <div style={{ flex: 1 }}>
            <div
              id={titleId}
              style={{
                font: `${T.displayStyle} 22px/1.15 ${T.serif}`,
                color: T.ink,
              }}
            >
              {t("settings.title")}
            </div>
            <div
              style={{
                font: `12.5px/1.4 ${T.sans}`,
                color: T.dim,
                marginTop: 4,
              }}
            >
              {t("settings.subtitle")}
            </div>
          </div>
          <MiniIconBtn onClick={onClose} title={t("settings.close")}>
            <Ic.x />
          </MiniIconBtn>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding:
              "16px calc(22px + var(--shiori-safe-right, 0px)) calc(22px + var(--shiori-safe-bottom, 0px)) 22px",
          }}
        >
          <Section label={t("settings.sections.language")}>
            <SettingRow
              name={t("settings.language")}
              hint={t("settings.languageHint")}
              block
            >
              <SegButtons<string>
                options={(SUPPORTED_LANGUAGES as readonly string[]).map(
                  (l) => langLabel(l as SupportedLanguage),
                )}
                value={langLabel(lang)}
                onChange={(label) => {
                  const idx = (
                    SUPPORTED_LANGUAGES as readonly string[]
                  ).findIndex((l) => langLabel(l as SupportedLanguage) === label);
                  const next = SUPPORTED_LANGUAGES[idx] ?? "en";
                  void changeLanguage(next);
                  void i18n.changeLanguage(next);
                }}
              />
            </SettingRow>
          </Section>

          <Section label={t("settings.sections.appearance")}>
            <SettingRow name={t("settings.colorMode")} block>
              <SegButtons<string>
                options={COLOR_MODE_OPTIONS.map(colorModeLabel)}
                value={colorModeLabel(prefs.colorMode)}
                onChange={(label) => {
                  const next =
                    COLOR_MODE_OPTIONS.find((v) => colorModeLabel(v) === label) ??
                    "Light";
                  setPrefs({ colorMode: next });
                }}
              />
            </SettingRow>
            <SettingRow name={t("settings.theme")} block>
              <SegButtons<string>
                options={THEME_OPTIONS.map(themeLabel)}
                value={themeLabel(prefs.theme)}
                onChange={(label) => {
                  const next =
                    THEME_OPTIONS.find((v) => themeLabel(v) === label) ??
                    "Default";
                  setPrefs({ theme: next });
                }}
              />
            </SettingRow>
            <AccentColorSetting
              accentColor={prefs.accentColor}
              colorMode={prefs.colorMode}
              theme={prefs.theme}
              onChange={(accentColor) => setPrefs({ accentColor })}
            />
            <SettingRow
              name={t("settings.pdfPaperTone")}
              hint={t("settings.pdfPaperToneHint")}
              block
            >
              <SegButtons<string>
                options={PDF_PAPER_TONE_OPTIONS.map(pdfPaperToneLabel)}
                value={pdfPaperToneLabel(prefs.pdfPaperTone)}
                onChange={(label) => {
                  const next =
                    PDF_PAPER_TONE_OPTIONS.find(
                      (value) => pdfPaperToneLabel(value) === label,
                    ) ?? "Original";
                  setPrefs({ pdfPaperTone: next });
                }}
              />
              {prefs.pdfPaperTone === "Custom" ? (
                <PdfPaperColorSetting
                  color={prefs.pdfPaperCustomColor}
                  onChange={(pdfPaperCustomColor) =>
                    setPrefs({ pdfPaperCustomColor })
                  }
                />
              ) : null}
            </SettingRow>
            {CAPABILITIES.embeddedTerminal ? (
              <>
                <SettingRow
                  name={t("settings.terminalColorMode")}
                  hint={t("settings.terminalColorModeHint")}
                  block
                >
                  <SegButtons<string>
                    options={COLOR_MODE_OPTIONS.map(terminalColorModeLabel)}
                    value={terminalColorModeLabel(prefs.terminalColorMode)}
                    onChange={(label) => {
                      const next =
                        COLOR_MODE_OPTIONS.find(
                          (v) => terminalColorModeLabel(v) === label,
                        ) ?? "Auto";
                      setPrefs({ terminalColorMode: next });
                    }}
                  />
                </SettingRow>
                <SettingRow
                  name={t("settings.terminalTheme")}
                  hint={t("settings.terminalThemeHint")}
                  block
                >
                  <SegButtons<string>
                    options={(["Auto", ...THEME_OPTIONS] as const).map(
                      terminalThemeLabel,
                    )}
                    value={terminalThemeLabel(prefs.terminalTheme)}
                    onChange={(label) => {
                      const next =
                        (["Auto", ...THEME_OPTIONS] as const).find(
                          (v) => terminalThemeLabel(v) === label,
                        ) ?? "Auto";
                      setPrefs({ terminalTheme: next });
                    }}
                  />
                </SettingRow>
              </>
            ) : null}
            <SettingRow
              name={t("settings.serifAccents")}
              hint={t("settings.serifAccentsHint")}
            >
              <Switch
                on={prefs.serifAccents}
                ariaLabel={t("settings.serifAccents")}
                onChange={(v) => setPrefs({ serifAccents: v })}
              />
            </SettingRow>
            <SettingRow
              name={t("settings.pageMargin")}
              hint={t("settings.pageMarginHint")}
              block
            >
              <SegButtons<string>
                options={(["Tight", "Comfortable", "Roomy"] as PrefsMargin[]).map(
                  marginLabel,
                )}
                value={marginLabel(prefs.pageMargin)}
                onChange={(label) => {
                  const idx = (
                    ["Tight", "Comfortable", "Roomy"] as PrefsMargin[]
                  ).findIndex((v) => marginLabel(v) === label);
                  const next =
                    (["Tight", "Comfortable", "Roomy"] as PrefsMargin[])[idx] ??
                    "Comfortable";
                  setPrefs({ pageMargin: next });
                }}
              />
            </SettingRow>
            <SettingRow
              name={t("settings.annotationAnimations")}
              hint={t("settings.annotationAnimationsHint")}
            >
              <Switch
                on={prefs.annotationAnimations}
                ariaLabel={t("settings.annotationAnimations")}
                onChange={(v) => setPrefs({ annotationAnimations: v })}
              />
            </SettingRow>
            {CAPABILITIES.embeddedTerminal ? (
              <SettingRow
                name={t("settings.calloutFollowUp")}
                hint={t("settings.calloutFollowUpHint")}
              >
                <Switch
                  on={prefs.showCalloutFollowUp}
                  ariaLabel={t("settings.calloutFollowUp")}
                  onChange={(v) => setPrefs({ showCalloutFollowUp: v })}
                />
              </SettingRow>
            ) : null}
          </Section>
          <Section label={t("settings.sections.privacy")}>
            <SettingRow
              name={t("settings.remoteImagePolicy")}
              hint={t("settings.remoteImagePolicyHint")}
              block
            >
              <SegButtons<string>
                options={REMOTE_IMAGE_POLICIES.map(remoteImagePolicyLabel)}
                value={remoteImagePolicyLabel(prefs.remoteImagePolicy)}
                onChange={(label) => {
                  const idx = REMOTE_IMAGE_POLICIES.findIndex(
                    (v) => remoteImagePolicyLabel(v) === label,
                  );
                  const next = REMOTE_IMAGE_POLICIES[idx] ?? "ask";
                  setPrefs({ remoteImagePolicy: next });
                }}
              />
            </SettingRow>
            {CAPABILITIES.embeddedBrowserPanel ? (
              <SettingRow
                name={t("settings.browserPersistSession")}
                hint={t("settings.browserPersistSessionHint")}
              >
                <Switch
                  on={prefs.browserPersistSession}
                  ariaLabel={t("settings.browserPersistSession")}
                  onChange={(v) => {
                    setPrefs({ browserPersistSession: v });
                    resetWebPanel();
                    void closeWebPanel().catch(() => undefined);
                  }}
                />
              </SettingRow>
            ) : null}
          </Section>
          <Section label={t("settings.sections.performance")}>
            <SettingRow
              name={t("settings.preRender")}
              hint={t("settings.preRenderHint")}
            >
              <Switch
                on={prefs.preRenderThumbs}
                ariaLabel={t("settings.preRender")}
                onChange={(v) => setPrefs({ preRenderThumbs: v })}
              />
            </SettingRow>
            <ResourceMetricsPanel />
          </Section>
          <div ref={storageRef}>
            <Section label={t("storage.section")}>
              <StorageControls />
            </Section>
          </div>
          <Section label={t("settings.sections.about")}>
            <AboutCard
              updateCheckState={updateCheckState}
              updateCheckError={updateCheckError}
              onCheckForUpdates={onCheckForUpdates}
              onOpenSponsor={() => setShowSponsor(true)}
              onOpenChangelog={
                onOpenChangelog
                  ? () => {
                      // Close the panel first — the changelog modal and
                      // this panel both listen for Escape, and stacking
                      // them means one keypress would dismiss both.
                      onClose();
                      onOpenChangelog();
                    }
                  : undefined
              }
            />
            <div>
              <IconBtn
                tone="outline"
                onClick={() => {
                  onClose();
                  setShowBetaDisclaimer(true);
                }}
              >
                {t("settings.viewDisclaimer")}
              </IconBtn>
            </div>
          </Section>
        </div>
      </div>
    </div>
    {/* Sibling of the panel backdrop — nesting a fixed overlay inside
        it would re-anchor to the backdrop's containing block (it has a
        backdrop-filter) and ride the panel's slide-in transform. */}
    {showSponsor ? (
      <SponsorModal onClose={() => setShowSponsor(false)} />
    ) : null}
    </>
  );
}

function AboutCard({
  updateCheckState,
  updateCheckError,
  onCheckForUpdates,
  onOpenChangelog,
  onOpenSponsor,
}: {
  updateCheckState: UpdateCheckState;
  updateCheckError: string | null;
  onCheckForUpdates?: () => void;
  onOpenChangelog?: () => void;
  onOpenSponsor: () => void;
}) {
  const { t } = useTranslation();
  const showUpdater =
    CAPABILITIES.nativeUpdater || CAPABILITIES.androidDirectUpdater;

  const openLink = (url: string) => {
    void openExternalUrl(url).catch(() => {
      toast.error(t("toast.linkOpenFailed"));
    });
  };
  const copyVersion = async () => {
    try {
      await navigator.clipboard.writeText(`Shiori ${appVersion}`);
      toast.show(t("settings.versionCopied"));
    } catch {
      toast.error(t("settings.versionCopyFailed"));
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${T.rule}`,
        borderRadius: 6,
        background: T.surface,
        padding: "14px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ShioriTile size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              font: `600 15px/1.2 ${T.klee}`,
              color: T.ink,
              letterSpacing: "-.005em",
            }}
          >
            Shiori
          </div>
          <button
            type="button"
            onClick={() => void copyVersion()}
            title={t("settings.copyVersion")}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              marginTop: 3,
              font: `500 11.5px/1 ${T.mono}`,
              color: T.dim,
              letterSpacing: ".04em",
              cursor: "pointer",
            }}
          >
            {appVersion}
          </button>
        </div>
        {showUpdater ? (
          <IconBtn
            tone="outline"
            onClick={() => onCheckForUpdates?.()}
            disabled={updateCheckState === "checking"}
          >
            {updateCheckState === "checking"
              ? t("settings.checkingForUpdates")
              : t("settings.checkForUpdates")}
          </IconBtn>
        ) : null}
      </div>
      <div
        style={{
          font: `12.5px/1.55 ${T.sans}`,
          color: T.dim,
          marginTop: 10,
        }}
      >
        {t("settings.about")}
      </div>
      {showUpdater && CAPABILITIES.androidDirectUpdater ? (
        <div
          style={{
            font: `12.5px/1.55 ${T.sans}`,
            color: T.dim,
            marginTop: 8,
          }}
        >
          {t("settings.directApkUpdates")}
        </div>
      ) : null}
      {showUpdater && updateCheckState === "uptodate" ? (
        <div
          style={{ font: `12.5px/1.4 ${T.sans}`, color: T.dim, marginTop: 8 }}
        >
          {t("settings.upToDate")}
        </div>
      ) : null}
      {showUpdater && updateCheckState === "error" && updateCheckError ? (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            background: T.paper,
            border: `1px solid ${T.rect}`,
            borderRadius: 4,
            color: T.rect,
            font: `12px/1.5 ${T.mono}`,
          }}
        >
          {t("update.error", { message: updateCheckError })}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 12,
          paddingTop: 10,
          borderTop: `1px dashed ${T.ruleSoft}`,
        }}
      >
        <AboutLink onClick={() => openLink(WEBSITE_URL)}>
          {t("settings.aboutLinks.website")}
        </AboutLink>
        <AboutLinkDot />
        <AboutLink onClick={() => openLink(RELEASES_URL)}>
          {t("settings.aboutLinks.releases")}
        </AboutLink>
        {onOpenChangelog ? (
          <>
            <AboutLinkDot />
            <AboutLink onClick={onOpenChangelog}>
              {t("changelog.title")}
            </AboutLink>
          </>
        ) : null}
        <AboutLinkDot />
        <AboutLink onClick={() => openLink(FEEDBACK_URL)}>
          {t("landing.footer.feedback")}
        </AboutLink>
      </div>
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: `1px dashed ${T.ruleSoft}`,
        }}
      >
        <button
          type="button"
          onClick={onOpenSponsor}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            font: `500 11px/1.4 ${T.mono}`,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: T.dim,
            cursor: "pointer",
          }}
        >
          <Ic.heart width={12} height={12} />
          {t("sponsor.entry")}
        </button>
      </div>
    </div>
  );
}

// Quiet text links in the Landing-footer idiom — uppercase mono, no
// chrome. Used only inside the About card.
function AboutLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        padding: 0,
        font: `500 11px/1.4 ${T.mono}`,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: T.dim,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function AboutLinkDot() {
  return (
    <span aria-hidden style={{ color: T.dim, opacity: 0.5 }}>
      ·
    </span>
  );
}

function SettingRow({
  name,
  hint,
  children,
  block,
}: {
  name: string;
  hint?: string;
  children: React.ReactNode;
  // Wide controls (the three-option segmented switches) stack full-width under
  // the label on phones — the panel is only ~320px there, too tight to keep a
  // long-CJK segmented control inline. Compact toggles stay inline at the right
  // (cleaner, and they always fit), so they leave this off.
  block?: boolean;
}) {
  const isMobile = useIsMobile();
  const stacked = isMobile && block;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "stretch" : "center",
        flexWrap: stacked ? "nowrap" : "wrap",
        gap: stacked ? 8 : "8px 12px",
        padding: "10px 0",
        borderBottom: `1px solid ${T.ruleSoft}`,
      }}
    >
      {/* Off the stacked path, keep a floor under the text column: a wide
          control sharing the row would otherwise squeeze it toward zero, and
          since CJK has no word breaks the label collapses into a
          one-character-per-line stack. */}
      <div style={{ flex: stacked ? "0 0 auto" : "1 1 150px" }}>
        <div style={{ font: `500 13.5px/1.3 ${T.sans}`, color: T.ink }}>
          {name}
        </div>
        {hint ? (
          <div
            style={{
              font: `12.5px/1.45 ${T.sans}`,
              color: T.dim,
              marginTop: 2,
            }}
          >
            {hint}
          </div>
        ) : null}
      </div>
      <div style={{ flex: "0 0 auto", width: stacked ? "100%" : undefined }}>
        {children}
      </div>
    </div>
  );
}
