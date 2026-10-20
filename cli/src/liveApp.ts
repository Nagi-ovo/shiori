import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:http";
import {
  MAX_ANNOTATION_SPEC_BYTES,
  annotationSpecViolation,
} from "./annotationSpec";
import {
  CanonicalJsonError,
  liveOperationCanonicalPayload,
} from "./liveOperation";
import { LiveAppError, remoteError, unavailable } from "./liveAppError";
import {
  CONNECT_FAILURE_MESSAGE,
  readLiveAppDescriptor,
  readOpenFileWithinLimit,
  withLiveAppDescriptor,
  type LiveAppClientOptions,
  type LiveAppDescriptor,
} from "./liveDescriptor";
import {
  SHA256_PATTERN,
  isObject,
  parseAnnotationResult,
  parseContext,
  parseEnvelope,
  type LiveAnnotationResult,
  type LiveAppContext,
  type LiveErrorEnvelope,
  type LiveSuccessEnvelope,
} from "./liveWire";

export { LiveAppError, type LiveAppErrorCode } from "./liveAppError";
export {
  readLiveAppDescriptor,
  resolveLiveAppDescriptorPath,
  type LiveAppClientOptions,
  type LiveAppDescriptor,
} from "./liveDescriptor";
export type {
  LiveAnnotationResult,
  LiveAppAnnotationDigest,
  LiveAppContext,
  LiveAppThreadTurn,
} from "./liveWire";

// Native waits up to 30 seconds for the frontend to finish an annotation
// request. The client deadline must be later so it never reports a timeout
// while Shiori can still commit the mutation.
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export type LiveAnnotateOptions = LiveAppClientOptions & {
  dryRun?: boolean;
  baseSha256?: string;
  /** In-memory spec (e.g. synthesized from --highlight); replaces specPath. */
  spec?: Record<string, unknown>;
};

export type LiveAnnotateResponse = {
  context: LiveAppContext;
  data: LiveAnnotationResult;
};

type LiveTarget = Pick<
  LiveAppContext,
  "documentId" | "sha256" | "pageTopologyHash"
>;

type HttpResponse = {
  status: number;
  value: unknown;
};

export async function getLiveAppContext(
  options: LiveAppClientOptions = {},
): Promise<LiveAppContext> {
  return (await getLiveAppContextDetails(options)).context;
}

export async function getLiveAppContextDetails(
  options: LiveAppClientOptions = {},
): Promise<{ context: LiveAppContext; appVersion?: string }> {
  return withLiveAppDescriptor(options, async (descriptor) => {
    const context = await requestLiveAppContext(descriptor, options);
    return {
      context,
      ...(descriptor.appVersion ? { appVersion: descriptor.appVersion } : {}),
    };
  });
}

