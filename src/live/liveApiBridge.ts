import type { PdfDocument as PDFDocumentProxy } from "../pdf/engine/types";
import type { PdfPageTextContent as TextContent } from "../pdf/engine/text";
import { appPdfEngine } from "../pdf/engine/appEngine";
import type {
  CalloutThreadEntry,
  Overlay,
  OverlayTextAnchor,
  PageModel,
} from "../pdf/model/types";
import { sha256Hex } from "../storage/hash";
import {
  AnchorResolutionError,
  AnchorTextUnavailableError,
  attachResolvedAnchors,
  buildAnchorPageText,
  resolveAnnotationSpecAnchors,
  specHasAnchors,
} from "../pdf/annotations/resolveAnchors";
import {
  CanonicalJsonError,
  canonicalJson,
  liveOperationCanonicalPayload,
} from "./liveOperation";
import {
  AnnotationSpecError,
  parseAnnotationSpec,
} from "../pdf/annotations/parseSpec";
import { annotationSpecViolation } from "../pdf/annotations/spec";
import {
  SemanticTextLimitError,
  type BoundedTextContentOptions,
} from "../editor/textSelection/semanticText";
import type {
  LiveApiAnnotationDigest,
  LiveApiAnnotationRequest,
  LiveApiCompletion,
  LiveApiContext,
  LiveApiTarget,
} from "../platform/liveApi";
import type { JsonValue } from "../platform/bindings";

export type LiveContextSource = {
  ready: boolean;
  documentId: string | null;
  name: string | null;
  path?: string;
  sha256: string | null;
  pageTopologyHash: string | null;
  pages: PageModel[];
  activePageId: string | null;
  annotationCount: number;
  dirty: boolean;
  /**
   * Content digest of the readable annotations, built separately so its
   * identity stays stable across geometry-only edits (see App.tsx) — a drag
   * must not republish the document's text.
   */
  annotations?: LiveApiAnnotationDigest[];
  annotationsTruncated?: boolean;
};

export type ActiveLivePdf = {
  documentId: string;
  sha256: string;
  pageTopologyHash: string;
  pages: PageModel[];
  overlays: Overlay[];
  commitOverlays: (overlays: Overlay[]) => void;
  prepareOverlayCommit: (
    overlays: Overlay[],
    ui?: {
      addedOverlays: Overlay[];
      selectedIds: string[];
      batchId: string;
    },
  ) => (() => boolean) | null;
  /** Durable for this open-document session, independent of current overlays. */
  hasOperationReceipt?: (operationId: string) => boolean;
  /** Preferred store path: atomic model update + compact per-overlay history. */
  prepareOverlayBatchCommit?: (
    overlays: Overlay[],
    operationId: string,
    ui?: {
      addedOverlays: Overlay[];
      selectedIds: string[];
      batchId: string;
    },
  ) => (() => boolean) | null;
  /** The prepared commit publishes model + selection in the same store set. */
  commitsSelectionAtomically?: boolean;
  isCurrentSnapshot: () => boolean;
  selectOverlays?: (ids: string[]) => void;
  /** Page text for quote-anchor resolution. The PageModel belongs to the
   * operation's fixed page snapshot; implementations must not re-read the
   * active document. Absent means anchored requests fail with SPEC_INVALID. */
  getPageTextContent?: (
    page: PageModel,
    options?: BoundedTextContentOptions,
  ) => Promise<TextContent>;
};

export type LiveAnnotationDependencies = {
  /** Must read refs and the supplied editor StoreApi when called; never close over a render. */
  getActivePdf: () => ActiveLivePdf | null;
  /** Called after a non-dry-run commit lands so the UI can announce the
   * remote write — the user did not perform the action that just changed
   * (and cleared the redo stack of) their document. */
  onRemoteWrite?: (added: number) => void;
  /** Synchronous, no-throw notification after an authorized commit lands.
   * Persistence may start here but must not be awaited on the mutation path. */
  onOperationCommitted?: (sha256: string, operationId: string) => void;
  /** Test seam for absolute request deadlines. Production uses Date.now. */
  now?: () => number;
  /** Test seam for rollback-safe elapsed time. Production uses performance.now. */
  monotonicNow?: () => number;
};

