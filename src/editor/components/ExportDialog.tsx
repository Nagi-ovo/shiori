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
import { useEditorStore } from "../store/store";
import type {
  DocumentFilesPolicy,
  ExportMode,
  ExportQuality,
  ExportResult,
} from "../../pdf/export/exportPdf";
import { selectPagesForExport, type ExportRange } from "../../pdf/export/pageRanges";
import {
  cjkJpExportFontUrl,
  cjkScExportFontUrl,
} from "../../pdf/export/fontAssets";
import { hasNonAscii } from "../../pdf/export/textScripts";
import type { PdfDocument } from "../../pdf/engine/types";
import {
  openExportedFile,
  revealExportedFile,
  saveBytes,
} from "../export/exportPlatformAdapter";
import { toast } from "../toast";
import { formatBytes } from "../../shared/format";
import {
  buildDiagnosticReport,
  copyDiagnosticReport,
  diagnosticErrorMessage,
  type DiagnosticContext,
} from "../../runtime/diagnostics";
import { exportCompactRasterPdf } from "../export/compactRasterPdfAdapter";
import type { ExportSourceEncryption } from "../../pdf/export/encryptedSource";
import { deniedEdits } from "../../pdf/security/permissions";
import { formatEditList } from "../permissionEdits";
import {
  cachePreviewResult,
  type PreviewResultCache,
} from "../export/exportPreviewCache";
import { exportSnapshotKey } from "../export/exportStatus";

type RangeV = ExportRange;
type QualityV = ExportQuality;
type ExportPdfModule = typeof import("../../pdf/export/exportPdf");
type ExportPdfFunction = ExportPdfModule["exportPdf"];

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
  completeDocument: boolean;
  snapshotKey: string;
  suggestedName: string;
  diagnosticContext: DiagnosticContext;
};

type SizePreview = {
  status: "deferred" | "calculating" | "ready" | "unavailable";
  size?: number;
};

type SizePreviewMap = Record<QualityV, SizePreview>;

type SizePreviewState = {
  request: ExportPreviewRequest | null;
  previews: SizePreviewMap;
};

type ExportPreviewRequest = {
  doc: PdfDocument;
  originalBytes: Uint8Array;
  // In memory only, like `opened.password`: it opens the source again to
  // re-encrypt the export (src/pdf/export/encryptedSource.ts).
  password: string | undefined;
  model: Parameters<ExportPdfFunction>[1];
  mode: ExportMode;
  documentFiles: Exclude<DocumentFilesPolicy, "auto">;
  unicodeFontErrorMessage: string;
};

type ExportBytesCache = {
  request: ExportPreviewRequest;
  results: PreviewResultCache;
  pending: Partial<Record<QualityV, Promise<ExportResult>>>;
};

const PREVIEW_DEBOUNCE_MS = 220;

// Remember the annotation mode + quality across exports (WCAG 2.2 SC 3.3.7,
// redundant entry). The page range is intentionally NOT persisted — it is
// document-specific. Stored as one small JSON blob, validated on read so a
// stale/garbage value can never wedge the dialog.
const EXPORT_PREFS_KEY = "shiori:exportPrefs:v1";
const EXPORT_MODES: readonly ExportMode[] = ["annotations", "flatten", "none"];
const EXPORT_QUALITIES: readonly QualityV[] = [
  "original",
  "standard",
  "compact",
];
const DEFAULT_EXPORT_PREFS: { mode: ExportMode; quality: QualityV } = {
  mode: "annotations",
  quality: "original",
};

function readExportPrefs(): { mode: ExportMode; quality: QualityV } {
  try {
    const raw = localStorage.getItem(EXPORT_PREFS_KEY);
    if (!raw) return DEFAULT_EXPORT_PREFS;
    const parsed = JSON.parse(raw) as { mode?: unknown; quality?: unknown };
    return {
      mode: EXPORT_MODES.includes(parsed.mode as ExportMode)
        ? (parsed.mode as ExportMode)
        : DEFAULT_EXPORT_PREFS.mode,
      quality: EXPORT_QUALITIES.includes(parsed.quality as QualityV)
        ? (parsed.quality as QualityV)
        : DEFAULT_EXPORT_PREFS.quality,
    };
  } catch {
    return DEFAULT_EXPORT_PREFS;
  }
}

