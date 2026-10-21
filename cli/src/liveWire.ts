// The shiori.live/v1 wire as the CLI reads it: the schema, the response
// envelope and document context types, and the parsers that validate every
// response before anything acts on it. Split out of liveApp.ts, which
// re-exports the public types.
import { MAX_ANNOTATIONS_PER_SPEC } from "./annotationSpec";
import { unavailable, type LiveRemoteError } from "./liveAppError";

export const LIVE_SCHEMA = "shiori.live/v1" as const;

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Mirrors of the app-side digest caps (src/live/annotationDigest.ts and
// live_api.rs). The CLI rechecks them so a truncation bug anywhere upstream
// surfaces as a loud contract failure instead of an unbounded printout.
const MAX_CONTEXT_ANNOTATIONS = 200;
const MAX_CONTEXT_THREAD_TURNS = 12;
const MAX_CONTEXT_TEXT_CHARS = 1024;

export type LiveAppThreadTurn = {
  role: "user" | "agent";
  author?: string;
  text: string;
};

/**
 * What one annotation says, with no geometry. This is the agent's read path:
 * before it existed, `annotationCount` was the only thing the CLI could say
 * about a document's annotations, so a session could write a callout and
 * never read one back.
 */
export type LiveAppAnnotationDigest = {
  id: string;
  type: string;
  page: number;
  text?: string;
  quote?: string;
  thread?: LiveAppThreadTurn[];
};

export type LiveAppContext = {
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
    rotation: 0 | 90 | 180 | 270;
  };
  annotationCount: number;
  dirty: boolean;
  /**
   * Readable annotations only — shorter than `annotationCount` by design.
   * `annotationsTruncated` marks the list as clipped by the app's size caps,
   * so an agent never mistakes a partial list for the whole document.
   */
  annotations?: LiveAppAnnotationDigest[];
  annotationsTruncated?: boolean;
};

export type LiveAnnotationResult = {
  documentId: string;
  sha256: string;
  pageTopologyHash: string;
  added: number;
  annotationIds: string[];
  dryRun: boolean;
  annotationCount: number;
  operationId: string;
  /** The app had this operation's receipt, so it re-added nothing. */
  alreadyApplied?: true;
};

export type LiveSuccessEnvelope = {
  schema: typeof LIVE_SCHEMA;
  ok: true;
  data: unknown;
};

export type LiveErrorEnvelope = {
  schema: typeof LIVE_SCHEMA;
  ok: false;
  error: LiveRemoteError;
};

export function parseEnvelope(value: unknown): LiveSuccessEnvelope | LiveErrorEnvelope {
  if (!isObject(value) || value.schema !== LIVE_SCHEMA || typeof value.ok !== "boolean") {
    throw unavailable("Shiori live API returned an invalid envelope");
  }
  if (value.ok === true) {
    if (!("data" in value)) {
      throw unavailable("Shiori live API success response is missing data");
    }
    return { schema: LIVE_SCHEMA, ok: true, data: value.data };
  }
  if (!isObject(value.error)) {
    throw unavailable("Shiori live API error response is invalid");
  }
  const code = value.error.code;
  const message = value.error.message;
  if (
    typeof code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ||
    typeof message !== "string" ||
    message.length === 0 ||
    message.length > 2_048
  ) {
    throw unavailable("Shiori live API error response is invalid");
  }
  return {
    schema: LIVE_SCHEMA,
    ok: false,
    error: {
      code,
      message,
      ...("details" in value.error ? { details: value.error.details } : {}),
    },
  };
}

