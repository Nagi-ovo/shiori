import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";

export type AtomicOutputOperations = {
  link: (source: string, destination: string) => Promise<void>;
  rm: (path: string, options: { force: boolean }) => Promise<void>;
  finalize: (handle: FileHandle, mode: number) => Promise<void>;
};

const defaultOperations: AtomicOutputOperations = {
  link,
  rm,
  finalize: async (handle, mode) => {
    await handle.chmod(mode);
    await handle.sync();
  },
};

const LINK_UNSUPPORTED_ERROR_CODES = new Set([
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EXDEV",
]);

export class AtomicOutputExistsError extends Error {
  constructor() {
    super("Output already exists");
    this.name = "AtomicOutputExistsError";
  }
}

export class AtomicOutputUnsupportedError extends Error {
  constructor(code: string) {
    super(
      `This filesystem cannot publish a new output atomically (${code}); choose a new path on a local filesystem`,
    );
    this.name = "AtomicOutputUnsupportedError";
  }
}

export class AtomicOutputTempChangedError extends Error {
  constructor() {
    super("Atomic output temporary file changed before publication");
    this.name = "AtomicOutputTempChangedError";
  }
}

export class AtomicOutputPublishedOutcomeUnknownError extends Error {
  readonly outputPath: string;

  constructor(outputPath: string) {
    super(
      `Output was published but final verification failed; inspect it before retrying: ${outputPath}`,
    );
    this.name = "AtomicOutputPublishedOutcomeUnknownError";
    this.outputPath = outputPath;
  }
}

export type AtomicOutputIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  sha256: string;
};

const HASH_CHUNK_BYTES = 1024 * 1024;

export async function readAtomicOutputIdentity(
  handle: FileHandle,
): Promise<AtomicOutputIdentity> {
  const before = await handle.stat({ bigint: true });
  assertVerifiableMetadata(before);
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AtomicOutputUnsupportedError("UNVERIFIABLE_SIZE");
  }
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const size = Number(before.size);
  let position = 0;
  while (position < size) {
    const length = Math.min(chunk.byteLength, size - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead === 0) throw new AtomicOutputTempChangedError();
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  assertVerifiableMetadata(after);
  if (!sameStableMetadata(before, after)) {
    throw new AtomicOutputTempChangedError();
  }
  return {
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeNs: after.mtimeNs,
    ctimeNs: after.ctimeNs,
    sha256: hash.digest("hex"),
  };
}

/**
 * Publish a fully-written same-directory temporary file.
 *
 * `link` is the portable Node primitive that combines atomic publication with
 * no-replace semantics: unlike an existence check followed by rename, it can
 * never overwrite a destination created concurrently. Filesystems that cannot
 * hard-link fail closed: an exclusive copy would expose partial bytes and can
 * leave a truncated PDF/PNG after a crash, which is not an atomic commit.
 * Cleanup is best-effort here and repeated by the caller's finally block.
 */
export async function commitAtomicOutput(
  tempPath: string,
  outputPath: string,
  expectedTemp: AtomicOutputIdentity,
  operations: AtomicOutputOperations = defaultOperations,
): Promise<void> {
  // Open and authenticate the temp path again, then keep that descriptor open
  // across publication. This lets us verify bytes as well as inode identity;
  // dev/ino alone cannot detect an in-place overwrite by another writer.
  const verificationHandle = await open(tempPath, "r+");
  try {
    const beforePublication = await readAtomicOutputIdentity(verificationHandle);
    if (!sameSnapshot(beforePublication, expectedTemp)) {
      throw new AtomicOutputTempChangedError();
    }
    await assertAtomicOutputPathSnapshot(tempPath, expectedTemp);
    try {
      await operations.link(tempPath, outputPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        throw new AtomicOutputExistsError();
      }
      if (code && LINK_UNSUPPORTED_ERROR_CODES.has(code)) {
        throw new AtomicOutputUnsupportedError(code);
      }
      throw error;
    }

    try {
      const afterPublication =
        await readAtomicOutputIdentity(verificationHandle);
      if (!samePublishedContent(afterPublication, expectedTemp)) {
        throw new AtomicOutputPublishedOutcomeUnknownError(outputPath);
      }
      await assertAtomicOutputPathSnapshot(outputPath, afterPublication);

      // Temp files remain owner-only until their bytes and destination path are
      // authenticated. Only then expose the ordinary create-mode permissions.
      await operations.finalize(verificationHandle, 0o666 & ~process.umask());
      const finalSnapshot =
        await readAtomicOutputIdentity(verificationHandle);
      if (!samePublishedContent(finalSnapshot, expectedTemp)) {
        throw new AtomicOutputPublishedOutcomeUnknownError(outputPath);
      }
      await assertAtomicOutputPathSnapshot(outputPath, finalSnapshot);
    } catch (error) {
      if (error instanceof AtomicOutputPublishedOutcomeUnknownError) throw error;
      // Once link() succeeds, any later failure has an ambiguous external
      // outcome: the path exists, but its final bytes or permissions may not
      // be the ones the CLI authenticated. Never report a plain write error.
      throw new AtomicOutputPublishedOutcomeUnknownError(outputPath);
    }

    // The destination is already durable as a link to the completed inode. A
    // failed temp cleanup must not turn a successful publication into a false
    // error; the caller's finally block retries removal.
    await operations.rm(tempPath, { force: true }).catch(() => undefined);
  } finally {
    await verificationHandle.close().catch(() => undefined);
  }
}

async function assertAtomicOutputPathSnapshot(
  path: string,
  expected: AtomicOutputIdentity,
): Promise<void> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch {
    throw new AtomicOutputTempChangedError();
  }
  if (
    !metadata.isFile() ||
    metadata.ino === 0n ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino ||
    metadata.size !== expected.size ||
    metadata.mtimeNs !== expected.mtimeNs ||
    metadata.ctimeNs !== expected.ctimeNs
  ) {
    throw new AtomicOutputTempChangedError();
  }
}

function assertVerifiableMetadata(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.ino === 0n) {
    throw new AtomicOutputUnsupportedError("UNVERIFIABLE_IDENTITY");
  }
}

function sameStableMetadata(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function sameSnapshot(
  a: AtomicOutputIdentity,
  b: AtomicOutputIdentity,
): boolean {
  return (
    samePublishedContent(a, b) &&
    a.ctimeNs === b.ctimeNs
  );
}

function samePublishedContent(
  a: AtomicOutputIdentity,
  b: AtomicOutputIdentity,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.sha256 === b.sha256
  );
}

/**
 * Create the temp inode used for an output commit. Existing destinations fail
 * closed until the distribution ships a descriptor-based native replacement
 * helper; path-based metadata copies are not a safe fallback.
 */
export async function openAtomicOutputTemp(
  tempPath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(tempPath, "wx+", 0o600);
  try {
    // A restrictive umask may remove owner bits. Restore exactly 0600 through
    // the already-open descriptor without ever making the path more public.
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Return the permissions of an existing regular file without hiding errors. */
export async function regularFileModeIfExists(
  path: string,
): Promise<number | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) return null;
    return metadata.mode & 0o777;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