function writeExportPrefs(mode: ExportMode, quality: QualityV): void {
  try {
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify({ mode, quality }));
  } catch {
    // Private mode / quota — remembering preferences is best-effort.
  }
}

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
  const rangeOpts: RadioOption<RangeV>[] = [
    {
      v: "all",
      label: t("export.range.all"),
      hint: t("export.range.allHint", { count: pageCount }),
    },
    {
      v: "current",
      label: t("export.range.current"),
      hint: t("export.range.currentHint", { page: currentIdx }),
    },
    {
      v: "range",
      label: t("export.range.custom"),
      hint: customRange,
    },
  ];
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
        completeDocument,
        snapshotKey: exportSnapshotKey(exportModel),
        suggestedName: `${stem}-edited.pdf`,
        diagnosticContext,
      };
      if (prepared.lostChars > 0) {
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
      <Section label={t("export.sections.pages")}>
        <Radio
          label={t("export.sections.pages")}
          options={rangeOpts}
          value={range}
          onChange={setRange}
        />
        {range === "range" ? (
          <input
            type="text"
            value={customRange}
            onChange={(e) => setCustomRange(e.target.value)}
            placeholder={t("export.range.customPlaceholder")}
            style={{
              marginTop: 8,
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 12px",
              borderRadius: 4,
              border: `1px solid ${T.rule}`,
              background: T.surface,
              font: `500 13px/1 ${T.mono}`,
              color: T.ink,
            }}
          />
        ) : null}
        {range !== "all" ? (
          <div
            style={{
              marginTop: 8,
              color: T.dim,
              font: `12.5px/1.45 ${T.sans}`,
            }}
          >
            {t("export.range.attachmentsOmitted")}
          </div>
        ) : null}
      </Section>

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
        <div
          role="alert"
          style={{
            padding: "11px 12px",
            borderRadius: 4,
            background: "#fff2cf",
            border: `1px solid #d9b65f`,
            color: T.ink,
            font: `13px/1.45 ${T.sans}`,
            marginBottom: 10,
          }}
        >
          <strong>{t("export.lostCharsConfirmTitle")}</strong>
          <div style={{ marginTop: 4 }}>
            {t("export.lostCharsConfirmBody", {
              count: pendingLossyExport.lostChars,
            })}
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 4,
            background: "#f7e2de",
            border: `1px solid #e0b5ab`,
            color: "#7a2418",
            font: `13px/1.4 ${T.sans}`,
            marginBottom: 10,
          }}
        >
          <div>{error.message}</div>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <code
              style={{
                font: `500 11px/1 ${T.mono}`,
                color: "#7a2418",
                letterSpacing: ".04em",
              }}
            >
              {t("diagnostics.code", { code: error.code })}
            </code>
            <button
              type="button"
              onClick={onCopyDiagnostic}
              style={{
                appearance: "none",
                border: "1px solid #c78378",
                borderRadius: 4,
                background: "#fff7f4",
                color: "#7a2418",
                padding: "4px 8px",
                font: `600 11.5px/1 ${T.sans}`,
                cursor: "pointer",
              }}
            >
              {copyState === "copied"
                ? t("diagnostics.copied")
                : copyState === "error"
                  ? t("diagnostics.copyFailed")
                  : t("diagnostics.copy")}
            </button>
          </div>
        </div>
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

async function exportCompactPdf(
  doc: PdfDocument,
  originalBytes: Uint8Array,
  model: Parameters<ExportPdfFunction>[1],
  options: Parameters<ExportPdfFunction>[2] & { mode: ExportMode },
): Promise<ExportResult> {
  const {
    assertExportIntegrity,
    exportPdf,
    preserveDocumentFilesInPdf,
    refuseUnhandledEncryption,
  } = await loadExportPdfModule();
  const encryption = options.sourceEncryption;
  // A raster is drawn from the decrypted pages; without the source's
  // handler it would leave in the clear, so an encrypted source stops here.
  if (!encryption) await refuseUnhandledEncryption(originalBytes);
  // An encrypted source's vector export leaves exportPdf encrypted; the
  // plaintext it encrypted is what the raster copies attachments from.
  let vectorPlain: Uint8Array | null = null;
  const capturing: ExportSourceEncryption | undefined = encryption && {
    ...encryption,
    encrypt: (plain, pageCount) => {
      vectorPlain = plain;
      return encryption.encrypt(plain, pageCount);
    },
  };
  // Carry the vector path's full result: when compact falls back to the
  // standard bytes, its lostChars must reach the caller's warning toast —
  // dropping them silently exported "?" glyphs with no notice.
  const vector = await exportPdf(originalBytes, model, {
    ...options,
    sourceEncryption: capturing,
    quality: "standard",
  });
  // A raster copy replaces every page's content and its annotations.
  if (
    encryption &&
    deniedEdits(encryption.security, ["content", "annotations"]).length > 0
  ) {
    return vector;
  }
  let rasterBytes: Uint8Array;
  try {
    rasterBytes = await exportCompactRasterPdf(doc, model, {
      mode: options.mode,
    });
  } catch (err) {
    console.warn("Compact raster export failed; using standard PDF.", err);
    return vector;
  }
  // Attachment preservation is a data-integrity boundary, not a quality
  // optimization. Keep it outside the raster fallback: if raw copying or its
  // round-trip check fails, the export must fail loudly instead of silently
  // changing the user's selected result.
  if (options.documentFiles === "preserve") {
    // The validated vector result already reflects logical page deletion and
    // annotation mode. Using the untouched source here would resurrect files
    // owned only by pages the user removed from the document.
    // An unchanged encrypted vector is the source itself, so its plaintext
    // carries exactly the source's files.
    const filesSource = encryption
      ? (vectorPlain ?? (await encryption.plaintext()))
      : vector.bytes;
    rasterBytes = await preserveDocumentFilesInPdf(filesSource, rasterBytes);
  }
  // Both sides compared as they would be saved: encryption adds a little.
  if (rasterBytes.byteLength >= vector.bytes.byteLength) return vector;
  try {
    // The raster path builds its own PDF outside exportPdf(), so it never ran
    // the round-trip guard. Validate it here and fall back to the (already
    // validated) vector bytes if the raster output doesn't hold up.
    await assertExportIntegrity(rasterBytes, model.pages.length);
    // Rasterized pages carry text as pixels — nothing is lost to font
    // fallback on this path. An encrypted source's raster leaves encrypted
    // like the source, or not at all.
    const bytes = encryption
      ? await encryption.encrypt(rasterBytes, model.pages.length)
      : rasterBytes;
    return { bytes, lostChars: 0 };
  } catch (err) {
    console.warn("Compact raster integrity check failed; using standard PDF.", err);
    return vector;
  }
}

