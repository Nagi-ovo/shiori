// Completion envelopes and target checks shared by the live bridge and its
// annotation preparation (src/live/liveAnnotationPrepare.ts).
import type { JsonValue } from "../platform/bindings";
import type { LiveApiCompletion, LiveApiTarget } from "../platform/liveApi";
import type { ActiveLivePdf } from "./liveApiBridge";

const MAX_LIVE_ERROR_MESSAGE_BYTES = 2_048;

export function targetMismatch(
  target: LiveApiTarget,
  active: ActiveLivePdf,
): LiveApiCompletion | null {
  if (
    target.documentId !== active.documentId ||
    target.sha256.toLowerCase() !== active.sha256.toLowerCase() ||
    target.pageTopologyHash !== active.pageTopologyHash
  ) {
    return failure(
      "TARGET_CHANGED",
      "The annotation target is no longer the active PDF",
      {
        expected: target,
        actual: {
          documentId: active.documentId,
          sha256: active.sha256,
          pageTopologyHash: active.pageTopologyHash,
        },
      },
    );
  }
  return null;
}

export function failure(
  code:
    | "SPEC_INVALID"
    | "TARGET_CHANGED"
    | "NO_PDF"
    | "OPERATION_CONFLICT"
    | "REQUEST_TIMEOUT"
    | "INTERNAL",
  message: string,
  details?: JsonValue,
): LiveApiCompletion {
  return {
    ok: false,
    error: {
      code,
      message: boundLiveErrorMessage(message),
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function boundLiveErrorMessage(message: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(message).byteLength <= MAX_LIVE_ERROR_MESSAGE_BYTES) {
    return message;
  }
  const marker = "…";
  const maxBodyBytes =
    MAX_LIVE_ERROR_MESSAGE_BYTES - encoder.encode(marker).byteLength;
  let bytes = 0;
  let body = "";
  for (const character of message) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBodyBytes) break;
    body += character;
    bytes += size;
  }
  return `${body}${marker}`;
}

export function requestDeadlineFailure(): LiveApiCompletion {
  return failure(
    "REQUEST_TIMEOUT",
    "The Live API request expired before annotations could be applied",
  );
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