export type LiveApiBridgeTransport = {
  listen: (
    handler: (request: LiveApiAnnotationRequest) => void | Promise<void>,
  ) => Promise<() => void>;
  /** Native Instant-based authorization immediately before synchronous commit. */
  authorizeMutation: (requestId: string) => Promise<void>;
  complete: (requestId: string, result: LiveApiCompletion) => Promise<void>;
  onError?: (error: unknown) => void;
};

const EMPTY_TEXT_CONTENT: TextContent = {
  items: [],
  styles: {},
  lang: null,
};
const MAX_LIVE_ERROR_MESSAGE_BYTES = 2_048;

// Leave time for the completion IPC and native HTTP response after the last
// possible mutation. Native owns the authoritative 30s slot; this margin makes
// the frontend fail closed before that slot can disappear.
export const LIVE_API_DEADLINE_SAFETY_MS = 500;
export const LIVE_API_NATIVE_TIMEOUT_MS = 30_000;

export type LiveRequestDeadlineGuard = {
  /** Cheap predicate for synchronous mutation gates and resolver checkpoints. */
  shouldCancel: () => boolean;
};

class LiveRequestExpiredError extends Error {
  constructor() {
    super("The Live API request deadline expired");
    this.name = "LiveRequestExpiredError";
  }
}

export function createLiveRequestDeadlineGuard(
  expiresAtMs: number,
  now: () => number = Date.now,
  monotonicNow: () => number = () => globalThis.performance.now(),
): LiveRequestDeadlineGuard {
  const validDeadline =
    Number.isSafeInteger(expiresAtMs) && expiresAtMs > 0
      ? expiresAtMs - LIVE_API_DEADLINE_SAFETY_MS
      : Number.NEGATIVE_INFINITY;
  const wallStart = now();
  const monotonicStart = monotonicNow();
  const nativeIssuedAtMs = expiresAtMs - LIVE_API_NATIVE_TIMEOUT_MS;
  const wallClockRolledBackBeforeGuard =
    Number.isFinite(wallStart) && wallStart < nativeIssuedAtMs;
  const remainingMs =
    Number.isFinite(wallStart) && !wallClockRolledBackBeforeGuard
      ? Math.min(
          Math.max(0, validDeadline - wallStart),
          LIVE_API_NATIVE_TIMEOUT_MS - LIVE_API_DEADLINE_SAFETY_MS,
        )
      : Number.NaN;
  const monotonicCandidate = monotonicStart + remainingMs;
  const monotonicDeadline =
    Number.isFinite(monotonicStart) && Number.isFinite(monotonicCandidate)
      ? monotonicCandidate
      : Number.NEGATIVE_INFINITY;
  return {
    shouldCancel: () => {
      const wallCurrent = now();
      const monotonicCurrent = monotonicNow();
      return (
        !Number.isFinite(wallCurrent) ||
        !Number.isFinite(monotonicCurrent) ||
        wallCurrent >= validDeadline ||
        monotonicCurrent >= monotonicDeadline
      );
    },
  };
}

/**
 * Capture one document for the lifetime of a Live API operation and map
 * Shiori's editable page model back to the source PDF. Display positions
 * cannot be passed to the engine: pages may be reordered, duplicated,
 * deleted, or synthetic blanks.
 */
export function createLivePageTextContentReader(
  doc: PDFDocumentProxy,
): (
  page: PageModel,
  options?: BoundedTextContentOptions,
) => Promise<TextContent> {
  return async (page, options) => {
    if (page.blank === true || page.sourceIndex < 0) {
      return EMPTY_TEXT_CONTENT;
    }
    const text = await appPdfEngine.pageText(doc, page.sourceIndex, {
      checkAbort: options?.checkAbort,
      textOnly: true,
    });
    return text.content;
  };
}

export function buildLiveApiContext(
  source: LiveContextSource,
): LiveApiContext | null {
  if (
    !source.ready ||
    !source.documentId ||
    !source.name ||
    !source.sha256 ||
    !source.pageTopologyHash
  ) {
    return null;
  }
  const pageIndex = source.activePageId
    ? source.pages.findIndex((page) => page.id === source.activePageId)
    : -1;
  const page = pageIndex >= 0 ? source.pages[pageIndex] : undefined;
  return {
    documentId: source.documentId,
    name: source.name,
    ...(source.path ? { path: source.path } : {}),
    sha256: source.sha256,
    pageTopologyHash: source.pageTopologyHash,
    pageCount: source.pages.length,
    ...(page
      ? {
          activePage: {
            page: pageIndex + 1,
            widthPt: page.widthPt,
            heightPt: page.heightPt,
            rotation: page.rotation,
          },
        }
      : {}),
    annotationCount: source.annotationCount,
    dirty: source.dirty,
    ...(source.annotations?.length ? { annotations: source.annotations } : {}),
    // Only ever true — a false flag would just be noise on the wire.
    ...(source.annotationsTruncated ? { annotationsTruncated: true } : {}),
  };
}

