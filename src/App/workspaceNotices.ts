import { toast } from "../editor/toast";
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "../pdf/openPolicy";
import { formatBytes } from "../shared/format";
import { WorkspaceSourceSaveError } from "../storage/workspace";
import type { MergePickerNotice } from "../workspace/merge/mergePicker";
import type { PageMergeNotice } from "../workspace/merge/pageMerge";
import type { TextSourceNotice } from "../workspace/textSources/textSources";
import {
  buildOpenErrorInfo,
  showPlatformOpenError,
  unsupportedDocumentDetail,
} from "./openErrors";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** Shows what Markdown and HTML saving wants the reader to know. */
export function showTextSourceNotice(notice: TextSourceNotice, t: Translate): void {
  switch (notice.kind) {
    case "workingCopySaveFailed":
      toast.error(
        notice.error instanceof WorkspaceSourceSaveError &&
          notice.error.kind === "quota"
          ? t("documents.workspaceSourceQuotaFailed")
          : t("documents.workspaceSourceSaveFailed"),
        t("documents.workspaceSourceSaveFailedDetail"),
      );
      break;
    case "savedNoChanges":
      toast.show(t("documents.savedNoChanges"));
      break;
    case "saved":
      toast.show(t("documents.saved", { name: notice.name }));
      break;
    case "savedAs":
      toast.show(
        t("toast.savedAs", { path: notice.path }),
        t("toast.savedAsHint"),
      );
      break;
    case "saveOriginMissing":
      toast.error(t("documents.saveOriginMissing"), notice.title);
      break;
    case "savePermissionDenied":
      toast.error(t("documents.savePermissionDenied"), notice.title);
      break;
    case "saveSourceChanged":
      toast.errorAction(
        t("documents.saveSourceChanged"),
        { label: t("documents.saveOverwrite"), onClick: () => void notice.overwrite() },
        notice.title,
      );
      break;
    case "saveSourceUnverified":
      toast.errorAction(
        t("documents.saveSourceUnverified"),
        { label: t("documents.saveOverwrite"), onClick: () => void notice.overwrite() },
        notice.title,
      );
      break;
    case "saveEncodingUnsupported":
      toast.error(t("documents.saveEncodingUnsupported"), notice.title);
      break;
    case "saveFailed":
      toast.error(
        t("documents.saveFailed", { message: String(notice.error) }),
        notice.title,
      );
      break;
  }
}

/** Shows what a page merge wants the reader to know. */
export function showPageMergeNotice(notice: PageMergeNotice, t: Translate): void {
  switch (notice.kind) {
    case "targetChanged":
      toast.error(
        t("insertPdf.targetChanged.title"),
        t("insertPdf.targetChanged.message"),
      );
      break;
    case "targetMissing":
      toast.error(
        t("insertPdf.targetMissing.title"),
        t("insertPdf.targetMissing.message"),
      );
      break;
    case "recentsSaveFailed":
      toast.error(
        t("documents.workspaceSaveFailed"),
        t("documents.workspaceSaveFailedDetail"),
      );
      break;
    case "inserted":
      toast.show(
        t("toast.pdfPagesInserted", { count: notice.count, name: notice.name }),
        t("toast.pdfPagesInsertedDetail"),
      );
      break;
    case "insertRefused":
      toast.error(
        t(`insertPdf.${notice.code}.title`),
        `${notice.name} · ${t(`insertPdf.${notice.code}.message`)}`,
      );
      break;
    case "openFailed": {
      const info = buildOpenErrorInfo(
        notice.name,
        notice.size,
        notice.error,
        t,
        formatBytes(MAX_PDF_BYTES),
        MAX_PDF_PAGES,
      );
      toast.error(info.title, `${info.code} · ${notice.name} · ${info.message}`);
      break;
    }
  }
}

/** Shows what inserting a picked PDF's pages wants the reader to know. */
export function showMergePickerNotice(notice: MergePickerNotice, t: Translate): void {
  switch (notice.kind) {
    case "notPdf":
      toast.error(t("error.unsupportedDocument.title"), unsupportedDocumentDetail(notice.name, t));
      break;
    case "pickFailed":
      showPlatformOpenError(notice.error, undefined, t);
      break;
    case "insertFailed": {
      const info = buildOpenErrorInfo(
        notice.name,
        notice.size,
        notice.error,
        t,
        formatBytes(MAX_PDF_BYTES),
        MAX_PDF_PAGES,
      );
      toast.error(info.title, `${info.code} · ${notice.name} · ${info.message}`);
      break;
    }
  }
}
