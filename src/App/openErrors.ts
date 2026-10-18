import { isPlatformPdfOpenError } from "../platform";
import { toast } from "../editor/toast";
import { formatBytes } from "../shared/format";
import {
  classifyPdfOpenError,
  diagnosticCode,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
} from "../pdf/openPolicy";
import { buildDiagnosticReport } from "../runtime/diagnostics";
import type { ErrorInfo } from "../editor/store/store";
import {
  DocumentOpenPolicyError,
  maxDocumentBytes,
} from "../documents/openPolicy";
import type { DocumentKind } from "../documents/types";
import { isWebFileHandleOpenError } from "../storage/recentFileHandles";

/**
 * Shared document-open error surfacing, extracted from App.tsx as a
 * prerequisite for the useDocumentIntake hook.
 * Both the platform-intake listeners and App's tab-reselect / recent-reopen
 * flows call these, so they live in a standalone module rather than inside
 * either consumer.
 */
export function unsupportedDocumentDetail(
  fileName: string | undefined,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const message = t("error.unsupportedDocument.message");
  return fileName ? `${fileName} · ${message}` : message;
}

export function showPlatformOpenError(
  err: unknown,
  fileName: string | undefined,
  t: (key: string, vars?: Record<string, unknown>) => string,
  fallbackDetail?: string,
): void {
  if (err instanceof DocumentOpenPolicyError) {
    showDocumentOpenPolicyError(
      err,
      fileName ?? err.documentKind.toUpperCase(),
      err.documentKind,
      t,
    );
    return;
  }
  if (isPlatformPdfOpenError(err)) {
    if (err.code === "tooLarge") {
      toast.error(
        t("error.tooLarge.title"),
        `${fileName ?? "PDF"} · ${t("error.tooLarge.message", {
          maxSize: formatBytes(MAX_PDF_BYTES),
        })}`,
      );
      return;
    }
    if (err.code === "notPdf" || err.code === "unsupported") {
      toast.error(
        t("error.unsupportedDocument.title"),
        unsupportedDocumentDetail(fileName, t),
      );
      return;
    }
    // The desktop shell's code for a file or folder that no longer exists.
    if (err.message === "document-path-unavailable") {
      toast.error(t("toast.recentMissing"), fileName ?? fallbackDetail);
      return;
    }
  }
  if (isWebFileHandleOpenError(err) && err.code === "notPdf") {
    toast.error(
      t("error.unsupportedDocument.title"),
      unsupportedDocumentDetail(fileName, t),
    );
    return;
  }
  toast.error(
    t("toast.openPermissionDenied"),
    (err as Error).message || fallbackDetail,
  );
}

export function showDocumentOpenPolicyError(
  err: unknown,
  fileName: string,
  kind: Exclude<DocumentKind, "pdf">,
  t: (key: string, vars?: Record<string, unknown>) => string,
): boolean {
  if (!(err instanceof DocumentOpenPolicyError)) return false;
  const maxSize = maxDocumentBytes(kind);
  toast.error(
    t(`documents.openPolicy.${err.kind}.title`),
    t(`documents.openPolicy.${err.kind}.message`, {
      name: fileName,
      maxSize: maxSize === null ? "" : formatBytes(maxSize),
    }),
  );
  return true;
}

export function buildOpenErrorInfo(
  file: string,
  fileSize: number,
  err: unknown,
  t: (key: string, vars?: Record<string, unknown>) => string,
  maxSize: string,
  maxPages: number,
): ErrorInfo {
  const kind = classifyPdfOpenError(err);
  const detail = (err as Error).message || "unknown";
  const code = diagnosticCode(kind);
  const message = t(`error.${kind}.message`, { maxSize, maxPages });
  return {
    title: t(`error.${kind}.title`),
    file,
    message,
    code,
    diagnosticReport: buildDiagnosticReport({
      area: "open_pdf",
      code,
      message,
      detail,
      context: {
        fileSizeBytes: fileSize,
        maxPdfBytes: MAX_PDF_BYTES,
        maxPdfPages: MAX_PDF_PAGES,
        maxPageDimensionPt: 14400,
      },
    }),
  };
}
