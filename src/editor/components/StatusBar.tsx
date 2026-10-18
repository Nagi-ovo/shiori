import { useTranslation } from "react-i18next";
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  getLiveZoomIndicator,
  subscribeLiveZoomIndicator,
} from "./liveZoomIndicator";
import { toast } from "../toast";
import { T } from "../../design/tokens";
import { Dot } from "./ui";
import { useEditorStore } from "../store/store";
import {
  formatBytes,
  formatRelative,
  nextRelativeChangeAt,
  relativeLabelsFor,
} from "../../shared/format";
import type { DraftSyncState } from "../hooks/useDraftSync";
import type { ExportStatus } from "../export/exportStatus";
import { CAP_BYTES } from "../../storage/drafts";
import { useDeadlineClock } from "../hooks/useDeadlineClock";
import { useIsMobile } from "../hooks/useIsMobile";

export type StatusBarProps = {
  draft: DraftSyncState;
  exportStatus: ExportStatus;
  onOpenStorage: () => void;
  // Non-null right after a draft was silently restored: when it was last
  // touched, so the bar can say what happened and offer the original.
  restoredDraftAt: number | null;
  // True while a draft is set aside ("open the original"): the bar offers the
  // way back in, since editing in this state raises the overwrite dialog.
  draftSetAside: boolean;
  onOpenOriginal: () => void;
  onRestoreSetAsideDraft: () => void;
};

const HISTORY_FEEDBACK_MS = 2500;

function earliestDeadline(...deadlines: (number | null)[]): number | null {
  let earliest: number | null = null;
  for (const deadline of deadlines) {
    if (deadline === null) continue;
    if (earliest === null || deadline < earliest) earliest = deadline;
  }
  return earliest;
}

const INLINE_ACTION_STYLE: CSSProperties = {
  appearance: "none",
  border: 0,
  padding: 0,
  margin: 0,
  background: "transparent",
  color: T.accentText,
  font: "inherit",
  letterSpacing: "inherit",
  textTransform: "inherit",
  cursor: "pointer",
};

/**
 * Compact viewports get no permanent bottom row at all.
 *
 * Of the six things the bar said, only the page number was standing state a
 * reader wants, and it moved to <PageIndicatorPill /> — a chip that floats
 * over the document while scrolling. Of the rest, the zoom readout is
 * transient (the pinch indicator already shows it), "unexported changes" is
 * already the dot on the export button, "Saved" is true nearly always, and
 * the draft affordances are one-off events, which become toasts below.
 *
 * The desktop bar is unchanged: it has the width for six items and, with a
 * pointer and no thumb covering the screen, they are worth their row.
 */
export function StatusBar(props: StatusBarProps) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <MobileDraftNotice
        restoredDraftAt={props.restoredDraftAt}
        draftSetAside={props.draftSetAside}
        onOpenOriginal={props.onOpenOriginal}
        onRestoreSetAsideDraft={props.onRestoreSetAsideDraft}
      />
    );
  }
  return <DesktopStatusBar {...props} />;
}

export type MobileDraftNoticeProps = Pick<
  StatusBarProps,
  | "restoredDraftAt"
  | "draftSetAside"
  | "onOpenOriginal"
  | "onRestoreSetAsideDraft"
>;

/**
 * The mobile stand-in for the bar's draft slot. Renders nothing.
 *
 * Restoring a draft and setting one aside are one-off events, not standing
 * state, so on a phone each is announced once as an actionable toast rather
 * than parked in a row the user has to scroll sideways to read. The action
 * button carries the same route the bar used to hold open: back to the
 * original file, and back to the set-aside draft.
 */