export function applyLiveAnnotationRequest(
  request: LiveApiAnnotationRequest,
  dependencies: LiveAnnotationDependencies,
  deadlineGuard: LiveRequestDeadlineGuard = createLiveRequestDeadlineGuard(
    request.expiresAtMs,
    dependencies.now,
  ),
): LiveApiCompletion {
  const prepared = prepareLiveAnnotationRequest(
    request,
    dependencies,
    deadlineGuard,
  );
  return "ok" in prepared
    ? prepared
    : commitPreparedLiveAnnotationRequest(
        prepared,
        dependencies,
        deadlineGuard,
      );
}

type PreparedLiveAnnotationRequest = {
  requestId: string;
  snapshot: ActiveLivePdf;
  commit: (() => boolean) | null;
  selectedIds: string[];
  added: number;
  success: Extract<LiveApiCompletion, { ok: true }>;
};

// Internal to the bridge: the wire request plus the anchor provenance the
// resolver collected. Never serialized — the operation id and every contract
// type stay derived from the untouched spec bytes.
type LiveAnnotationRequestWithAnchors = LiveApiAnnotationRequest & {
  resolvedAnchors?: ReadonlyMap<number, OverlayTextAnchor>;
};

function prepareLiveAnnotationRequest(
  request: LiveAnnotationRequestWithAnchors,
  dependencies: LiveAnnotationDependencies,
  deadlineGuard: LiveRequestDeadlineGuard,
): PreparedLiveAnnotationRequest | LiveApiCompletion {
  if (deadlineGuard.shouldCancel()) return requestDeadlineFailure();
  if (!/^[0-9a-f]{64}$/.test(request.operationId)) {
    return failure("INTERNAL", "The annotation operation identifier is invalid");
  }
  // The server only forwards a request whose target matched the registered
  // context, so a null read here means the document is mid-transition (tab
  // switch, topology rehash), not "nothing is open". Report TARGET_CHANGED —
  // the shape the second read already uses — instead of a NO_PDF the user
  // can plainly see is false.
  const initial = dependencies.getActivePdf();
  if (!initial) {
    return failure(
      "TARGET_CHANGED",
      "The active PDF changed before annotations were applied",
      { expected: request.target, actual: null },
    );
  }
  const initialMismatch = targetMismatch(request.target, initial);
  if (initialMismatch) return initialMismatch;

  // A pure calloutReply spec appends conversation turns to existing
  // callouts instead of creating overlays — it never meets the overlay
  // parser. Mixed specs fall through to parseAnnotationSpec, which rejects
  // the type with live-only guidance.
  const replyAnnotations = calloutReplySpecAnnotations(request.spec);
  if (replyAnnotations) {
    return prepareLiveCalloutReplies(
      request,
      replyAnnotations,
      dependencies,
      deadlineGuard,
    );
  }

  let planned: Overlay[];
  try {
    planned = attachResolvedAnchors(
      parseAnnotationSpec(request.spec, initial.pages, {
        namespace: request.operationId,
        idPrefix: "live",
      }),
      request.resolvedAnchors,
    );
  } catch (error) {
    if (error instanceof AnnotationSpecError) {
      return failure("SPEC_INVALID", error.message);
    }
    return failure("INTERNAL", "Could not parse the annotation request");
  }

  // Re-read immediately before mutation. Tab switches can happen while a
  // native event waits in the webview queue; render-time context is not proof
  // that the same document is still active now.
  const latest = dependencies.getActivePdf();
  if (!latest) {
    return failure(
      "TARGET_CHANGED",
      "The active PDF changed before annotations were applied",
      { expected: request.target, actual: null },
    );
  }
  const latestMismatch = targetMismatch(request.target, latest);
  if (latestMismatch) return latestMismatch;

  // A page operation between the two reads can replace page ids without
  // changing the source hash. Re-parse against the current model so overlays
  // always point at the current page lineage.
  if (latest.pages !== initial.pages) {
    try {
      planned = attachResolvedAnchors(
        parseAnnotationSpec(request.spec, latest.pages, {
          namespace: request.operationId,
          idPrefix: "live",
        }),
        request.resolvedAnchors,
      );
    } catch (error) {
      if (error instanceof AnnotationSpecError) {
        return failure("SPEC_INVALID", error.message);
      }
      return failure("INTERNAL", "Could not parse the annotation request");
    }
  }

  // A receipt survives partial/full Undo. A response-lost retry must remain a
  // no-op instead of interpreting the user's Undo as missing work to restore.
  const operationAlreadyCompleted = latest.hasOperationReceipt?.(
    request.operationId,
  );

  // Operation-derived IDs make applying the same logical patch idempotent.
  // A response can be lost after commit; a retry then finds these IDs and
  // appends only anything that is genuinely missing instead of duplicating
  // the entire batch.
  const plannedIds = new Set(planned.map((overlay) => overlay.id));
  const matchingExisting = latest.overlays.filter((overlay) =>
    plannedIds.has(overlay.id),
  );
  const existingById = new Map(
    matchingExisting.map((overlay) => [overlay.id, overlay]),
  );
  const presentCount = existingById.size;
  if (
    !operationAlreadyCompleted &&
    (matchingExisting.length !== presentCount ||
      (presentCount > 0 &&
        (presentCount !== planned.length ||
          planned.some((overlay) => {
            const existing = existingById.get(overlay.id);
            return !existing || !sameOperationOverlay(existing, overlay);
          }))))
  ) {
    return failure(
      "OPERATION_CONFLICT",
      "The annotation operation conflicts with existing overlays",
      { operationId: request.operationId },
    );
  }
  const missing = operationAlreadyCompleted
    ? []
    : presentCount === 0
      ? planned
      : [];
  const annotationIds = planned.map((overlay) => overlay.id);
  if (deadlineGuard.shouldCancel()) return requestDeadlineFailure();
  const selectedIds = missing.map((overlay) => overlay.id);
  let commit: (() => boolean) | null = null;
  if (!request.dryRun && missing.length > 0) {
    // Build the new overlay array, compact history group, and receipt before
    // native authorization. Post-authorization work must remain O(1).
    const ui = {
      addedOverlays: missing,
      selectedIds,
      batchId: request.operationId,
    };
    commit = latest.prepareOverlayBatchCommit
      ? latest.prepareOverlayBatchCommit(missing, request.operationId, ui)
      : latest.prepareOverlayCommit([...latest.overlays, ...missing], ui);
    if (!commit) {
      return failure(
        "TARGET_CHANGED",
        "The active PDF changed while preparing annotations",
        { expected: request.target },
      );
    }
  }

  return {
    requestId: request.requestId,
    snapshot: latest,
    commit,
    selectedIds,
    added: missing.length,
    success: {
      ok: true,
      data: {
        documentId: latest.documentId,
        sha256: latest.sha256,
        pageTopologyHash: latest.pageTopologyHash,
        operationId: request.operationId,
        added: missing.length,
        annotationIds,
        dryRun: request.dryRun,
        // Post-operation count in both modes: a dry run reports the projected
        // total rather than mixing a hypothetical `added` with a current count.
        annotationCount: latest.overlays.length + missing.length,
      },
    },
  };
}

