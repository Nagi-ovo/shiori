import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import {
  MAX_ANNOTATION_SPEC_BYTES,
  MAX_ANNOTATIONS_PER_SPEC,
  annotationSpecViolation,
} from "./annotationSpec";
import {
  CanonicalJsonError,
  liveOperationCanonicalPayload,
} from "./liveOperation";

const LIVE_SCHEMA = "shiori.live/v1" as const;
const DESCRIPTOR_NAME = "live-api.json";
// Mirrors instance_descriptor_name() in src-tauri/src/live_api.rs.
const INSTANCE_PREFIX = "live-api.";
const INSTANCE_SUFFIX = ".json";
const APP_CACHE_DIRECTORY = "fun.nagi.shiori";
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
// Native waits up to 30 seconds for the frontend to finish an annotation
// request. The client deadline must be later so it never reports a timeout
// while Shiori can still commit the mutation.
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// Reaching the socket is the only way to tell a live Shiori from an unrelated
// process that recycled a dead one's pid. Named so the retry below can
// recognise exactly that failure and nothing else.
const CONNECT_FAILURE_MESSAGE = "Could not connect to Shiori live API";
// Mirrors of the app-side digest caps (src/live/annotationDigest.ts and
// live_api.rs). The CLI rechecks them so a truncation bug anywhere upstream
// surfaces as a loud contract failure instead of an unbounded printout.
const MAX_CONTEXT_ANNOTATIONS = 200;
const MAX_CONTEXT_THREAD_TURNS = 12;
const MAX_CONTEXT_TEXT_CHARS = 1024;

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

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

export type LiveAppDescriptor = {
  schema: typeof LIVE_SCHEMA;
  port: number;
  token: string;
  pid: number;
  appVersion?: string;
};

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
};

export type LiveAppClientOptions = {
  descriptorPath?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
};

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

type LiveSuccessEnvelope = {
  schema: typeof LIVE_SCHEMA;
  ok: true;
  data: unknown;
};

type LiveErrorEnvelope = {
  schema: typeof LIVE_SCHEMA;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type HttpResponse = {
  status: number;
  value: unknown;
};

export function resolveLiveAppDescriptorPath(
  options: Pick<
    LiveAppClientOptions,
    "descriptorPath" | "platform" | "env" | "homeDir"
  > = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const override = options.descriptorPath ?? env.SHIORI_LIVE_API_DESCRIPTOR;
  if (override != null) {
    if (!override || !paths.isAbsolute(override)) {
      throw new LiveAppError(
        "ERR_APP_UNAVAILABLE",
        "Shiori live API descriptor override must be an absolute path",
      );
    }
    return override;
  }

  const home = options.homeDir ?? homedir();
  if (platform === "darwin") {
    return paths.join(
      home,
      "Library",
      "Caches",
      APP_CACHE_DIRECTORY,
      DESCRIPTOR_NAME,
    );
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData || !win32.isAbsolute(localAppData)) {
      throw new LiveAppError(
        "ERR_APP_UNAVAILABLE",
        "Windows local app data directory is unavailable",
      );
    }
    return paths.join(localAppData, APP_CACHE_DIRECTORY, DESCRIPTOR_NAME);
  }
  const xdgCache = env.XDG_CACHE_HOME;
  if (xdgCache) {
    if (!paths.isAbsolute(xdgCache)) {
      throw new LiveAppError(
        "ERR_APP_UNAVAILABLE",
        "XDG cache directory must be an absolute path",
      );
    }
    return paths.join(xdgCache, APP_CACHE_DIRECTORY, DESCRIPTOR_NAME);
  }
  return paths.join(home, ".cache", APP_CACHE_DIRECTORY, DESCRIPTOR_NAME);
}

/**
 * Parse and validate one descriptor file. Deliberately does NOT check whether
 * the pid is alive: rediscovery needs to read a candidate before judging it.
 */