export function MobileDraftNotice({
  restoredDraftAt,
  draftSetAside,
  onOpenOriginal,
  onRestoreSetAsideDraft,
}: MobileDraftNoticeProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  // App passes fresh inline arrows on every render. Reading them through a
  // ref keeps them out of the effect deps, so a re-render for an unrelated
  // reason cannot re-announce a draft the user already dealt with.
  const onOpenOriginalRef = useRef(onOpenOriginal);
  const onRestoreSetAsideDraftRef = useRef(onRestoreSetAsideDraft);
  useEffect(() => {
    onOpenOriginalRef.current = onOpenOriginal;
    onRestoreSetAsideDraftRef.current = onRestoreSetAsideDraft;
  }, [onOpenOriginal, onRestoreSetAsideDraft]);

  const announcedRestoreAt = useRef<number | null>(null);
  useEffect(() => {
    if (restoredDraftAt == null) {
      announcedRestoreAt.current = null;
      return;
    }
    if (announcedRestoreAt.current === restoredDraftAt) return;
    announcedRestoreAt.current = restoredDraftAt;
    toast.showActions(
      t("drafts.restoredNotice", {
        rel: formatRelative(
          restoredDraftAt,
          Date.now(),
          relativeLabelsFor(language),
        ),
      }),
      [
        {
          label: t("drafts.openOriginal"),
          onClick: () => onOpenOriginalRef.current(),
        },
      ],
    );
  }, [language, restoredDraftAt, t]);

  const announcedSetAside = useRef(false);
  useEffect(() => {
    if (!draftSetAside) {
      announcedSetAside.current = false;
      return;
    }
    if (announcedSetAside.current) return;
    announcedSetAside.current = true;
    toast.showActions(t("drafts.setAside"), [
      {
        label: t("drafts.restoreSetAside"),
        onClick: () => onRestoreSetAsideDraftRef.current(),
      },
    ]);
  }, [draftSetAside, t]);

  return null;
}