const MAX_REPLY_AUTHOR_CHARACTERS = 512;

type CalloutReplyAnnotation = {
  replyTo: string;
  text: string;
  author?: string;
};

// Returns the entries of a spec whose EVERY annotation is a calloutReply,
// or null when the spec is anything else (including mixed specs, malformed
// shells, or explicit schema strings — those keep their existing error
// paths through the strict parser).
function calloutReplySpecAnnotations(
  spec: unknown,
): Record<string, unknown>[] | null {
  if (!isObject(spec)) return null;
  if (Object.prototype.hasOwnProperty.call(spec, "schema")) {
    // Versioned specs stay with the parser so schema mismatches keep their
    // canonical error message; the unversioned form is what `shiori app
    // annotate` sends for synthesized operations anyway.
    if (typeof spec.schema !== "string") return null;
  }
  if (!Array.isArray(spec.annotations) || spec.annotations.length === 0) {
    return null;
  }
  const entries: Record<string, unknown>[] = [];
  for (const entry of spec.annotations) {
    if (!isObject(entry) || entry.type !== "calloutReply") return null;
    entries.push(entry);
  }
  return entries;
}

// Thread appends reuse the whole live pipeline — deadline guard, native
// authorization, receipts, remote-write toast — by producing the same
// PreparedLiveAnnotationRequest shape the overlay path does. Idempotency
// works like overlay creation: turn ids derive from the operation id, so a
// lost-response retry finds its own turns already on the callout and adds
// nothing.
function prepareLiveCalloutReplies(
  request: LiveApiAnnotationRequest,
  entries: Record<string, unknown>[],
  dependencies: LiveAnnotationDependencies,
  deadlineGuard: LiveRequestDeadlineGuard,
): PreparedLiveAnnotationRequest | LiveApiCompletion {
  const budgetViolation = annotationSpecViolation(entries);
  if (budgetViolation) return failure("SPEC_INVALID", budgetViolation);
  const replies: CalloutReplyAnnotation[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const path = `annotations[${index}]`;
    for (const key of Object.keys(entry)) {
      if (!["type", "replyTo", "text", "author"].includes(key)) {
        return failure("SPEC_INVALID", `${path}.${key} is not supported`);
      }
    }
    if (typeof entry.replyTo !== "string" || entry.replyTo.length === 0) {
      return failure(
        "SPEC_INVALID",
        `${path}.replyTo must be a non-empty overlay id`,
      );
    }
    if (typeof entry.text !== "string" || entry.text.trim().length === 0) {
      return failure(
        "SPEC_INVALID",
        `${path}.text must be a non-empty string`,
      );
    }
    if (
      entry.author !== undefined &&
      (typeof entry.author !== "string" ||
        entry.author.length === 0 ||
        entry.author.length > MAX_REPLY_AUTHOR_CHARACTERS)
    ) {
      return failure(
        "SPEC_INVALID",
        `${path}.author must be a string of at most ${MAX_REPLY_AUTHOR_CHARACTERS} characters`,
      );
    }
    replies.push({
      replyTo: entry.replyTo,
      text: entry.text,
      ...(entry.author !== undefined ? { author: entry.author } : {}),
    });
  }

  // Validate and prepare against one fresh read — the same snapshot the
  // commit closure will verify via isCurrentSnapshot.
  const latest = dependencies.getActivePdf();
  if (!latest) {
    return failure(
      "TARGET_CHANGED",
      "The active PDF changed before annotations were applied",
      { expected: request.target, actual: null },
    );
  }
  const latestMismatch = targetMismatch(request.target, latest);
  if (latestMismatch) return latestMismatch;

  const overlaysById = new Map(
    latest.overlays.map((overlay) => [overlay.id, overlay]),
  );
  const additions = new Map<string, CalloutThreadEntry[]>();
  const operationAlreadyCompleted = latest.hasOperationReceipt?.(
    request.operationId,
  );
  let added = 0;
  for (let index = 0; index < replies.length; index += 1) {
    const reply = replies[index]!;
    const target = overlaysById.get(reply.replyTo);
    if (!target || target.type !== "callout") {
      return failure(
        "SPEC_INVALID",
        `annotations[${index}].replyTo does not match a callout in the open document`,
        { replyTo: reply.replyTo },
      );
    }
    if (operationAlreadyCompleted) continue;
    const turnId = `live-${request.operationId.slice(0, 24)}-${index}`;
    if (target.thread?.some((turn) => turn.id === turnId)) continue;
    const pending = additions.get(target.id) ?? [];
    if (pending.some((turn) => turn.id === turnId)) continue;
    pending.push({
      id: turnId,
      role: "agent",
      text: reply.text,
      at: dependencies.now?.() ?? Date.now(),
      ...(reply.author ? { author: reply.author } : {}),
    });
    additions.set(target.id, pending);
    added += 1;
  }

  if (deadlineGuard.shouldCancel()) return requestDeadlineFailure();
  const annotationIds = [...new Set(replies.map((reply) => reply.replyTo))];
  let commit: (() => boolean) | null = null;
  if (!request.dryRun && added > 0) {
    const nextOverlays = latest.overlays.map((overlay) => {
      const extra = additions.get(overlay.id);
      return extra && overlay.type === "callout"
        ? { ...overlay, thread: [...(overlay.thread ?? []), ...extra] }
        : overlay;
    });
    commit = latest.prepareOverlayCommit(nextOverlays, {
      addedOverlays: [],
      // Selecting the callout is what unfolds its conversation panel, so the
      // reply the agent just wrote is visible the moment it lands.
      selectedIds: annotationIds,
      batchId: request.operationId,
    });
    if (!commit) {
      return failure(
        "TARGET_CHANGED",
        "The active PDF changed while preparing annotations",
        { expected: request.target },
      );
    }
  }

  return {
    requestId: request.requestId,
    snapshot: latest,
    commit,
    selectedIds: added > 0 ? annotationIds : [],
    added,
    success: {
      ok: true,
      data: {
        documentId: latest.documentId,
        sha256: latest.sha256,
        pageTopologyHash: latest.pageTopologyHash,
        operationId: request.operationId,
        added,
        annotationIds,
        dryRun: request.dryRun,
        // Replies patch existing overlays; the annotation count is unchanged.
        annotationCount: latest.overlays.length,
      },
    },
  };
}

