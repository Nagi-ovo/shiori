// Tab-restore failures surface in a toast; these internal reason codes must
// read as guidance, not identifiers. Unknown codes pass through verbatim so
// genuinely unexpected errors stay diagnosable.
const RESTORE_ERROR_KEYS: Record<string, string> = {
  "document-path-unavailable": "tabs.restoreErrors.pathUnavailable",
  "unsupported-document": "tabs.restoreErrors.unsupported",
  "workspace-cache-missing": "tabs.restoreErrors.cacheMissing",
  "workspace-source-ephemeral": "tabs.restoreErrors.ephemeral",
  "webFileHandle:handleMissing": "tabs.restoreErrors.handleMissing",
  "webFileHandle:permissionDenied": "tabs.restoreErrors.permissionDenied",
  "webFileHandle:fileUnavailable": "tabs.restoreErrors.fileUnavailable",
  "pdf-password-required": "password.hint",
  "runtime-storage-admission-failed": "documents.runtimeStorageFailedDetail",
};

export function describeRestoreError(
  detail: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  if (detail.startsWith("document-policy:")) {
    const policyKind = detail.slice("document-policy:".length);
    if (
      policyKind === "tooLarge" ||
      policyKind === "invalidDocx" ||
      policyKind === "docxTooComplex"
    ) {
      return t(`documents.openPolicy.${policyKind}.title`);
    }
  }
  const key = RESTORE_ERROR_KEYS[detail];
  return key ? t(key) : detail;
}
