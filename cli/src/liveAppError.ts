// The live client's error type, and how an app error envelope maps onto it.
// Split out of liveApp.ts, which re-exports LiveAppError and LiveAppErrorCode.

export type LiveAppErrorCode =
  | "ERR_APP_UNAVAILABLE"
  | "ERR_APP_AUTH"
  | "ERR_APP_BUSY"
  | "ERR_APP_NO_PDF"
  | "ERR_APP_TARGET_CHANGED"
  | "ERR_APP_OUTCOME_UNKNOWN"
  | "ERR_APP_OPERATION_CONFLICT"
  | "ERR_SPEC_INVALID"
  | "ERR_TEXT_UNAVAILABLE"
  | "ERR_ANCHOR_UNRESOLVED"
  | "ERR_FILE_UNAVAILABLE"
  | "ERR_FILE_TOO_LARGE";

export class LiveAppError extends Error {
  readonly code: LiveAppErrorCode;
  readonly detail?: string;

  constructor(code: LiveAppErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "LiveAppError";
    this.code = code;
    this.detail = detail;
  }
}

export type LiveRemoteError = {
  code: string;
  message: string;
  details?: unknown;
};

export function remoteError(
  status: number,
  error: LiveRemoteError,
  token: string,
): LiveAppError {
  const code = error.code;
  if (status === 401 || code === "AUTH_FAILED") {
    // Never attach server text to auth failures; a fixed message cannot be
    // used to reflect anything back at the caller.
    return new LiveAppError(
      "ERR_APP_AUTH",
      "Shiori rejected live API authentication",
    );
  }
  // The stable message is the machine contract; the app's own explanation
  // (e.g. which annotation index a spec rejection points at) rides along as
  // detail so failures stay debuggable without re-running offline annotate.
  const detail = describeRemoteFailure(error, token);
  if (code === "NO_PDF") {
    return new LiveAppError("ERR_APP_NO_PDF", "No PDF is open in Shiori", detail);
  }
  if (code === "OPERATION_CONFLICT") {
    return new LiveAppError(
      "ERR_APP_OPERATION_CONFLICT",
      "The operation ID conflicts with the current annotation state; nothing was written",
      detail,
    );
  }
  if (status === 503 || code === "APP_BUSY") {
    return new LiveAppError(
      "ERR_APP_BUSY",
      "Shiori is busy with another Live API request",
      `${detail}; nothing was registered for this request, so it is safe to retry shortly`,
    );
  }
  if (status === 409 || code === "TARGET_CHANGED") {
    return new LiveAppError(
      "ERR_APP_TARGET_CHANGED",
      "The active Shiori document changed before annotations were applied",
      detail,
    );
  }
  const reason = remoteFailureReason(error.details);
  if (code === "SPEC_INVALID" && reason === "TEXT_UNAVAILABLE") {
    return new LiveAppError(
      "ERR_TEXT_UNAVAILABLE",
      "Shiori could not extract this PDF's text safely for anchoring",
      detail,
    );
  }
  if (code === "SPEC_INVALID" && reason === "ANCHOR_UNRESOLVED") {
    return new LiveAppError(
      "ERR_ANCHOR_UNRESOLVED",
      "Shiori could not resolve the requested text anchor",
      detail,
    );
  }
  if (status === 422 || status === 413 || code === "SPEC_INVALID") {
    return new LiveAppError(
      "ERR_SPEC_INVALID",
      "Shiori rejected the annotation spec",
      detail,
    );
  }
  return new LiveAppError(
    "ERR_APP_UNAVAILABLE",
    "Shiori live API request failed",
    detail,
  );
}

function remoteFailureReason(details: unknown): string | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return null;
  }
  const reason = (details as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : null;
}

function describeRemoteFailure(
  error: LiveRemoteError,
  token: string,
): string {
  let detail = `app reported ${error.code}: ${error.message}`;
  if (error.details !== undefined) {
    let extra: string;
    try {
      extra = JSON.stringify(error.details) ?? "[unserializable]";
    } catch {
      extra = "[unserializable]";
    }
    if (extra.length > 2_048) extra = `${extra.slice(0, 2_048)}…`;
    detail += `; details=${extra}`;
  }
  // The bearer token is the only secret the CLI holds; a server must never be
  // able to reflect it back through an error we print.
  return token ? detail.split(token).join("[redacted]") : detail;
}

export function invalidDescriptor(): LiveAppError {
  return unavailable("Shiori live API descriptor is invalid");
}

export function unavailable(message: string): LiveAppError {
  return new LiveAppError("ERR_APP_UNAVAILABLE", message);
}