function commitPreparedLiveAnnotationRequest(
  prepared: PreparedLiveAnnotationRequest,
  dependencies: LiveAnnotationDependencies,
  deadlineGuard: LiveRequestDeadlineGuard,
): LiveApiCompletion {
  if (deadlineGuard.shouldCancel()) return requestDeadlineFailure();
  if (!prepared.snapshot.isCurrentSnapshot()) {
    return failure(
      "TARGET_CHANGED",
      "The active PDF changed before annotations were applied",
    );
  }
  if (prepared.commit && !prepared.commit()) {
    return failure(
      "TARGET_CHANGED",
      "The active PDF was edited before annotations were applied",
    );
  }
  if (prepared.commit) {
    if (!prepared.snapshot.commitsSelectionAtomically) {
      prepared.snapshot.selectOverlays?.(prepared.selectedIds);
    }
    dependencies.onOperationCommitted?.(
      prepared.snapshot.sha256,
      prepared.success.data.operationId,
    );
    dependencies.onRemoteWrite?.(prepared.added);
  }
  return prepared.success;
}

export async function connectLiveApiBridge(
  dependencies: LiveAnnotationDependencies,
  transport: LiveApiBridgeTransport,
): Promise<() => void> {
  return transport.listen(async (request) => {
    let result: LiveApiCompletion;
    const deadlineGuard = createLiveRequestDeadlineGuard(
      request.expiresAtMs,
      dependencies.now,
      dependencies.monotonicNow,
    );
    try {
      if (deadlineGuard.shouldCancel()) {
        result = requestDeadlineFailure();
      } else if (await liveOperationIdMatches(request)) {
        // Anchors resolve BEFORE the synchronous apply: the operation id was
        // verified against the spec as sent, and apply re-checks the target
        // after this await, so the double-read race guard is preserved.
        const prepared = await resolveLiveRequestAnchors(
          request,
          dependencies,
          deadlineGuard,
        );
        if ("ok" in prepared) {
          result = prepared;
        } else {
          const plan = prepareLiveAnnotationRequest(
            prepared,
            dependencies,
            deadlineGuard,
          );
          result =
            "ok" in plan
              ? plan
              : await authorizeAndCommitLiveRequest(
                  plan,
                  dependencies,
                  deadlineGuard,
                  transport,
                );
        }
      } else {
        result = failure(
          "SPEC_INVALID",
          "The operation identifier does not match its target and spec",
        );
      }
    } catch (error) {
      if (error instanceof LiveRequestExpiredError) {
        result = requestDeadlineFailure();
      } else if (
        error instanceof AnnotationSpecError ||
        error instanceof CanonicalJsonError
      ) {
        result = failure("SPEC_INVALID", error.message);
      } else {
        transport.onError?.(error);
        result = failure("INTERNAL", "Could not apply the annotation request");
      }
    }
    try {
      await transport.complete(request.requestId, result);
    } catch (error) {
      transport.onError?.(error);
    }
  });
}

