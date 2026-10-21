import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { IconBtn, MiniIconBtn } from "./ui";
import {
  readStorageEstimate,
  type StorageEstimateResult,
} from "../../platform";
import drafts, {
  CAP_BYTES,
  type DraftMeta,
  type EvictionNotice,
} from "../../storage/drafts";
import {
  formatBytes,
  formatRelative,
  relativeLabelsFor,
} from "../../shared/format";
import { useNow } from "../hooks/useNow";
import { draftSource } from "../../storage/draftIdentity";

/** The path a draft belongs to, when it was saved from one (fact 4). */
function draftPath(id: string): string | undefined {
  const source = draftSource(id);
  return source?.type === "path" ? source.path : undefined;
}

// The Storage section of Settings: local draft usage, eviction notices and
// per-draft deletion.
export function StorageControls() {
  const { t, i18n } = useTranslation();
  const now = useNow(30_000);
  const [list, setList] = useState<DraftMeta[]>([]);
  const [tick, setTick] = useState(0);
  const [notices, setNotices] = useState<EvictionNotice[]>([]);
  const [estimate, setEstimate] = useState<StorageEstimateResult>({
    usage: null,
    quota: null,
    persisted: null,
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([drafts.list(), readStorageEstimate()]).then((rows) => {
      if (cancelled) return;
      const [draftRows, storageEstimate] = rows;
      setList(draftRows);
      setNotices(drafts.getEvictionNotices());
      setEstimate(storageEstimate);
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    return drafts.subscribe(() => setTick((n) => n + 1));
  }, []);

  const onDismissNotices = () => {
    drafts.clearEvictionNotices();
    setNotices([]);
  };

  const usedBytes = list.reduce((acc, d) => acc + d.storageBytes, 0);
  const relativeLabels = relativeLabelsFor(i18n.resolvedLanguage ?? i18n.language);
  const rel = (ms: number) => formatRelative(ms, now, relativeLabels);

  const onDelete = async (id: string) => {
    await drafts.remove(id);
    setTick((n) => n + 1);
  };
  // Two-step, because a single click here destroys the autosaved annotation
  // draft for EVERY PDF the user has edited — the data the app promises to
  // recover across sessions — with no dialog and no undo, and
  // the button sits one tab stop away from each row's own delete icon.
  // Matches the confirm pattern already used by RestoreDraftDialog.
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  useEffect(() => {
    if (!confirmingClearAll) return;
    // Do not leave the destructive state armed indefinitely.
    const timer = window.setTimeout(() => setConfirmingClearAll(false), 8000);
    return () => window.clearTimeout(timer);
  }, [confirmingClearAll]);
  const onClearAll = async () => {
    await drafts.clearAll();
    setConfirmingClearAll(false);
    setTick((n) => n + 1);
  };

  const displayedUsedBytes = estimate.usage ?? usedBytes;
  const displayedLimitBytes = estimate.quota ?? CAP_BYTES;
  const pct =
    displayedLimitBytes > 0
      ? Math.min(
          100,
          Math.round((displayedUsedBytes / displayedLimitBytes) * 100),
        )
      : 0;
  const hasRealQuota = estimate.quota != null;
  const storagePosture =
    estimate.persisted === true
      ? t("storage.persistent")
      : estimate.persisted === false
        ? t("storage.bestEffort")
        : null;

  return (
    <div>
      <div
        style={{
          font: `500 12px/1.4 ${T.mono}`,
          color: T.dim,
          letterSpacing: ".04em",
          marginBottom: hasRealQuota ? 8 : 4,
        }}
      >
        {hasRealQuota
          ? t("storage.usedOfQuota", {
              used: formatBytes(displayedUsedBytes),
              quota: formatBytes(displayedLimitBytes),
            })
          : t("storage.used", {
              used: formatBytes(displayedUsedBytes),
              cap: formatBytes(displayedLimitBytes),
            })}
        {" · "}
        {t("storage.draftCount", { count: list.length })}
      </div>
      {hasRealQuota ? null : (
        <div
          style={{
            font: `12px/1.4 ${T.sans}`,
            color: T.dim,
            marginBottom: 8,
          }}
        >
          {t("storage.capNote")}
        </div>
      )}
      <div
        style={{
          height: 6,
          background: T.tint,
          borderRadius: 3,
          overflow: "hidden",
          marginBottom: storagePosture ? 6 : 12,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: pct > 85 ? T.rect : T.ink,
            transition: "width 200ms ease",
          }}
        />
      </div>
      {storagePosture ? (
        <div
          style={{
            font: `12px/1.4 ${T.sans}`,
            color: T.dim,
            marginBottom: 12,
          }}
        >
          {storagePosture}
        </div>
      ) : null}
      {notices.length > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "8px 12px",
            borderRadius: 4,
            background: "#f7e2de",
            border: "1px solid #e0b5ab",
            color: "#7a2418",
            font: `12.5px/1.45 ${T.sans}`,
            marginBottom: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            {t("storage.evictionNotice", {
              count: notices.length,
              names: notices.map((n) => n.fileName).join(", "),
            })}
          </div>
          <button
            type="button"
            onClick={onDismissNotices}
            style={{
              flex: "0 0 auto",
              padding: "2px 8px",
              border: "1px solid #e0b5ab",
              background: "transparent",
              color: "#7a2418",
              borderRadius: 4,
              font: `600 12px/1.2 ${T.sans}`,
              cursor: "pointer",
            }}
          >
            {t("storage.evictionDismiss")}
          </button>
        </div>
      ) : null}
      {list.length === 0 ? (
        <div
          style={{
            font: `13px/1.5 ${T.bodySerif}`,
            color: T.dim,
            padding: "8px 0",
          }}
        >
          {t("storage.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {list.map((d) => (
            <StorageRow
              key={d.id}
              name={d.fileName}
              path={draftPath(d.id)}
              size={d.fileSize}
              editedRel={rel(d.lastTouched)}
              storageBytes={d.storageBytes}
              onDelete={() => onDelete(d.id)}
            />
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        {confirmingClearAll && list.length > 0 ? (
          <>
            <IconBtn tone="outline" onClick={() => setConfirmingClearAll(false)}>
              {t("storage.clearAllCancel")}
            </IconBtn>
            <IconBtn tone="primary" onClick={onClearAll}>
              {t("storage.clearAllConfirm", { count: list.length })}
            </IconBtn>
          </>
        ) : (
          <IconBtn
            tone="outline"
            onClick={() => setConfirmingClearAll(true)}
            disabled={list.length === 0}
          >
            {t("storage.clearAll")}
          </IconBtn>
        )}
      </div>
    </div>
  );
}

export function StorageRow({
  name,
  path,
  size,
  editedRel,
  storageBytes,
  onDelete,
}: {
  name: string;
  /** Same bytes at two paths keep two drafts under one name. */
  path?: string;
  size: number;
  editedRel: string;
  storageBytes: number;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 0",
        borderBottom: `1px dashed ${T.ruleSoft}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            font: `500 13px/1.3 ${T.sans}`,
            color: T.ink,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </div>
        {path ? (
          <div
            title={path}
            style={{
              font: `11.5px/1.4 ${T.mono}`,
              color: T.dim,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {path}
          </div>
        ) : null}
        <div
          style={{
            font: `11.5px/1.4 ${T.mono}`,
            color: T.dim,
            marginTop: 2,
            letterSpacing: ".02em",
          }}
        >
          {t("storage.lastEdited", { rel: editedRel })}
          {" · "}
          {formatBytes(size)}
          {" · "}
          {t("storage.uses", { size: formatBytes(storageBytes) })}
        </div>
      </div>
      <MiniIconBtn
        title={t("storage.deleteNamed", { name: path ?? name })}
        onClick={onDelete}
      >
        <Ic.trash />
      </MiniIconBtn>
    </div>
  );
}
