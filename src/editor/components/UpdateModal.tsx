// Modal that appears either at startup (when an update is auto-detected)
// or after the user clicks "Check for Updates" in Settings. Renders the
// release notes + version diff and drives the download/install/relaunch
// flow via the platform updater abstraction.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { T } from "../../design/tokens";
import { formatBytes } from "../../shared/format";
import { Modal } from "./ui";
import { useIsMobile } from "../hooks/useIsMobile";
import { MarkdownView } from "./markdownView";
import { normalizeLanguage, pickFonts } from "./markdownLang";
import { notesMarkdownFor, notesToMarkdown } from "../../release/updateNotes";
import {
  applyUpdateAndRelaunch,
  type DownloadProgress,
  type ShioriUpdate,
} from "../../platform/updater";
import { UPDATES_URL } from "../../shared/links";

// Sibling of the manifest endpoint baked into tauri.conf.json. The
// updater plugin exposes only `body` (= manifest.notes) as a single
// string, so per-locale release notes live in a separate JSON we fetch
// alongside the modal mount. URL pattern is deterministic, derived
// from the update version. If the file is missing, the network is
// down, or the parse fails, we fall back to whatever `update.body`
// already gave us — so older versions of the app (or releases that
// skipped publishing the notes file) still render *something*.
const NOTES_URL_PREFIX = `${UPDATES_URL}/notes/`;

type Props = {
  update: ShioriUpdate;
  onClose: () => void;
};

type Phase =
  | { kind: "ready" }
  | { kind: "installing"; progress: DownloadProgress | null }
  | { kind: "error"; message: string };

