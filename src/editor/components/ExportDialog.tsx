import { ContentTextOutcomes } from "./ContentTextOutcomes";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { exportModelForPages } from "../export/exportModel";
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
import { ExportErrorNotice, ExportReviewNotice } from "./ExportNotices";
import { ExportPagesSection } from "./ExportPagesSection";
import { useEditorStore, useEditorStoreApi, type OpenedPdf } from "../store/store";
import type { DocumentModel } from "../../pdf/model/types";
import type { ExportMode, ExportResult } from "../../pdf/export/exportPdf";
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
  exportDialogCandidateKey,
  loadExportPdfModule,
  type ExportPreviewRequest,
} from "./exportDialogBytes";
import { readExportPrefs, writeExportPrefs, type QualityV } from "./exportPrefs";
import { getExportCandidate, qualityHint } from "./exportSizePreview";
import { useExportSizePreview } from "./useExportSizePreview";

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

type PreparedExport = {
  candidate: ExportResult;
  completeDocument: boolean;
  snapshotKey: string;
  suggestedName: string;
};

type CurrentExport = {
  request: ExportPreviewRequest | null;
  diagnosticContext: DiagnosticContext;
  completeDocument: boolean;
  suggestedName: string;
  quality: QualityV;
  save: (prepared: PreparedExport) => Promise<void>;
};

function hasNonAsciiText(model: DocumentModel): boolean {
  return model.overlays.some(
    (overlay) =>
      (overlay.type === "text" ||
        overlay.type === "contentText" ||
        overlay.type === "callout") &&
      hasNonAscii(overlay.text),
  );
}

function pageNumber(model: DocumentModel, activePageId: string | null): number {
  return Math.max(0, model.pages.findIndex((page) => page.id === activePageId)) + 1;
}

function makePreviewRequest(
  opened: OpenedPdf,
  model: DocumentModel,
  mode: ExportMode,
  documentFiles: ExportPreviewRequest["documentFiles"],
  unicodeFontErrorMessage: string,
): ExportPreviewRequest | null {
  if (!model.pages.length) return null;
  return {
    doc: opened.doc,
    originalBytes: opened.bytes,
    password: opened.password,
    model,
    mode,
    documentFiles,
    unicodeFontErrorMessage,
  };
}