async function authorizeAndCommitLiveRequest(
  prepared: PreparedLiveAnnotationRequest,
  dependencies: LiveAnnotationDependencies,
  deadlineGuard: LiveRequestDeadlineGuard,
  transport: LiveApiBridgeTransport,
): Promise<LiveApiCompletion> {
  if (deadlineGuard.shouldCancel()) return requestDeadlineFailure();
  try {
    // The final await happens only after parsing, idempotency checks, the next
    // overlay array, and the Undo snapshot have all been prepared.
    await transport.authorizeMutation(prepared.requestId);
  } catch (error) {
    if (isExpiredNativeAuthorization(error)) return requestDeadlineFailure();
    transport.onError?.(error);
    return failure("INTERNAL", "Could not authorize the annotation mutation");
  }
  return commitPreparedLiveAnnotationRequest(
    prepared,
    dependencies,
    deadlineGuard,
  );
}

function isExpiredNativeAuthorization(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("live-api-request-expired") ||
    message.includes("live-api-request-not-found")
  );
}

async function resolveLiveRequestAnchors(
  request: LiveApiAnnotationRequest,
  dependencies: LiveAnnotationDependencies,
  deadlineGuard: LiveRequestDeadlineGuard,
): Promise<LiveAnnotationRequestWithAnchors | LiveApiCompletion> {
  if (!specHasAnchors(request.spec)) return request;
  const active = dependencies.getActivePdf();
  if (!active) {
    return failure(
      "TARGET_CHANGED",
      "The active PDF changed before annotations were applied",
      { expected: request.target, actual: null },
    );
  }
  const mismatch = targetMismatch(request.target, active);
  if (mismatch) return mismatch;

  // Validate the raw, anchored contract before resolution deletes `anchor`
  // and writes page/geometry fields. Without this pass, mutually-exclusive or
  // mistyped input can be transformed into a valid coordinate spec and evade
  // the strict parser. This also enforces shared count/text/geometry budgets
  // before any PDF text is extracted.
  const rawViolation = rawAnchoredSpecViolation(request.spec, active.pages);
  if (rawViolation) return failure("SPEC_INVALID", rawViolation);

  const getPageTextContent = active.getPageTextContent;
  if (!getPageTextContent) {
    return failure(
      "SPEC_INVALID",
      "Anchor resolution is not available in this Shiori build; use explicit rects",
    );
  }
  try {
    const resolvedAnchors = new Map<number, OverlayTextAnchor>();
    const spec = await resolveAnnotationSpecAnchors(
      request.spec,
      active.pages.length,
      async (pageNumber) => {
        const page = active.pages[pageNumber - 1];
        if (!page) {
          throw new AnchorResolutionError(
            `page ${pageNumber} is not available in the open document`,
          );
        }
        try {
          return buildAnchorPageText(
            pageNumber,
            await getPageTextContent(page, {
              checkAbort: () => {
                if (deadlineGuard.shouldCancel()) {
                  throw new LiveRequestExpiredError();
                }
              },
            }),
            page,
          );
        } catch (error) {
          if (error instanceof SemanticTextLimitError) {
            throw new AnchorTextUnavailableError(
              `Page ${pageNumber} has too much text to anchor safely; use explicit geometry`,
            );
          }
          throw error;
        }
      },
      {
        // The native request slot disappears at expiresAtMs. Checking inside
        // the resolver stops page extraction and repetitive match scanning,
        // rather than merely refusing the eventual commit after wasted work.
        checkAbort: () => {
          if (deadlineGuard.shouldCancel()) {
            throw new LiveRequestExpiredError();
          }
        },
        onAnchorResolved: (index, anchor) => {
          resolvedAnchors.set(index, anchor);
        },
      },
    );
    return { ...request, spec, resolvedAnchors };
  } catch (error) {
    // Reuse the SPEC_INVALID wire code: older CLIs map unknown codes to a
    // misleading "live API unavailable".
    if (error instanceof AnchorTextUnavailableError) {
      return failure("SPEC_INVALID", error.message, {
        reason: "TEXT_UNAVAILABLE",
      });
    }
    if (error instanceof AnchorResolutionError) {
      return failure("SPEC_INVALID", error.message, {
        reason: "ANCHOR_UNRESOLVED",
      });
    }
    throw error;
  }
}

