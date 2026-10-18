import { toast } from "../editor/toast";
import type { AcquireNotice } from "../workspace/acquire/acquire";
import {
  showDocumentOpenPolicyError,
  showPlatformOpenError,
  unsupportedDocumentDetail,
} from "./openErrors";
import { describeRestoreError } from "./render/restoreError";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** Shows what document acquisition wants the reader to know. */
export function showAcquireNotice(notice: AcquireNotice, t: Translate): void {
  switch (notice.kind) {
    case "unsupported":
      toast.error(
        t("error.unsupportedDocument.title"),
        unsupportedDocumentDetail(notice.name, t),
      );
      break;
    case "policyRefused":
      showDocumentOpenPolicyError(notice.error, notice.name, notice.documentKind, t);
      break;
    case "openFailed":
      showPlatformOpenError(notice.error, notice.name, t, notice.detail);
      break;
    case "recentMissing":
      toast.error(t("toast.recentMissing"), notice.detail);
      break;
    case "workingCopyMissing":
      toast.error(t("documents.workingCopyMissing"), notice.name);
      break;
    case "webAccessLost":
      toast.errorAction(
        t(
          notice.code
            ? `toast.recentWebAccess.${notice.code}`
            : "toast.recentWebAccessLost",
        ),
        { label: t("toast.recentWebAccessAction"), onClick: notice.reauthorize },
        notice.name,
      );
      break;
    case "webAccessGone":
      toast.error(t("toast.recentWebAccessLost"), notice.name);
      break;
    case "webUnsupported":
      toast.error(t("toast.recentWebUnsupported"), notice.name);
      break;
    case "restoreFailed":
      toast.errorAction(
        t("tabs.restoreFailed"),
        { label: t("tabs.restorePickAgain"), onClick: notice.pickAgain },
        `${notice.title} · ${describeRestoreError(notice.detail, t)}`,
      );
      break;
  }
}