export function UpdateModal({ update, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const fonts = pickFonts(normalizeLanguage(i18n.resolvedLanguage ?? i18n.language));
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [localizedNotes, setLocalizedNotes] = useState<string | null>(null);

  // Fetch the per-locale notes file once per (version, language)
  // change. Re-runs when the user flips the UI language so the modal
  // tracks the current locale without a remount.
  useEffect(() => {
    let cancelled = false;
    // Reset first so a failed or empty refetch (on a version/language change)
    // falls back to update.body instead of leaving the previous notes on screen.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalizedNotes(null);
    const url = `${NOTES_URL_PREFIX}${update.version}.json`;
    fetch(url)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (cancelled) return;
        const markdown = notesMarkdownFor(data, i18n.resolvedLanguage);
        if (markdown) setLocalizedNotes(markdown);
      })
      .catch(() => {
        // Silent fallback — `update.body` already covers "no notes"
        // case and we don't want a transient network error to look
        // like an update failure.
      });
    return () => {
      cancelled = true;
    };
  }, [update.version, i18n.resolvedLanguage]);

  const notesToRender =
    localizedNotes ?? (update.body ? notesToMarkdown(update.body) : null);

  const installing = phase.kind === "installing";
  const directAndroid = update.kind === "android-direct";

  const onInstall = async () => {
    setPhase({ kind: "installing", progress: null });
    try {
      await applyUpdateAndRelaunch(update, (progress) => {
        setPhase({ kind: "installing", progress });
      });
      // `relaunch()` doesn't return on success — the process exits and
      // re-execs into the new bundle. If we somehow get past it, fall
      // back to closing the modal.
      onClose();
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Modal
      onClose={installing ? () => undefined : onClose}
      title={t("update.title")}
      subtitle={t("update.subtitle", {
        from: update.currentVersion,
        to: update.version,
      })}
      width={560}
      closeDisabled={installing}
      hideClose={installing}
      footer={
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            alignItems: "center",
          }}
        >
          {phase.kind === "installing" ? (
            <ProgressIndicator progress={phase.progress} />
          ) : null}
          <button
            type="button"
            onClick={onClose}
            disabled={installing}
            style={{
              border: `1px solid ${T.rule}`,
              background: T.cream,
              color: T.ink,
              borderRadius: 4,
              padding: "8px 14px",
              font: `500 13px/1 ${T.sans}`,
              cursor: installing ? "not-allowed" : "pointer",
              opacity: installing ? 0.45 : 1,
            }}
          >
            {t("update.later")}
          </button>
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            style={{
              border: `1px solid ${T.ink}`,
              background: T.ink,
              color: T.surface,
              borderRadius: 4,
              padding: "8px 14px",
              font: `600 13px/1 ${T.sans}`,
              cursor: installing ? "not-allowed" : "pointer",
              opacity: installing ? 0.6 : 1,
            }}
          >
            {installing
              ? directAndroid
                ? t("update.downloadingApk")
                : t("update.installing")
              : directAndroid
                ? t("update.downloadAndInstallApk")
                : t("update.installNow")}
          </button>
        </div>
      }
    >
      <div
        style={{
          padding: "0 22px 6px",
          font: `13.5px/1.6 ${T.sans}`,
          color: T.ink,
        }}
      >
        {notesToRender ? (
          // Rendered like the in-app changelog, with the same renderer
          // (src/release/updateNotes.ts picks the markdown).
          <div
            className={isMobile ? "shioriTouchScroll" : undefined}
            style={{ maxHeight: 320, overflowY: "auto" }}
          >
            <MarkdownView markdown={notesToRender} fonts={fonts} />
          </div>
        ) : (
          <div style={{ color: T.dim, fontStyle: "italic" }}>
            {t("update.noNotes")}
          </div>
        )}

        {phase.kind === "error" ? (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              background: T.surface,
              border: `1px solid ${T.rect}`,
              borderRadius: 4,
              color: T.rect,
              font: `12.5px/1.5 ${T.mono}`,
            }}
          >
            {t("update.error", {
              message: humanUpdateError(phase.message, t),
            })}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function humanUpdateError(
  message: string,
  t: TFunction,
): string {
  const known = new Set([
    "android-install-permission-required",
    "android-update-sha256-missing",
    "android-update-sha256-mismatch",
    "android-update-size-mismatch",
    "android-update-package-mismatch",
    "android-update-apk-invalid",
    "android-update-version-not-newer",
    "android-update-version-mismatch",
    "android-update-url-not-allowed",
    "android-direct-updater-disabled",
    "android-install-launch-failed",
    "android-install-cancelled",
    "android-install-failed",
    // Thrown by platform/updater.ts and MainActivity.kt but never listed here,
    // so the modal showed the raw slug next to a translated prefix. This whole
    // path is dark in a google-play build (AGENTS.md fact 9), so it would
    // first reach real users on the day a direct-apk build ships.
    "android-update-failed",
    "android-update-request-failed",
    "android-update-request-invalid",
    "android-update-id-missing",
    "android-update-url-missing",
  ]);
  if (known.has(message)) {
    return t(`update.errors.${message}`);
  }
  // MainActivity appends the HTTP status: "android-update-download-failed-404".
  // Match by prefix so every status code resolves, and surface the code —
  // it is the single most useful detail when a download fails.
  const downloadFailed = /^android-update-download-failed-(\d{3})$/.exec(message);
  if (downloadFailed) {
    return t("update.errors.android-update-download-failed", {
      code: downloadFailed[1],
    });
  }
  // Everything else is passed through on purpose: the desktop Tauri updater
  // and Kotlin IOExceptions produce real sentences, not slugs.
  return message;
}

function ProgressIndicator({
  progress,
}: {
  progress: DownloadProgress | null;
}) {
  const { t } = useTranslation();
  if (!progress) {
    return (
      <span style={{ color: T.dim, font: `12px/1 ${T.mono}` }}>
        {t("update.starting")}
      </span>
    );
  }
  const { downloaded, total } = progress;
  if (total != null && total > 0) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    return (
      <span style={{ color: T.dim, font: `12px/1 ${T.mono}` }}>
        {pct}%
      </span>
    );
  }
  // Indeterminate: just show a byte count, no percentage.
  return (
    <span style={{ color: T.dim, font: `12px/1 ${T.mono}` }}>
      {formatBytes(downloaded)}
    </span>
  );
}