function rawAnchoredSpecViolation(
  spec: unknown,
  pages: PageModel[],
): string | null {
  if (!isObject(spec) || !Array.isArray(spec.annotations)) {
    return "Spec annotations must be an array";
  }
  const sharedViolation = annotationSpecViolation(spec.annotations);
  if (sharedViolation) return sharedViolation;

  // parseAnnotationSpec is the single strict structural parser. Give each
  // already-validated anchor harmless placeholder geometry so it can check
  // schema versions, top-level/annotation keys, required fields, and mixed
  // coordinate annotations without doing real text extraction.
  const validationSpec = {
    ...spec,
    annotations: spec.annotations.map(anchorValidationAnnotation),
  };
  try {
    parseAnnotationSpec(validationSpec, pages, {
      namespace: "live-anchor-validation",
      idPrefix: "live",
    });
    return null;
  } catch (error) {
    return error instanceof AnnotationSpecError
      ? error.message
      : "Could not validate the annotation request";
  }
}

function anchorValidationAnnotation(annotation: unknown): unknown {
  if (!isObject(annotation) || !isObject(annotation.anchor)) return annotation;
  const { anchor, ...rest } = annotation;
  const page = typeof anchor.page === "number" ? anchor.page : 1;
  if (annotation.type === "note") {
    return { ...rest, page, at: { x: 0, y: 0 } };
  }
  if (annotation.type === "callout") {
    return {
      ...rest,
      page,
      targetRects: [{ x: 0, y: 0, w: 1, h: 1 }],
      quote: anchor.quote,
    };
  }
  return {
    ...rest,
    page,
    rects: [{ x: 0, y: 0, w: 1, h: 1 }],
    quote: anchor.quote,
  };
}

