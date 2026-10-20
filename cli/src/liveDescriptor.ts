// Finding the running Shiori: where its live API descriptor lives on each
// platform, how a descriptor is read and trusted, and how the CLI recovers
// when the shared descriptor names a crashed or recycled instance. Split out
// of liveApp.ts, which re-exports the public API.
import { constants } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { LiveAppError, invalidDescriptor } from "./liveAppError";
import { LIVE_SCHEMA, SHA256_PATTERN, isObject } from "./liveWire";

const DESCRIPTOR_NAME = "live-api.json";
// Mirrors instance_descriptor_name() in src-tauri/src/live_api.rs.
const INSTANCE_PREFIX = "live-api.";
const INSTANCE_SUFFIX = ".json";
const APP_CACHE_DIRECTORY = "fun.nagi.shiori";
const MAX_DESCRIPTOR_BYTES = 16 * 1024;

// Reaching the socket is the only way to tell a live Shiori from an unrelated
// process that recycled a dead one's pid. Named so the retry below can
// recognise exactly that failure and nothing else.
export const CONNECT_FAILURE_MESSAGE = "Could not connect to Shiori live API";

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

export type LiveAppDescriptor = {
  schema: typeof LIVE_SCHEMA;
  port: number;
  token: string;
  pid: number;
  appVersion?: string;
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
export async function withLiveAppDescriptor<T>(
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

export async function readOpenFileWithinLimit(
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
