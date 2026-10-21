import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import {
  IconBtn,
  Modal,
  Radio,
  Section,
  type RadioOption,
} from "./ui";
import { ExportErrorNotice, LossyExportNotice } from "./ExportNotices";
import { ExportPagesSection } from "./ExportPagesSection";
import { useEditorStore } from "../store/store";
import type { ExportMode } from "../../pdf/export/exportPdf";
import { selectPagesForExport, type ExportRange } from "../../pdf/export/pageRanges";
import { hasNonAscii } from "../../pdf/export/textScripts";
import {
  openExportedFile,
  revealExportedFile,
  saveBytes,
} from "../export/exportPlatformAdapter";
import { toast } from "../toast";
import {
  buildDiagnosticReport,
  copyDiagnosticReport,
  diagnosticErrorMessage,
  type DiagnosticContext,
} from "../../runtime/diagnostics";
import { formatEditList } from "../permissionEdits";
import { exportSnapshotKey } from "../export/exportStatus";
import {
  exportBytesForQuality,
  loadExportPdfModule,
  type ExportPreviewRequest,
} from "./exportDialogBytes";
import { readExportPrefs, writeExportPrefs, type QualityV } from "./exportPrefs";
import {
  PREVIEW_DEBOUNCE_MS,
  deferredSizePreviews,
  generateSizePreview,
  qualityHint,
  selectSizePreview,
  unavailableSizePreviews,
  type ExportBytesCache,
  type SizePreviewState,
} from "./exportSizePreview";

type RangeV = ExportRange;

type Props = {
  open: boolean;
  onClose: () => void;
  onExportSaved?: (result: {
    path: string;
    platform: "desktop" | "web" | "mobile";
    completeDocument: boolean;
    snapshotKey: string;
  }) => void;
  // Open the exported file inside this instance (new tab). Shell-opening
  // would bounce through the OS default handler and launch a second app.
  onOpenExported?: (path: string) => void;
};

type ExportErrorState = {
  message: string;
  code: string;
  diagnosticReport: string;
};

type PendingLossyExport = {
  bytes: Uint8Array;
  lostChars: number;
  unexcisedEdits: number;
  completeDocument: boolean;
  snapshotKey: string;
  suggestedName: string;
  diagnosticContext: DiagnosticContext;
};