export async function deriveLiveOperationId(
  request: Pick<LiveApiAnnotationRequest, "target" | "spec">,
): Promise<string> {
  const canonical = liveOperationCanonicalPayload(
    request.target.sha256,
    request.target.pageTopologyHash,
    request.spec,
  );
  return sha256Hex(new TextEncoder().encode(canonical));
}

async function liveOperationIdMatches(
  request: LiveApiAnnotationRequest,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(request.operationId)) return false;
  return request.operationId === (await deriveLiveOperationId(request));
}

export type LiveContextPublisher = {
  publish: (context: LiveApiContext | null) => void;
  flush: () => Promise<void>;
};

const EMPTY = Symbol("empty-live-context");

/** Serializes native context writes and coalesces rapid page/model updates. */
export function createLiveContextPublisher(
  update: (context: LiveApiContext | null) => Promise<void>,
  onError?: (error: unknown) => void,
): LiveContextPublisher {
  let pending: LiveApiContext | null | typeof EMPTY = EMPTY;
  let drain: Promise<void> | null = null;

  const run = async () => {
    while (pending !== EMPTY) {
      const context = pending;
      pending = EMPTY;
      try {
        await update(context);
      } catch (error) {
        onError?.(error);
      }
    }
  };

  const start = () => {
    if (drain) return;
    drain = run().finally(() => {
      drain = null;
      if (pending !== EMPTY) start();
    });
  };

  return {
    publish(context) {
      pending = context;
      start();
    },
    async flush() {
      while (drain) await drain;
    },
  };
}

function targetMismatch(
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

/** Stable input for the active document's page-order/geometry precondition. */
export function serializeLivePageTopology(pages: readonly PageModel[]): string {
  return JSON.stringify(
    pages.map((page) => [
      page.sourceIndex,
      page.rotation,
      page.originXPt ?? null,
      page.originYPt ?? null,
      page.widthPt,
      page.heightPt,
      page.blank === true,
    ]),
  );
}

function failure(
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

function boundLiveErrorMessage(message: string): string {
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

function requestDeadlineFailure(): LiveApiCompletion {
  return failure(
    "REQUEST_TIMEOUT",
    "The Live API request expired before annotations could be applied",
  );
}

function sameOperationOverlay(left: Overlay, right: Overlay): boolean {
  return canonicalJson(operationOverlayShape(left)) ===
    canonicalJson(operationOverlayShape(right));
}

function operationOverlayShape(overlay: Overlay): Record<string, unknown> {
  const shape = { ...overlay } as Record<string, unknown>;
  // These timestamps are bookkeeping rather than annotation content. All
  // geometry, style, text, lock, and rotation fields remain part of the
  // comparison so a user-modified result is never mistaken for a clean retry.
  delete shape.createdAt;
  delete shape.updatedAt;
  // Anchor provenance is metadata, not content: a retry against overlays
  // committed by a build that did not record anchors must stay a no-op
  // instead of reporting OPERATION_CONFLICT.
  delete shape.anchor;
  if (shape.locked === false) delete shape.locked;
  if (shape.angle === 0) delete shape.angle;
  return shape;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