export async function annotateLiveApp(
  specPath: string | null,
  options: LiveAnnotateOptions = {},
): Promise<LiveAnnotateResponse> {
  const descriptor = await readLiveAppDescriptor(options);
  // Read context first so every mutation is anchored to the document the user
  // can currently see. The server rechecks this same target during POST.
  const context = await requestLiveAppContext(descriptor, options);
  const expectedHash = options.baseSha256?.trim().toLowerCase();
  if (expectedHash != null) {
    if (!SHA256_PATTERN.test(expectedHash) || expectedHash !== context.sha256) {
      throw new LiveAppError(
        "ERR_APP_TARGET_CHANGED",
        "The active Shiori document does not match --base-sha256",
      );
    }
  }
  let spec: Record<string, unknown>;
  if (options.spec !== undefined) {
    spec = options.spec;
  } else if (specPath != null) {
    spec = await readAnnotationSpec(specPath);
  } else {
    throw new LiveAppError(
      "ERR_FILE_UNAVAILABLE",
      "An annotation spec path or in-memory spec is required",
    );
  }
  // Cheap local pre-validation with the same shared rules the app enforces:
  // count/text-budget violations fail here with a precise message instead of
  // costing a round trip that reports a generic rejection.
  const violation = Array.isArray(spec.annotations)
    ? annotationSpecViolation(spec.annotations)
    : "Spec must include an annotations array";
  if (violation) {
    throw new LiveAppError("ERR_SPEC_INVALID", violation);
  }
  const target = {
    documentId: context.documentId,
    sha256: context.sha256,
    pageTopologyHash: context.pageTopologyHash,
  };
  const operationId = liveOperationId(
    context.sha256,
    context.pageTopologyHash,
    spec,
  );
  let response: HttpResponse;
  try {
    response = await requestJson(
      descriptor,
      "POST",
      "/v1/annotations",
      { target, operationId, spec, dryRun: options.dryRun === true },
      options,
    );
  } catch (error) {
    if (error instanceof LiveAppError) throw outcomeUnknown(target, operationId);
    throw error;
  }
  let envelope: LiveSuccessEnvelope | LiveErrorEnvelope;
  try {
    envelope = parseEnvelope(response.value);
  } catch (error) {
    if (error instanceof LiveAppError) throw outcomeUnknown(target, operationId);
    throw error;
  }
  if (!envelope.ok) {
    if (
      response.status === 500 ||
      response.status === 504 ||
      envelope.error.code === "INTERNAL" ||
      envelope.error.code === "REQUEST_TIMEOUT"
    ) {
      throw outcomeUnknown(target, operationId);
    }
    throw remoteError(response.status, envelope.error, descriptor.token);
  }
  if (response.status < 200 || response.status >= 300) {
    throw outcomeUnknown(target, operationId);
  }
  let data: LiveAnnotationResult;
  try {
    data = parseAnnotationResult(envelope.data);
  } catch (error) {
    if (error instanceof LiveAppError) throw outcomeUnknown(target, operationId);
    throw error;
  }
  const operationAnnotationCount = Array.isArray(spec.annotations)
    ? spec.annotations.length
    : null;
  if (
    operationAnnotationCount == null ||
    data.annotationIds.length !== operationAnnotationCount
  ) {
    throw outcomeUnknown(target, operationId);
  }
  if (data.operationId !== operationId) throw outcomeUnknown(target, operationId);
  if (
    data.documentId !== target.documentId ||
    data.sha256 !== target.sha256 ||
    data.pageTopologyHash !== target.pageTopologyHash
  ) {
    throw outcomeUnknown(target, operationId);
  }
  if (data.dryRun !== (options.dryRun === true)) {
    throw outcomeUnknown(target, operationId);
  }
  return { context, data };
}