function DesktopStatusBar({
  draft,
  exportStatus,
  onOpenStorage,
  restoredDraftAt,
  draftSetAside,
  onOpenOriginal,
  onRestoreSetAsideDraft,
}: StatusBarProps) {
  const { t, i18n } = useTranslation();
  const pages = useEditorStore((s) => s.model.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const tool = useEditorStore((s) => s.tool);
  const scale = useEditorStore((s) => s.scale);
  // Live pinch preview scale — the committed store scale stands still during
  // a gesture, but the readout should follow the fingers.
  const liveZoom = useSyncExternalStore(
    subscribeLiveZoomIndicator,
    getLiveZoomIndicator,
  );
  const shownScale = liveZoom ?? scale;
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const overlays = useEditorStore((s) => s.model.overlays);
  const historyFeedback = useEditorStore((s) => s.historyFeedback);
  // No polling clock. The two time-dependent labels below each know the
  // next instant they change, and the bar re-renders once at the earliest of
  // them — an idle bar schedules nothing at all.
  const now = useDeadlineClock((at) =>
    earliestDeadline(
      historyFeedback && at < historyFeedback.at + HISTORY_FEEDBACK_MS
        ? historyFeedback.at + HISTORY_FEEDBACK_MS
        : null,
      restoredDraftAt != null ? nextRelativeChangeAt(restoredDraftAt, at) : null,
    ),
  );
  const pageIdx = Math.max(
    0,
    pages.findIndex((p) => p.id === activePageId),
  );
  const selection =
    selectedIds.length > 0
      ? overlays.find((o) => o.id === selectedIds[0])
      : null;
  const toolLabel = selection
    ? t("inspector.selectionPrefix", { type: t(`types.${selection.type}`) }) +
      ` · ${selection.id.slice(0, 6)}`
    : t(`tools.${tool}Long`);

  const draftLabel = renderDraftLabel(draft, t);
  const exportLabel = renderExportStatusLabel(exportStatus, t);
  const exportTitle = renderExportStatusTitle(exportStatus, t);
  const historyExpiresAt =
    historyFeedback ? historyFeedback.at + HISTORY_FEEDBACK_MS : null;
  const historyLabel =
    historyExpiresAt !== null && now < historyExpiresAt
      ? t(`history.${historyFeedback!.kind}`)
      : null;
  const restoredRel =
    restoredDraftAt != null
      ? formatRelative(
          restoredDraftAt,
          now,
          relativeLabelsFor(i18n.resolvedLanguage ?? i18n.language),
        )
      : null;
  const storageUsedBytes = draft.realUsedBytes ?? draft.usedBytes;
  const storageLimitBytes = draft.quotaBytes ?? CAP_BYTES;
  const storageLabel = `${formatBytes(storageUsedBytes)} / ${formatBytes(storageLimitBytes)}`;
  const storageTitle =
    draft.quotaBytes == null
      ? `${t("storage.openManager")} · ${t("storage.capNote")}`
      : t("storage.openManager");

  return (
    <div
      className="shioriPrintHide shioriStatusBar"
      style={{
        height: 28,
        flex: "0 0 auto",
        background: T.cream,
        borderTop: `1px solid ${T.rule}`,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        gap: 16,
        // The row is a fixed 28px tall and its content is variable: a
        // restored draft adds three more items. Without these it wrapped
        // onto three lines and spilled out of the bar (26.9.8 on Android,
        // before the bar became desktop-only). Scroll, never wrap.
        flexWrap: "nowrap",
        whiteSpace: "nowrap",
        overflowX: "auto",
        overflowY: "hidden",
        font: `500 11px/1 ${T.mono}`,
        color: T.dim,
        letterSpacing: ".04em",
        textTransform: "uppercase",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span>
        {t("meta.pageShort")} {String(pageIdx + 1).padStart(2, "0")} /{" "}
        {String(pages.length).padStart(2, "0")}
      </span>
      <Dot />
      <span>{toolLabel}</span>
      <Dot />
      <span>{Math.round(shownScale * 100)}%</span>
      {historyLabel ? (
        <>
          <Dot />
          <span style={{ color: T.ink }}>{historyLabel}</span>
        </>
      ) : null}
      {/* Draft affordances live here permanently — restoring is silent, so
          this is the one place that says what happened and offers the way
          back. No toast: a fading notice would strand the user with restored
          edits and no visible route to the original file. */}
      {draftSetAside ? (
        <>
          <Dot />
          <span style={{ color: T.ink }}>{t("drafts.setAside")}</span>
          <button
            type="button"
            onClick={onRestoreSetAsideDraft}
            style={INLINE_ACTION_STYLE}
          >
            {t("drafts.restoreSetAside")}
          </button>
        </>
      ) : restoredRel ? (
        <>
          <Dot />
          <span style={{ color: T.ink }}>
            {t("drafts.restoredNotice", { rel: restoredRel })}
          </span>
          <button
            type="button"
            onClick={onOpenOriginal}
            style={INLINE_ACTION_STYLE}
          >
            {t("drafts.openOriginal")}
          </button>
        </>
      ) : null}
      <div style={{ flex: 1 }} />
      <span
        title={exportTitle}
        style={{
          color:
            exportStatus.kind === "needsExport"
              ? T.rect
              : exportStatus.kind === "exported"
                ? T.ink
                : T.dim,
        }}
      >
        {exportLabel}
      </span>
      {draftLabel ? (
        <>
          <Dot />
          <span
            style={{
              color:
                draft.status === "saved"
                  ? T.ink
                  : draft.status === "saving" || draft.status === "dirty"
                    ? T.rect
                    : draft.status === "error"
                      ? T.rect
                    : T.dim,
            }}
          >
            {draftLabel}
          </span>
        </>
      ) : null}
      <Dot />
      <button
        type="button"
        onClick={onOpenStorage}
        title={storageTitle}
        style={{
          appearance: "none",
          border: 0,
          padding: 0,
          margin: 0,
          background: "transparent",
          color: T.ink,
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
          cursor: "pointer",
        }}
      >
        {storageLabel}
      </button>
      <Dot />
      <span style={{ color: T.ink }}>{t("meta.localOnly")}</span>
    </div>
  );
}

function renderExportStatusLabel(
  exportStatus: ExportStatus,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return t(`exportStatus.${exportStatus.kind}`);
}

function renderExportStatusTitle(
  exportStatus: ExportStatus,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  if (exportStatus.kind === "exported") {
    return t("exportStatus.exportedTitle", {
      path: exportStatus.path ?? t("exportStatus.unknownPath"),
    });
  }
  return t(`exportStatus.${exportStatus.kind}Title`);
}

function renderDraftLabel(
  draft: DraftSyncState,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string | null {
  if (draft.status === "saving") return t("drafts.saving");
  if (draft.status === "dirty") return t("drafts.unsaved");
  if (draft.status === "error") return t("drafts.saveFailed");
  if (draft.status === "saved" && draft.lastTouched != null) {
    return t("drafts.saved");
  }
  // Idle (no draft yet) says nothing: "no draft exists" is an implementation
  // detail, not something a reader needs a status lamp for.
  return null;
}