async function readDescriptorFile(
  path: string,
  options: LiveAppClientOptions = {},
): Promise<LiveAppDescriptor> {
  const platform = options.platform ?? process.platform;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new LiveAppError(
      "ERR_APP_UNAVAILABLE",
      "Shiori is not running or its live API is unavailable",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new LiveAppError(
      "ERR_APP_UNAVAILABLE",
      "Shiori live API descriptor is not a regular file",
    );
  }
  if (metadata.size < 2 || metadata.size > MAX_DESCRIPTOR_BYTES) {
    throw new LiveAppError(
      "ERR_APP_UNAVAILABLE",
      "Shiori live API descriptor is invalid",
    );
  }
  if (platform !== "win32" && (metadata.mode & 0o066) !== 0) {
    throw new LiveAppError(
      "ERR_APP_UNAVAILABLE",
      "Shiori live API descriptor permissions are unsafe",
    );
  }
  if (
    platform !== "win32" &&
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new LiveAppError(
      "ERR_APP_UNAVAILABLE",
      "Shiori live API descriptor is owned by a different user",
    );
  }

  let value: unknown;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags =
      platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(path, flags);
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino ||
      openedMetadata.uid !== metadata.uid ||
      openedMetadata.size !== metadata.size ||
      openedMetadata.size < 2 ||
      openedMetadata.size > MAX_DESCRIPTOR_BYTES ||
      (platform !== "win32" && (openedMetadata.mode & 0o066) !== 0)
    ) {
      throw new Error("descriptor changed size");
    }
    const { bytes, overflow } = await readOpenFileWithinLimit(
      handle,
      MAX_DESCRIPTOR_BYTES,
    );
    if (overflow || bytes.byteLength !== openedMetadata.size) {
      throw new Error("short read");
    }
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new LiveAppError(
      "ERR_APP_UNAVAILABLE",
      "Shiori live API descriptor is invalid",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (!isObject(value)) {
    throw invalidDescriptor();
  }
  const { schema, port, token, pid, appVersion } = value;
  // A well-formed descriptor from a different shiori.live schema generation
  // means CLI/app version skew, not corruption or a stopped app. Say so, or
  // agents will conclude Shiori is not running and give up.
  if (
    typeof schema === "string" &&
    schema !== LIVE_SCHEMA &&
    schema.startsWith("shiori.live/")
  ) {
    throw new LiveAppError(
      "ERR_APP_UNAVAILABLE",
      `Shiori live API schema mismatch: this CLI speaks ${LIVE_SCHEMA} but the running Shiori wrote ${schema.slice(0, 64)}`,
      "update the CLI and the app to matching versions",
    );
  }
  if (
    schema !== LIVE_SCHEMA ||
    !Number.isInteger(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535 ||
    typeof token !== "string" ||
    !SHA256_PATTERN.test(token) ||
    !Number.isInteger(pid) ||
    Number(pid) < 1 ||
    Number(pid) > 0xffff_ffff ||
    (appVersion != null &&
      (typeof appVersion !== "string" || appVersion.length === 0))
  ) {
    throw invalidDescriptor();
  }
  return {
    schema: LIVE_SCHEMA,
    port: Number(port),
    token,
    pid: Number(pid),
    ...(typeof appVersion === "string" ? { appVersion } : {}),
  };
}

async function descriptorIsAlive(
  descriptor: LiveAppDescriptor,
  options: LiveAppClientOptions,
): Promise<boolean> {
  try {
    return options.isProcessAlive
      ? await options.isProcessAlive(descriptor.pid)
      : processIsAlive(descriptor.pid);
  } catch {
    return false;
  }
}

/**
 * Every instance writes `live-api.<pid>.json` next to the shared descriptor,
 * so a shared pointer left behind by a crashed instance is recoverable: read
 * the per-instance files, drop the ones whose process is gone, and see who is
 * actually still there. Dead files are unlinked so the directory does not
 * accumulate one entry per launch forever.
 */
async function discoverLiveInstances(
  directory: string,
  options: LiveAppClientOptions,
): Promise<LiveAppDescriptor[]> {
  const paths = pathApi(options.platform ?? process.platform);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const alive: LiveAppDescriptor[] = [];
  for (const entry of entries) {
    const pid = instancePidFromFileName(entry);
    if (pid == null) continue;
    const candidatePath = paths.join(directory, entry);
    let descriptor: LiveAppDescriptor;
    try {
      descriptor = await readDescriptorFile(candidatePath, options);
    } catch {
      // Unreadable, malformed, or unsafe: not a usable instance. Leave the
      // file alone — it may belong to another user or a newer schema.
      continue;
    }
    // The filename must agree with the contents, or a file could impersonate
    // a live pid it does not own.
    if (descriptor.pid !== pid) continue;
    if (await descriptorIsAlive(descriptor, options)) {
      alive.push(descriptor);
      continue;
    }
    await unlink(candidatePath).catch(() => undefined);
  }
  return alive.sort((a, b) => a.pid - b.pid);
}

function instancePidFromFileName(fileName: string): number | null {
  if (!fileName.startsWith(INSTANCE_PREFIX)) return null;
  if (!fileName.endsWith(INSTANCE_SUFFIX)) return null;
  const digits = fileName.slice(
    INSTANCE_PREFIX.length,
    fileName.length - INSTANCE_SUFFIX.length,
  );
  if (!/^[0-9]{1,10}$/.test(digits)) return null;
  const pid = Number(digits);
  return Number.isInteger(pid) && pid >= 1 && pid <= 0xffff_ffff ? pid : null;
}

/**
 * An explicit override names one specific instance. Silently talking to a
 * different one would defeat the point of pinning it.
 */
function descriptorIsPinned(options: LiveAppClientOptions): boolean {
  const env = options.env ?? process.env;
  return (
    options.descriptorPath != null || env.SHIORI_LIVE_API_DESCRIPTOR != null
  );
}

export async function readLiveAppDescriptor(
  options: LiveAppClientOptions = {},
): Promise<LiveAppDescriptor> {
  const path = resolveLiveAppDescriptorPath(options);
  const paths = pathApi(options.platform ?? process.platform);
  const pinned = descriptorIsPinned(options);

  let shared: LiveAppDescriptor | null = null;
  let sharedError: unknown = null;
  try {
    shared = await readDescriptorFile(path, options);
  } catch (error) {
    sharedError = error;
  }
  if (shared && (await descriptorIsAlive(shared, options))) return shared;
  if (pinned) {
    if (sharedError) throw sharedError;
    throw deadDescriptorError();
  }

  const live = await discoverLiveInstances(paths.dirname(path), options);
  if (live.length === 1) return live[0]!;
  if (live.length > 1) {
    throw ambiguousInstances(
      live,
      paths.dirname(path),
      options.platform ?? process.platform,
    );
  }
  if (sharedError) throw sharedError;
  throw deadDescriptorError();
}

/**
 * Refuse to guess which running Shiori the caller meant. Raised from both
 * discovery paths — the shared pointer being dead, and a live-looking pointer
 * that turned out not to answer — so the two never disagree.
 */
function ambiguousInstances(
  candidates: LiveAppDescriptor[],
  directory: string,
  platform: NodeJS.Platform,
): LiveAppError {
  const paths = pathApi(platform);
  const pids = candidates.map((instance) => instance.pid).join(", ");
  return new LiveAppError(
    "ERR_APP_UNAVAILABLE",
    `Several Shiori instances are running (pids ${pids}) and none of them owns the shared live API descriptor`,
    `set SHIORI_LIVE_API_DESCRIPTOR to ${paths.join(directory, instanceDescriptorName(candidates[0]!.pid))} (or another listed pid) to choose one`,
  );
}

function instanceDescriptorName(pid: number): string {
  return `${INSTANCE_PREFIX}${pid}${INSTANCE_SUFFIX}`;
}

function deadDescriptorError(): LiveAppError {
  return new LiveAppError(
    "ERR_APP_UNAVAILABLE",
    "Shiori live API descriptor belongs to a process that is not running",
  );
}

export async function getLiveAppContext(
  options: LiveAppClientOptions = {},
): Promise<LiveAppContext> {
  return (await getLiveAppContextDetails(options)).context;
}

/**
 * Resolve a descriptor, run `run` against it, and if the connection itself
 * fails, rediscover once and retry against a different live instance.
 *
 * Liveness is a pid check, and a pid is reusable. When an instance crashes,
 * the shared descriptor keeps naming its pid; if the OS then hands that pid to
 * an unrelated process, the pid looks alive and the CLI would keep aiming at
 * the wrong port and token forever, even though another Shiori is running and
 * discoverable. Only trying to talk to it distinguishes the two, so the retry
 * is driven by connection failure and nothing else — not a timeout, not an
 * auth rejection, not an application error, all of which mean we did reach a
 * real Shiori.
 *
 * A pinned descriptor is never redirected.
 */
async function withLiveAppDescriptor<T>(
  options: LiveAppClientOptions,
  run: (descriptor: LiveAppDescriptor) => Promise<T>,
): Promise<T> {
  const descriptor = await readLiveAppDescriptor(options);
  try {
    return await run(descriptor);
  } catch (error) {
    if (
      descriptorIsPinned(options) ||
      !(error instanceof LiveAppError) ||
      error.message !== CONNECT_FAILURE_MESSAGE
    ) {
      throw error;
    }
    const platform = options.platform ?? process.platform;
    const directory = pathApi(platform).dirname(
      resolveLiveAppDescriptorPath(options),
    );
    const alternatives = (
      await discoverLiveInstances(directory, options)
    ).filter((candidate) => candidate.pid !== descriptor.pid);
    if (alternatives.length === 0) throw error;
    if (alternatives.length > 1) {
      throw ambiguousInstances(alternatives, directory, platform);
    }
    // Same rule readLiveAppDescriptor applies when the shared pointer is
    // simply dead: one candidate is unambiguous, several is a question only
    // the caller can answer. Picking the lowest pid here would silently
    // answer "which window?" for them — `app context` would describe one
    // document while `app annotate` targeted another.
    return run(alternatives[0]!);
  }
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

function parseEnvelope(value: unknown): LiveSuccessEnvelope | LiveErrorEnvelope {
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

function parseContext(value: unknown): LiveAppContext {
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

function parseAnnotationResult(value: unknown): LiveAnnotationResult {
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
  } = value;
  if (
    !isBoundedString(documentId, 512) ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256) ||
    typeof pageTopologyHash !== "string" ||
    !SHA256_PATTERN.test(pageTopologyHash) ||
    !isNonNegativeInteger(added) ||
    !Array.isArray(annotationIds) ||
    Number(added) > annotationIds.length ||
    annotationIds.length > MAX_ANNOTATIONS_PER_SPEC ||
    annotationIds.some((id) => !isBoundedString(id, 512)) ||
    new Set(annotationIds).size !== annotationIds.length ||
    typeof dryRun !== "boolean" ||
    !isNonNegativeInteger(annotationCount) ||
    typeof operationId !== "string" ||
    !SHA256_PATTERN.test(operationId)
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
  };
}

function remoteError(
  status: number,
  error: LiveErrorEnvelope["error"],
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
  error: LiveErrorEnvelope["error"],
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

function invalidDescriptor(): LiveAppError {
  return unavailable("Shiori live API descriptor is invalid");
}

function unavailable(message: string): LiveAppError {
  return new LiveAppError("ERR_APP_UNAVAILABLE", message);
}

function outcomeUnknown(target: LiveTarget, operationId: string): LiveAppError {
  return new LiveAppError(
    "ERR_APP_OUTCOME_UNKNOWN",
    "The annotation outcome is unknown; do not assume that nothing was applied",
    `operationId=${operationId}; documentId=${target.documentId}; sha256=${target.sha256}; pageTopologyHash=${target.pageTopologyHash}; run app context and verify both hashes before retrying the same spec with --base-sha256 ${target.sha256}`,
  );
}

async function readOpenFileWithinLimit(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<{ bytes: Buffer; overflow: boolean }> {
  const storage = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < storage.byteLength) {
    const { bytesRead } = await handle.read(
      storage,
      offset,
      storage.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return {
    bytes: storage.subarray(0, Math.min(offset, maxBytes)),
    overflow: offset > maxBytes,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
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