export function parseContext(value: unknown): LiveAppContext {
  if (!isObject(value)) {
    throw unavailable("Shiori live API returned an invalid document context");
  }
  const {
    documentId,
    name,
    path,
    sha256,
    pageTopologyHash,
    pageCount,
    activePage,
    annotationCount,
    dirty,
    annotations,
    annotationsTruncated,
  } = value;
  if (
    !isBoundedString(documentId, 512) ||
    !isBoundedString(name, 4_096) ||
    (path != null && !isBoundedString(path, 32_768)) ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    typeof pageTopologyHash !== "string" ||
    !SHA256_PATTERN.test(pageTopologyHash) ||
    !isNonNegativeInteger(annotationCount) ||
    !Number.isSafeInteger(pageCount) ||
    Number(pageCount) < 1 ||
    typeof dirty !== "boolean" ||
    (activePage != null && !isObject(activePage)) ||
    (annotationsTruncated != null && typeof annotationsTruncated !== "boolean")
  ) {
    throw unavailable("Shiori live API returned an invalid document context");
  }
  const parsedAnnotations =
    annotations == null
      ? undefined
      : parseAnnotationDigest(annotations, Number(pageCount));
  let parsedActivePage: LiveAppContext["activePage"];
  if (isObject(activePage)) {
    const { page, widthPt, heightPt, rotation } = activePage;
    if (
      !Number.isSafeInteger(page) ||
      Number(page) < 1 ||
      Number(page) > Number(pageCount) ||
      !isPositiveFiniteNumber(widthPt) ||
      !isPositiveFiniteNumber(heightPt) ||
      (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270)
    ) {
      throw unavailable("Shiori live API returned an invalid active page context");
    }
    parsedActivePage = {
      page: Number(page),
      widthPt: Number(widthPt),
      heightPt: Number(heightPt),
      rotation,
    };
  }
  return {
    documentId,
    name,
    ...(typeof path === "string" ? { path } : {}),
    sha256,
    pageTopologyHash,
    pageCount: Number(pageCount),
    ...(parsedActivePage ? { activePage: parsedActivePage } : {}),
    annotationCount: Number(annotationCount),
    dirty,
    ...(parsedAnnotations ? { annotations: parsedAnnotations } : {}),
    ...(annotationsTruncated === true ? { annotationsTruncated: true } : {}),
  };
}

function parseAnnotationDigest(
  value: unknown,
  pageCount: number,
): LiveAppAnnotationDigest[] {
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_ANNOTATIONS) {
    throw unavailable("Shiori live API returned an invalid annotation digest");
  }
  return value.map((entry) => {
    if (!isObject(entry)) {
      throw unavailable("Shiori live API returned an invalid annotation digest");
    }
    const { id, type, page, text, quote, thread } = entry;
    if (
      !isBoundedString(id, 512) ||
      !isBoundedString(type, 64) ||
      !Number.isSafeInteger(page) ||
      Number(page) < 1 ||
      Number(page) > pageCount ||
      (text != null && !isBoundedString(text, MAX_CONTEXT_TEXT_CHARS)) ||
      (quote != null && !isBoundedString(quote, MAX_CONTEXT_TEXT_CHARS)) ||
      (thread != null &&
        (!Array.isArray(thread) || thread.length > MAX_CONTEXT_THREAD_TURNS))
    ) {
      throw unavailable("Shiori live API returned an invalid annotation digest");
    }
    return {
      id,
      type,
      page: Number(page),
      ...(typeof text === "string" ? { text } : {}),
      ...(typeof quote === "string" ? { quote } : {}),
      ...(Array.isArray(thread)
        ? { thread: thread.map(parseThreadTurn) }
        : {}),
    };
  });
}

function parseThreadTurn(value: unknown): LiveAppThreadTurn {
  if (!isObject(value)) {
    throw unavailable("Shiori live API returned an invalid annotation digest");
  }
  const { role, author, text } = value;
  if (
    (role !== "user" && role !== "agent") ||
    !isBoundedString(text, MAX_CONTEXT_TEXT_CHARS) ||
    (author != null && !isBoundedString(author, 256))
  ) {
    throw unavailable("Shiori live API returned an invalid annotation digest");
  }
  return {
    role,
    ...(typeof author === "string" ? { author } : {}),
    text,
  };
}

export function parseAnnotationResult(value: unknown): LiveAnnotationResult {
  if (!isObject(value)) {
    throw unavailable("Shiori live API returned an invalid annotation result");
  }
  const {
    documentId,
    sha256,
    pageTopologyHash,
    added,
    annotationIds,
    dryRun,
    annotationCount,
    operationId,
    alreadyApplied,
  } = value;
  if (
    !isBoundedString(documentId, 512) ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    typeof pageTopologyHash !== "string" ||
    !SHA256_PATTERN.test(pageTopologyHash) ||
    !isNonNegativeInteger(added) ||
    !Array.isArray(annotationIds) ||
    annotationIds.length > MAX_ANNOTATIONS_PER_SPEC ||
    annotationIds.some((id) => !isBoundedString(id, 512)) ||
    new Set(annotationIds).size !== annotationIds.length ||
    typeof dryRun !== "boolean" ||
    !isNonNegativeInteger(annotationCount) ||
    typeof operationId !== "string" ||
    !SHA256_PATTERN.test(operationId) ||
    (alreadyApplied !== undefined && alreadyApplied !== true)
  ) {
    throw unavailable("Shiori live API returned an invalid annotation result");
  }
  return {
    documentId,
    sha256,
    pageTopologyHash,
    added: Number(added),
    annotationIds,
    dryRun,
    annotationCount: Number(annotationCount),
    operationId,
    ...(alreadyApplied === true ? { alreadyApplied: true as const } : {}),
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1_000_000
  );
}
