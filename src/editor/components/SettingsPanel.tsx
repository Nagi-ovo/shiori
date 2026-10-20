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
import { useInertBackground } from "./useInertBackground";
import {
  useAppStore,
  type PrefsColorMode,
  type PrefsMargin,
  type PrefsPdfPaperTone,
  type PrefsTheme,
  type PrefsTerminalTheme,
  type RemoteImagePolicy,
} from "../store/store";
import { CAPABILITIES, closeWebPanel } from "../../platform";
import { WINDOW_CAPTION_HEIGHT } from "../../platform/windowCaption";
import {
  SUPPORTED_LANGUAGES,
  changeLanguage,
  currentLanguage,
  type SupportedLanguage,
} from "../../i18n";
import { ResourceMetricsPanel } from "./ResourceMetricsPanel";
import { SponsorModal } from "./SponsorModal";
import { AccentColorSetting } from "./AccentColorSetting";
import { PdfPaperColorSetting } from "./PdfPaperColorSetting";
import { StorageControls } from "./SettingsStorage";
import { SettingRow } from "./SettingRow";
import { AboutCard, type UpdateCheckState } from "./SettingsAbout";

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
  const backdropRef = useRef<HTMLDivElement | null>(null);
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
  // As in Modal: the trap only catches Tab, so the browse cursor and touch
  // swipe would otherwise walk out into the page behind the backdrop.
  useInertBackground(backdropRef, !showSponsor);

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
      ref={backdropRef}
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