export function ExportDialog({
  open,
  onClose,
  onExportSaved,
  onOpenExported,
}: Props) {
  const { t, i18n } = useTranslation();
  const editorStore = useEditorStoreApi();
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
  const [reviewedExport, setReviewedExport] = useState<PreparedExport | null>(null);
  const currentExportRef = useRef<(() => CurrentExport | null) | null>(null);
  const exportingRef = useRef(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const copyResetTimerRef = useRef<number | null>(null);

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

  const hasCjkText = hasNonAsciiText(model);
  const pageCount = model.pages.length;
  const currentIdx = pageNumber(model, activePageId);
  const documentFiles = range === "all" ? "preserve" : "omit";
  const pagesForExport = useMemo(
    () => selectPagesForExport(range, model.pages, currentIdx, customRange),
    [customRange, currentIdx, model.pages, range],
  );
  const exportModel = useMemo(
    () => exportModelForPages(model, pagesForExport),
    [model, pagesForExport],
  );
  const unicodeFontErrorMessage = t("export.fontError");
  const previewRequest = useMemo(
    () => open && opened
      ? makePreviewRequest(opened, exportModel, annotMode, documentFiles, unicodeFontErrorMessage)
      : null,
    [annotMode, documentFiles, exportModel, open, opened, unicodeFontErrorMessage],
  );
  const { previews: sizePreviews, cacheRef: previewCacheRef } = useExportSizePreview(previewRequest, quality);
  const review = useMemo(() => {
    if (!reviewedExport || !previewRequest) return null;
    const key = exportDialogCandidateKey({ ...previewRequest, quality });
    return reviewedExport.candidate.acceptance.key === key ? reviewedExport : null;
  }, [previewRequest, quality, reviewedExport]);

  useEffect(() => {
    if (reviewedExport && !review) {
      // A review belongs to the request that produced the displayed findings.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReviewedExport((current) => current === reviewedExport ? null : current);
    }
  }, [review, reviewedExport]);

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

  const savePreparedExport = async (prepared: PreparedExport) => {
    const result = await saveBytes(prepared.candidate.bytes, {
      suggestedName: prepared.suggestedName,
      mime: "application/pdf",
    });
    if (result.status === "saved") {
      setReviewedExport(null);
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

  useLayoutEffect(() => {
    currentExportRef.current = () => {
      // Store edits can land before React commits the corresponding render.
      const live = editorStore.getState();
      if (!open || !live.opened) return null;
      const sameSelection = live.opened === opened && live.model === model && live.activePageId === activePageId;
      const selectedPages = sameSelection ? pagesForExport : selectPagesForExport(
        range, live.model.pages, pageNumber(live.model, live.activePageId), customRange,
      );
      const request = sameSelection ? previewRequest : makePreviewRequest(
        live.opened, { pages: selectedPages, overlays: live.model.overlays },
        annotMode, documentFiles, unicodeFontErrorMessage,
      );
      return {
        request,
        quality,
        completeDocument: range === "all" && selectedPages.length === live.model.pages.length && annotMode !== "none",
        suggestedName: `${live.opened.fileName.replace(/\.pdf$/i, "")}-edited.pdf`,
        diagnosticContext: {
          pageCount: live.model.pages.length,
          overlayCount: live.model.overlays.length,
          selectedPages: selectedPages.length,
          fileSizeBytes: live.opened.fileSize,
          range,
          customRange: range === "range" ? customRange : null,
          mode: annotMode,
          quality,
          hasCjkText: sameSelection ? hasCjkText : hasNonAsciiText(live.model),
        },
        save: savePreparedExport,
      };
    };
    return () => {
      currentExportRef.current = null;
    };
  });

  const onExport = async (approved?: PreparedExport) => {
    if (exportingRef.current) return;
    let current = currentExportRef.current?.();
    if (!current) return;
    exportingRef.current = true;
    setBusy(true);
    setError(null);
    setCopyState("idle");
    let diagnosticContext = current.diagnosticContext;
    try {
      while (current) {
        diagnosticContext = current.diagnosticContext;
        const { request, quality } = current;
        if (!request) throw new Error(t("export.emptyError"));
        const key = exportDialogCandidateKey({ ...request, quality });
        if (approved?.candidate.acceptance.key === key) {
          await current.save(approved);
          return;
        }

        approved = undefined;
        setReviewedExport(null);
        const result = await getExportCandidate(request, quality, key, previewCacheRef.current).then(
          (candidate) => ({ candidate }),
          (error: unknown) => ({ error }),
        );
        current = currentExportRef.current?.();
        if (!current) return;
        // A cache hit and an in-flight export both cross an async boundary.
        // Restart with the latest request if anything affecting the bytes changed.
        const evaluatedKey = "candidate" in result ? result.candidate.acceptance.key : key;
        if (!current.request || exportDialogCandidateKey({ ...current.request, quality: current.quality }) !== evaluatedKey) {
          continue;
        }
        diagnosticContext = current.diagnosticContext;
        if ("error" in result) throw result.error;
        const { candidate } = result;
        const prepared: PreparedExport = {
          candidate,
          completeDocument: current.completeDocument,
          snapshotKey: exportSnapshotKey(request.model),
          suggestedName: current.suggestedName,
        };
        if (candidate.acceptance.status !== "accepted") {
          setReviewedExport(prepared);
          return;
        }
        await current.save(prepared);
        return;
      }
    } catch (err) {
      await reportExportError(err, diagnosticContext);
    } finally {
      exportingRef.current = false;
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

  if (!open || !opened) return null;

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

      <ContentTextOutcomes outcomes={sizePreviews[quality].outcomes} />
      {review && <ExportReviewNotice findings={review.candidate.acceptance.findings} />}

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
        {review ? (
          <>
            <IconBtn
              onClick={() => setReviewedExport(null)}
              tone="outline"
              disabled={busy}
            >
              {t("export.lostCharsConfirmCancel")}
            </IconBtn>
            <IconBtn
              tone="primary"
              onClick={() => void onExport(review)}
              disabled={busy}
            >
              <Ic.download />
              <span>
                {busy
                  ? t("export.busy")
                  : review.candidate.acceptance.findings.every(({ kind }) => kind === "lost-text")
                    ? t("export.lostCharsConfirmAction")
                    : t("export.unexcisedConfirmAction")}
              </span>
            </IconBtn>
          </>
        ) : (
          <>
            <IconBtn onClick={onClose} tone="outline" disabled={busy}>
              {t("export.cancel")}
            </IconBtn>
            <IconBtn tone="primary" onClick={() => void onExport()} disabled={busy}>
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
