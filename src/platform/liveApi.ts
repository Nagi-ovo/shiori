import { IS_TAURI_DESKTOP } from "./index";
import type { Rotation } from "../pdf/model/types";
// The IPC boundary types this payload's free-form JSON as serde_json::Value;
// JsonValue is the generated TS mirror. Using it (instead of `unknown`) keeps
// LiveApiError assignable to the generated liveApiComplete parameter.
import type { JsonValue } from "./bindings";

export const LIVE_API_SCHEMA = "shiori.live/v1" as const;
export const LIVE_API_ANNOTATION_REQUEST_EVENT =
  "shiori://live-api/annotation-request";

/** One turn of a callout conversation, as an agent reads it back. */
export type LiveApiThreadTurn = {
  role: "user" | "agent";
  author?: string;
  text: string;
};

/**
 * Content-only view of one annotation: what it says and what it points at,
 * never where it sits. See src/live/annotationDigest.ts for why.
 */
export type LiveApiAnnotationDigest = {
  id: string;
  type: string;
  /** 1-based display page. */
  page: number;
  text?: string;
  /** The anchored quote, when the annotation was created against text. */
  quote?: string;
  thread?: LiveApiThreadTurn[];
};

export type LiveApiContext = {
  documentId: string;
  name: string;
  path?: string;
  sha256: string;
  pageTopologyHash: string;
  pageCount: number;
  activePage?: {
    page: number;
    widthPt: number;
    heightPt: number;
    rotation: Rotation;
  };
  annotationCount: number;
  dirty: boolean;
  /**
   * Readable annotations. Absent when nothing carries text; shorter than
   * `annotationCount` by design — geometry-only annotations have nothing to
   * read. `annotationsTruncated` marks the list as clipped by size caps.
   */
  annotations?: LiveApiAnnotationDigest[];
  annotationsTruncated?: boolean;
};

export type LiveApiTarget = {
  documentId: string;
  sha256: string;
  pageTopologyHash: string;
};

export type LiveApiAnnotationRequest = {
  requestId: string;
  operationId: string;
  /** Absolute Unix epoch milliseconds. The native request slot is gone after
   * this instant, so the webview must never mutate once it is reached. */
  expiresAtMs: number;
  target: LiveApiTarget;
  spec: unknown;
  dryRun: boolean;
  /** Hashed into operationId; absent unless the caller asked for a new
   * operation (src/live/liveOperation.ts). */
  nonce?: string;
};

export type LiveApiSuccessData = {
  documentId: string;
  sha256: string;
  pageTopologyHash: string;
  operationId: string;
  added: number;
  annotationIds: string[];
  dryRun: boolean;
  annotationCount: number;
  /**
   * Present (true) only when this operation's receipt already exists, so
   * nothing was re-added even if its annotations are gone (Undo, discard).
   */
  alreadyApplied?: true;
};

export type LiveApiError = {
  code:
    | "SPEC_INVALID"
    | "TARGET_CHANGED"
    | "NO_PDF"
    | "OPERATION_CONFLICT"
    | "REQUEST_TIMEOUT"
    | "INTERNAL";
  message: string;
  details?: JsonValue;
};

export type LiveApiCompletion =
  | { ok: true; data: LiveApiSuccessData }
  | { ok: false; error: LiveApiError };

export async function updateLiveApiContext(
  context: LiveApiContext | null,
): Promise<void> {
  if (!IS_TAURI_DESKTOP) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.liveApiUpdateContext(context));
}

export async function completeLiveApiRequest(
  requestId: string,
  result: LiveApiCompletion,
): Promise<void> {
  if (!IS_TAURI_DESKTOP) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.liveApiComplete(requestId, result));
}

/** Native Instant-based gate immediately before a Live API mutation. */
export async function authorizeLiveApiMutation(requestId: string): Promise<void> {
  if (!IS_TAURI_DESKTOP) return;
  const { commands, unwrapCommand } = await import("./ipc");
  unwrapCommand(await commands.liveApiAuthorizeMutation(requestId));
}

export async function listenLiveApiAnnotationRequests(
  handler: (request: LiveApiAnnotationRequest) => void | Promise<void>,
): Promise<() => void> {
  if (!IS_TAURI_DESKTOP) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LiveApiAnnotationRequest>(
    LIVE_API_ANNOTATION_REQUEST_EVENT,
    (event) => {
      void handler(event.payload);
    },
  );
}
