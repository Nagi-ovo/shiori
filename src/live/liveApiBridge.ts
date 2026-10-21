import type { PdfDocument as PDFDocumentProxy } from "../pdf/engine/types";
import type { PdfPageTextContent as TextContent } from "../pdf/engine/text";
import { appPdfEngine } from "../pdf/engine/appEngine";
import type {
  Overlay,
  OverlayTextAnchor,
  PageModel,
} from "../pdf/model/types";
import { sha256Hex } from "../storage/hash";
import {
  AnchorResolutionError,
  AnchorTextUnavailableError,
  buildAnchorPageText,
  resolveAnnotationSpecAnchors,
  specHasAnchors,
} from "../pdf/annotations/resolveAnchors";
import {
  CanonicalJsonError,
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
} from "../platform/liveApi";
import {
  prepareLiveAnnotationRequest,
  type LiveAnnotationRequestWithAnchors,
  type PreparedLiveAnnotationRequest,
} from "./liveAnnotationPrepare";
import {
  failure,
  isObject,
  requestDeadlineFailure,
  targetMismatch,
} from "./liveApiFailure";

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
