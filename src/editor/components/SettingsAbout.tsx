import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { IconBtn } from "./ui";
import { appVersion } from "../../runtime/version";
import { CAPABILITIES, openExternalUrl } from "../../platform";
import { ShioriTile } from "../../brand/Mark";
import { toast } from "../toast";
import {
  FEEDBACK_URL,
  RELEASES_URL,
  WEBSITE_URL,
} from "../../shared/links";

// The About card at the foot of Settings: version, update check, links and
// the sponsor entry.

export type UpdateCheckState = "idle" | "checking" | "uptodate" | "error";

export function AboutCard({
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
