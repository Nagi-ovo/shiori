// Validates a live annotation request against the active PDF and builds the
// commit closure and success envelope; liveApiBridge.ts authorizes and commits.
import type {
  CalloutThreadEntry,
  Overlay,
  OverlayTextAnchor,
} from "../pdf/model/types";
import { attachResolvedAnchors } from "../pdf/annotations/resolveAnchors";
import { canonicalJson } from "./liveOperation";
import {
  AnnotationSpecError,
  parseAnnotationSpec,
} from "../pdf/annotations/parseSpec";
import { annotationSpecViolation } from "../pdf/annotations/spec";
import type {
  LiveApiAnnotationRequest,
  LiveApiCompletion,
} from "../platform/liveApi";
import type {
  ActiveLivePdf,
  LiveAnnotationDependencies,
  LiveRequestDeadlineGuard,
} from "./liveApiBridge";
import {
  failure,
  isObject,
  requestDeadlineFailure,
  targetMismatch,
} from "./liveApiFailure";

export type PreparedLiveAnnotationRequest = {
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
export type LiveAnnotationRequestWithAnchors = LiveApiAnnotationRequest & {
  resolvedAnchors?: ReadonlyMap<number, OverlayTextAnchor>;
};

export function prepareLiveAnnotationRequest(
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
        ...(operationAlreadyCompleted ? { alreadyApplied: true as const } : {}),
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
        ...(operationAlreadyCompleted ? { alreadyApplied: true as const } : {}),
      },
    },
  };
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