async function generateSizePreview(
  request: ExportPreviewRequest,
  quality: QualityV,
  cache: ExportBytesCache,
  publish: (preview: SizePreview) => void,
): Promise<void> {
  const existing = cache.pending[quality];
  const pending = existing ?? exportBytesForQuality({ ...request, quality });
  cache.pending[quality] = pending;
  try {
    const result = await pending;
    cachePreviewResult(cache.results, quality, result);
    publish({ status: "ready", size: result.bytes.byteLength });
  } catch (err) {
    console.warn(`Unable to calculate ${quality} export size.`, err);
    publish({ status: "unavailable" });
  } finally {
    if (cache.pending[quality] === pending) delete cache.pending[quality];
  }
}

async function exportBytesForQuality({
  doc,
  originalBytes,
  password,
  model,
  mode,
  documentFiles,
  quality,
  unicodeFontErrorMessage,
}: ExportPreviewRequest & { quality: QualityV }): Promise<ExportResult> {
  return withExportEncryption(
    { doc, bytes: originalBytes, password },
    async (sourceEncryption) => {
      const options = {
        ...exportOptions(mode, documentFiles, unicodeFontErrorMessage),
        sourceEncryption,
      };
      if (quality === "compact") {
        return exportCompactPdf(doc, originalBytes, model, options);
      }
      const { exportPdf } = await loadExportPdfModule();
      return exportPdf(originalBytes, model, { ...options, quality });
    },
  );
}

function exportOptions(
  mode: ExportMode,
  documentFiles: Exclude<DocumentFilesPolicy, "auto">,
  unicodeFontErrorMessage: string,
): Parameters<ExportPdfFunction>[2] & { mode: ExportMode } {
  return {
    mode,
    documentFiles,
    unicodeFontUrl: cjkScExportFontUrl,
    unicodeJpFontUrl: cjkJpExportFontUrl,
    requireUnicodeFont: true,
    unicodeFontErrorMessage,
  };
}

function loadExportPdfModule(): Promise<ExportPdfModule> {
  return import("../export/exportPdfAdapter").then((adapter) =>
    adapter.loadExportPdfModule(),
  );
}

function withExportEncryption<T>(
  ...args: Parameters<
    typeof import("../export/exportPdfAdapter").withExportEncryption<T>
  >
): Promise<T> {
  return import("../export/exportPdfAdapter").then((adapter) =>
    adapter.withExportEncryption(...args),
  );
}

function deferredSizePreviews(selectedQuality: QualityV): SizePreviewMap {
  return {
    original: {
      status: selectedQuality === "original" ? "calculating" : "deferred",
    },
    standard: {
      status: selectedQuality === "standard" ? "calculating" : "deferred",
    },
    compact: {
      status: selectedQuality === "compact" ? "calculating" : "deferred",
    },
  };
}

function selectSizePreview(
  current: SizePreviewMap,
  selectedQuality: QualityV,
  cached: ExportResult | undefined,
): SizePreviewMap {
  const next = { ...current };
  for (const quality of EXPORT_QUALITIES) {
    if (quality !== selectedQuality && next[quality].status === "calculating") {
      next[quality] = { status: "deferred" };
    }
  }
  next[selectedQuality] = cached
    ? { status: "ready", size: cached.bytes.byteLength }
    : { status: "calculating" };
  return next;
}

function unavailableSizePreviews(): SizePreviewMap {
  return {
    original: { status: "unavailable" },
    standard: { status: "unavailable" },
    compact: { status: "unavailable" },
  };
}

function qualityHint(
  t: (key: string, values?: Record<string, unknown>) => string,
  quality: QualityV,
  preview: SizePreview,
): string {
  if (preview.status === "ready" && preview.size != null) {
    return t(`export.quality.${quality}Hint`, {
      size: formatBytes(preview.size),
    });
  }
  if (preview.status === "unavailable") return t("export.quality.sizeUnavailable");
  if (preview.status === "deferred") return t("export.quality.sizeOnSelect");
  return t("export.quality.sizeCalculating");
}

function exportDiagnosticCode(
  message: string,
  t: (key: string) => string,
): string {
  if (message === t("export.emptyError")) return "ERR_EXPORT_EMPTY_RANGE";
  if (message === t("export.fontError")) return "ERR_EXPORT_FONT_LOAD_FAILED";
  return "ERR_EXPORT_FAILED";
}