export function ExportDialog({
  open,
  onClose,
  onExportSaved,
  onOpenExported,
}: Props) {
  const { t, i18n } = useTranslation();
  const opened = useEditorStore((s) => s.opened);
  const model = useEditorStore((s) => s.model);
  const activePageId = useEditorStore((s) => s.activePageId);

  const [range, setRange] = useState<RangeV>("all");
  const [customRange, setCustomRange] = useState("1-4, 7");
  const [annotMode, setAnnotMode] = useState<ExportMode>(
    () => readExportPrefs().mode,
  );
  const [quality, setQuality] = useState<QualityV>(
    () => readExportPrefs().quality,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ExportErrorState | null>(null);
  const [pendingLossyExport, setPendingLossyExport] =
    useState<PendingLossyExport | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const copyResetTimerRef = useRef<number | null>(null);
  const previewCacheRef = useRef<ExportBytesCache | null>(null);
  const previewQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [sizePreviewState, setSizePreviewState] =
    useState<SizePreviewState>(() => ({
      request: null,
      previews: deferredSizePreviews(quality),
    }));

  // Persist the mode + quality whenever they change so the next export starts
  // where the last one left off.
  useEffect(() => {
    writeExportPrefs(annotMode, quality);
  }, [annotMode, quality]);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const showCopyState = (state: "copied" | "error") => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    setCopyState(state);
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyResetTimerRef.current = null;
    }, 1800);
  };

  const hasCjkText = model.overlays.some(
    (overlay) =>
      (overlay.type === "text" ||
        overlay.type === "contentText" ||
        overlay.type === "callout") &&
      hasNonAscii(overlay.text),
  );
  const pageCount = model.pages.length;
  const currentIdx =
    Math.max(0, model.pages.findIndex((p) => p.id === activePageId)) + 1;
  const documentFiles = range === "all" ? "preserve" : "omit";
  const pagesForExport = useMemo(
    () => selectPagesForExport(range, model.pages, currentIdx, customRange),
    [customRange, currentIdx, model.pages, range],
  );
  const exportModel = useMemo(
    () => ({ pages: pagesForExport, overlays: model.overlays }),
    [model.overlays, pagesForExport],
  );
  const unicodeFontErrorMessage = t("export.fontError");
  const previewRequest = useMemo<ExportPreviewRequest | null>(() => {
    if (!open || !opened || pagesForExport.length === 0) return null;
    return {
      doc: opened.doc,
      originalBytes: opened.bytes,
      password: opened.password,
      model: exportModel,
      mode: annotMode,
      documentFiles,
      unicodeFontErrorMessage,
    };
  }, [
    annotMode,
    exportModel,
    open,
    opened,
    pagesForExport.length,
    documentFiles,
    unicodeFontErrorMessage,
  ]);

  useEffect(() => {
    // A confirmation is tied to the exact bytes/options it previewed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingLossyExport(null);
  }, [previewRequest, quality]);

  useEffect(() => {
    if (!previewRequest) {
      previewCacheRef.current = null;
      return;
    }

    let cancelled = false;
    let cache = previewCacheRef.current;
    if (!cache || cache.request !== previewRequest) {
      cache = { request: previewRequest, results: {}, pending: {} };
      previewCacheRef.current = cache;
      setSizePreviewState({
        request: previewRequest,
        previews: deferredSizePreviews(quality),
      });
    } else {
      const cached = cache.results[quality];
      setSizePreviewState((current) => ({
        request: previewRequest,
        previews: selectSizePreview(
          current.request === previewRequest
            ? current.previews
            : deferredSizePreviews(quality),
          quality,
          cached,
        ),
      }));
      if (cached) return;
    }

    const timer = window.setTimeout(() => {
      const work = previewQueueRef.current.then(async () => {
        if (cancelled || previewCacheRef.current !== cache) return;
        await generateSizePreview(previewRequest, quality, cache, (preview) => {
          if (cancelled || previewCacheRef.current !== cache) return;
          setSizePreviewState((current) => ({
            request: previewRequest,
            previews: {
              ...(current.request === previewRequest
                ? current.previews
                : deferredSizePreviews(quality)),
              [quality]: preview,
            },
          }));
        });
      });
      previewQueueRef.current = work.then(
        () => undefined,
        () => undefined,
      );
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [previewRequest, quality]);

  if (!open || !opened) return null;

  const sizePreviews = !previewRequest
    ? unavailableSizePreviews()
    : sizePreviewState.request === previewRequest
      ? sizePreviewState.previews
      : deferredSizePreviews(quality);
  const annotOpts: RadioOption<ExportMode>[] = [
    {
      v: "annotations",
      label: t("export.annot.editable"),
      hint: t("export.annot.editableHint"),
    },
    {
      v: "flatten",
      label: t("export.annot.flatten"),
      hint: t("export.annot.flattenHint"),
    },
    {
      v: "none",
      label: t("export.annot.none"),
      hint: t("export.annot.noneHint"),
    },
  ];
  const qualityOpts: RadioOption<QualityV>[] = [
    {
      v: "original",
      label: t("export.quality.original"),
      hint: qualityHint(t, "original", sizePreviews.original),
    },
    {
      v: "standard",
      label: t("export.quality.standard"),
      hint: qualityHint(t, "standard", sizePreviews.standard),
    },
    {
      v: "compact",
      label: t("export.quality.compact"),
      hint: qualityHint(t, "compact", sizePreviews.compact),
    },
  ];
  const reportExportError = async (
    err: unknown,
    diagnosticContext: DiagnosticContext,
  ) => {
    console.error(err);
    const rawMessage = diagnosticErrorMessage(err);
    const {
      ExportEncryptedSourceError,
      ExportEncryptionUnsupportedError,
      ExportEncryptionVerifyError,
      ExportIntegrityError,
      ExportPermissionError,
      ExportSignedSourceError,
    } = await loadExportPdfModule();
    const known: [boolean, () => string, string][] = [
      [
        err instanceof ExportSignedSourceError,
        () => t("export.signedSourceError"),
        "ERR_EXPORT_SIGNED_SOURCE",
      ],
      [
        err instanceof ExportPermissionError,
        () =>
          t("export.permissionError", {
            edits: formatEditList(
              (err as InstanceType<typeof ExportPermissionError>).denied,
              t,
              i18n.language,
            ),
          }),
        "ERR_EXPORT_PERMISSION",
      ],
      [
        err instanceof ExportEncryptionUnsupportedError,
        () => t("export.encryptionUnsupportedError"),
        "ERR_EXPORT_ENCRYPTION_UNSUPPORTED",
      ],
      [
        err instanceof ExportEncryptionVerifyError,
        () => t("export.encryptionVerifyError"),
        "ERR_EXPORT_ENCRYPTION_VERIFY",
      ],
      [
        err instanceof ExportEncryptedSourceError,
        () => t("export.encryptedSourceError"),
        "ERR_EXPORT_ENCRYPTED_SOURCE",
      ],
      [
        err instanceof ExportIntegrityError,
        () => t("export.integrityError"),
        "ERR_EXPORT_CORRUPT_OUTPUT",
      ],
    ];
    const match = known.find(([matches]) => matches);
    const message = match ? match[1]() : rawMessage;
    const code = match ? match[2] : exportDiagnosticCode(rawMessage, t);
    setError({
      message,
      code,
      diagnosticReport: buildDiagnosticReport({
        area: "export_pdf",
        code,
        message: rawMessage,
        detail: err instanceof Error ? err.stack ?? null : null,
        context: diagnosticContext,
      }),
    });
  };

  const savePreparedExport = async (prepared: PendingLossyExport) => {
    const result = await saveBytes(prepared.bytes, {
      suggestedName: prepared.suggestedName,
      mime: "application/pdf",
    });
    if (result.status === "saved") {
      console.info("Export saved:", result.platform, result.path);
      onExportSaved?.({
        path: result.path,
        platform: result.platform,
        completeDocument: prepared.completeDocument,
        snapshotKey: prepared.snapshotKey,
      });
      toast.showSaved(
        result.platform,
        result.path,
        result.platform === "desktop"
          ? [
              {
                label: t("toast.openSavedFile"),
                onClick: () => {
                  if (onOpenExported) {
                    onOpenExported(result.path);
                    return;
                  }
                  void openExportedFile(result.path).catch((err) => {
                    toast.error(
                      t("toast.openSavedFileFailed"),
                      (err as Error).message,
                    );
                  });
                },
              },
              {
                label: t("toast.revealSavedFile"),
                onClick: () => {
                  void revealExportedFile(result.path).catch((err) => {
                    toast.error(
                      t("toast.revealSavedFileFailed"),
                      (err as Error).message,
                    );
                  });
                },
              },
            ]
          : undefined,
      );
      onClose();
      return;
    }
    // User cancelled the native dialog. Stay open so they can try again.
    console.info("Export cancelled by user");
  };

  const onExport = async () => {
    if (!opened) return;
    setBusy(true);
    setError(null);
    setPendingLossyExport(null);
    setCopyState("idle");
    let diagnosticContext: DiagnosticContext = {
      pageCount,
      overlayCount: model.overlays.length,
      fileSizeBytes: opened.fileSize,
      range,
      customRange: range === "range" ? customRange : null,
      mode: annotMode,
      quality,
      hasCjkText,
    };
    try {
      const selectedPages = selectPagesForExport(
        range,
        model.pages,
        currentIdx,
        customRange,
      );
      diagnosticContext = {
        ...diagnosticContext,
        selectedPages: selectedPages.length,
      };
      if (selectedPages.length === 0) {
        throw new Error(t("export.emptyError"));
      }
      const completeDocument =
        range === "all" &&
        selectedPages.length === model.pages.length &&
        annotMode !== "none";
      const cached =
        previewCacheRef.current?.request === previewRequest
          ? previewCacheRef.current.results[quality]
          : undefined;
      const pending =
        previewCacheRef.current?.request === previewRequest
          ? previewCacheRef.current.pending[quality]
          : undefined;
      const exportResult =
        cached ??
        (pending
          ? await pending
          : await exportBytesForQuality({
              doc: opened.doc,
              originalBytes: opened.bytes,
              password: opened.password,
              model: exportModel,
              mode: annotMode,
              documentFiles,
              quality,
              unicodeFontErrorMessage,
            }));
      const stem = opened.fileName.replace(/\.pdf$/i, "");
      const prepared: PendingLossyExport = {
        bytes: exportResult.bytes,
        lostChars: exportResult.lostChars,
        unexcisedEdits: exportResult.unexcisedEdits ?? 0,
        completeDocument,
        snapshotKey: exportSnapshotKey(exportModel),
        suggestedName: `${stem}-edited.pdf`,
        diagnosticContext,
      };
      if (prepared.lostChars > 0 || prepared.unexcisedEdits > 0) {
        setPendingLossyExport(prepared);
        return;
      }
      await savePreparedExport(prepared);
    } catch (err) {
      await reportExportError(err, diagnosticContext);
    } finally {
      setBusy(false);
    }
  };

  const onConfirmLossyExport = async () => {
    const pending = pendingLossyExport;
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await savePreparedExport(pending);
    } catch (err) {
      await reportExportError(err, pending.diagnosticContext);
    } finally {
      setBusy(false);
    }
  };

  const onCopyDiagnostic = async () => {
    if (!error) return;
    try {
      await copyDiagnosticReport(error.diagnosticReport);
      showCopyState("copied");
    } catch {
      showCopyState("error");
    }
  };

  return (
    <Modal
      // closeDisabled greys the X and disarms Escape and the backdrop. Without
      // it all three looked fully interactive during a long export but silently
      // did nothing, while the footer's Cancel/Export were correctly greyed —
      // so the dialog read as frozen rather than busy. The onClose wrapper
      // stays as a second guard (same shape as UpdateModal).
      closeDisabled={busy}
      onClose={busy ? () => undefined : onClose}
      title={t("export.title")}
      subtitle={opened.fileName}
    >
      <ExportPagesSection
        range={range}
        onRangeChange={setRange}
        customRange={customRange}
        onCustomRangeChange={setCustomRange}
        pageCount={pageCount}
        currentPage={currentIdx}
      />

      <Section label={t("export.sections.annotations")}>
        <Radio
          label={t("export.sections.annotations")}
          options={annotOpts}
          value={annotMode}
          onChange={setAnnotMode}
        />
        {annotMode === "annotations" && hasCjkText ? (
          <div
            style={{
              marginTop: 8,
              color: T.dim,
              font: `12.5px/1.45 ${T.sans}`,
            }}
          >
            {t("export.cjkAnnotationsHint")}
          </div>
        ) : null}
      </Section>
      <Section label={t("export.sections.quality")}>
        <Radio
          label={t("export.sections.quality")}
          options={qualityOpts}
          value={quality}
          onChange={setQuality}
        />
        {quality === "compact" ? (
          <div
            style={{
              marginTop: 8,
              font: `12.5px/1.5 ${T.sans}`,
              color: T.dim,
            }}
          >
            {t("export.quality.notice")}
          </div>
        ) : null}
      </Section>

      {pendingLossyExport ? (
        <LossyExportNotice
          lostChars={pendingLossyExport.lostChars}
          unexcisedEdits={pendingLossyExport.unexcisedEdits}
        />
      ) : null}

      {error ? (
        <ExportErrorNotice
          message={error.message}
          code={error.code}
          copyState={copyState}
          onCopy={onCopyDiagnostic}
        />
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            flex: "1 1 180px",
            minWidth: 0,
            font: `12.5px/1.5 ${T.sans}`,
            color: T.dim,
          }}
        >
          {t("export.footer")}
        </div>
        {pendingLossyExport ? (
          <>
            <IconBtn
              onClick={() => setPendingLossyExport(null)}
              tone="outline"
              disabled={busy}
            >
              {t("export.lostCharsConfirmCancel")}
            </IconBtn>
            <IconBtn
              tone="primary"
              onClick={onConfirmLossyExport}
              disabled={busy}
            >
              <Ic.download />
              <span>
                {busy
                  ? t("export.busy")
                  : pendingLossyExport.unexcisedEdits > 0
                    ? t("export.unexcisedConfirmAction")
                    : t("export.lostCharsConfirmAction")}
              </span>
            </IconBtn>
          </>
        ) : (
          <>
            <IconBtn onClick={onClose} tone="outline" disabled={busy}>
              {t("export.cancel")}
            </IconBtn>
            <IconBtn tone="primary" onClick={onExport} disabled={busy}>
              <Ic.download />
              <span>{busy ? t("export.busy") : t("export.action")}</span>
            </IconBtn>
          </>
        )}
      </div>
    </Modal>
  );
}

function exportDiagnosticCode(
  message: string,
  t: (key: string) => string,
): string {
  if (message === t("export.emptyError")) return "ERR_EXPORT_EMPTY_RANGE";
  if (message === t("export.fontError")) return "ERR_EXPORT_FONT_LOAD_FAILED";
  return "ERR_EXPORT_FAILED";
}