export function liveOperationId(
  sha256: string,
  pageTopologyHash: string,
  spec: unknown,
): string {
  if (!SHA256_PATTERN.test(sha256) || !SHA256_PATTERN.test(pageTopologyHash)) {
    throw new LiveAppError("ERR_SPEC_INVALID", "Operation target hash is invalid");
  }
  let canonical: string;
  try {
    canonical = liveOperationCanonicalPayload(sha256, pageTopologyHash, spec);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new LiveAppError("ERR_SPEC_INVALID", error.message);
    }
    throw error;
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function requestLiveAppContext(
  descriptor: LiveAppDescriptor,
  options: LiveAppClientOptions,
): Promise<LiveAppContext> {
  const response = await requestJson(
    descriptor,
    "GET",
    "/v1/context",
    undefined,
    options,
  );
  const envelope = parseEnvelope(response.value);
  if (!envelope.ok) {
    throw remoteError(response.status, envelope.error, descriptor.token);
  }
  if (response.status < 200 || response.status >= 300) {
    throw unavailable("Shiori live API returned an invalid response status");
  }
  if (!isObject(envelope.data) || !("context" in envelope.data)) {
    throw unavailable("Shiori live API returned an invalid context response");
  }
  if (envelope.data.context === null) {
    throw new LiveAppError("ERR_APP_NO_PDF", "No PDF is open in Shiori");
  }
  return parseContext(envelope.data.context);
}

async function readAnnotationSpec(path: string): Promise<Record<string, unknown>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer;
  try {
    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NONBLOCK;
    handle = await open(path, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new LiveAppError(
        "ERR_FILE_UNAVAILABLE",
        "Annotation spec path is not a file",
      );
    }
    if (metadata.size > MAX_ANNOTATION_SPEC_BYTES) {
      throw new LiveAppError(
        "ERR_FILE_TOO_LARGE",
        "Annotation spec exceeds the 5 MiB limit",
      );
    }
    const read = await readOpenFileWithinLimit(handle, MAX_ANNOTATION_SPEC_BYTES);
    if (read.overflow) {
      throw new LiveAppError(
        "ERR_FILE_TOO_LARGE",
        "Annotation spec exceeds the 5 MiB limit",
      );
    }
    bytes = read.bytes;
  } catch (error) {
    if (error instanceof LiveAppError) throw error;
    throw new LiveAppError(
      "ERR_FILE_UNAVAILABLE",
      "Could not read annotation spec",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new LiveAppError("ERR_SPEC_INVALID", "Spec JSON is malformed");
  }
  if (!isObject(value)) {
    throw new LiveAppError("ERR_SPEC_INVALID", "Spec JSON must be an object");
  }
  return value;
}

function requestJson(
  descriptor: LiveAppDescriptor,
  method: "GET" | "POST",
  path: "/v1/context" | "/v1/annotations",
  body: unknown,
  options: LiveAppClientOptions,
): Promise<HttpResponse> {
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = positiveLimit(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const bodyBytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let responseTooLarge = false;
    const finishReject = (error: LiveAppError) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      reject(error);
    };
    // req.setTimeout below only fires after timeoutMs of socket inactivity; a
    // wedged server trickling one byte per interval defeats it. This timer is
    // the hard deadline the 35s-client > 30s-server contract depends on.
    const wallClockTimer = setTimeout(() => {
      timedOut = true;
      finishReject(unavailable("Shiori live API request timed out"));
      req.destroy();
    }, timeoutMs);
    wallClockTimer.unref?.();
    const req = request(
      {
        protocol: "http:",
        hostname: "127.0.0.1",
        family: 4,
        port: descriptor.port,
        method,
        path,
        agent: false,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${descriptor.token}`,
          ...(bodyBytes
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(bodyBytes.byteLength),
              }
            : {}),
        },
      },
      (response) => {
        const contentType = response.headers["content-type"];
        if (
          typeof contentType !== "string" ||
          !/^application\/json(?:\s*;|$)/i.test(contentType)
        ) {
          response.resume();
          finishReject(unavailable("Shiori live API did not return JSON"));
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          responseTooLarge = true;
          response.destroy();
          finishReject(unavailable("Shiori live API response exceeds the size limit"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > maxResponseBytes) {
            responseTooLarge = true;
            response.destroy();
            finishReject(
              unavailable("Shiori live API response exceeds the size limit"),
            );
            return;
          }
          chunks.push(bytes);
        });
        response.once("end", () => {
          if (settled) return;
          let value: unknown;
          try {
            value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
          } catch {
            finishReject(unavailable("Shiori live API returned malformed JSON"));
            return;
          }
          settled = true;
          clearTimeout(wallClockTimer);
          resolve({ status: response.statusCode ?? 0, value });
        });
        response.once("error", () => {
          if (!responseTooLarge) {
            finishReject(unavailable("Could not read Shiori live API response"));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      finishReject(unavailable("Shiori live API request timed out"));
      req.destroy();
    });
    req.once("error", () => {
      finishReject(
        unavailable(
          timedOut
            ? "Shiori live API request timed out"
            : CONNECT_FAILURE_MESSAGE,
        ),
      );
    });
    if (bodyBytes) req.end(bodyBytes);
    else req.end();
  });
}

function outcomeUnknown(target: LiveTarget, operationId: string): LiveAppError {
  return new LiveAppError(
    "ERR_APP_OUTCOME_UNKNOWN",
    "The annotation outcome is unknown; do not assume that nothing was applied",
    `operationId=${operationId}; documentId=${target.documentId}; sha256=${target.sha256}; pageTopologyHash=${target.pageTopologyHash}; run app context and verify both hashes before retrying the same spec with --base-sha256 ${target.sha256}`,
  );
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
