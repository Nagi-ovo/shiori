import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";

export type BoundedFileFailure = "unavailable" | "not-a-file" | "too-large";

export class BoundedFileError extends Error {
  readonly reason: BoundedFileFailure;
  readonly path: string;
  readonly sizeBytes?: number;

  constructor(reason: BoundedFileFailure, path: string, sizeBytes?: number) {
    super(`Could not read ${path} (${reason})`);
    this.name = "BoundedFileError";
    this.reason = reason;
    this.path = path;
    this.sizeBytes = sizeBytes;
  }
}

export type BoundedFileReadOptions = {
  /** Optional cancellation/deadline checkpoint between fixed-size reads. */
  checkAbort?: () => void;
  /** Deterministic race-test seam; production callers leave this unset. */
  afterChunk?: (offset: number) => void | Promise<void>;
};

const READ_CHUNK_BYTES = 1024 * 1024;

type SnapshotMetadata = Pick<
  BigIntStats,
  "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs"
>;

export function isStableFileSnapshot(
  before: SnapshotMetadata,
  after: SnapshotMetadata,
  pathAfter: Pick<SnapshotMetadata, "dev" | "ino">,
  extraBytes: number,
): boolean {
  return (
    extraBytes === 0 &&
    before.ino !== 0n &&
    after.ino !== 0n &&
    pathAfter.ino !== 0n &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.dev === pathAfter.dev &&
    before.ino === pathAfter.ino
  );
}

/**
 * Open-then-fstat instead of stat-then-read-by-path, so the path cannot be
 * swapped between the check and the read: a FIFO cannot block the CLI
 * (O_NONBLOCK open plus the fstat regular-file check) and a larger file
 * cannot bypass the size limit that was validated against a stale stat.
 */
export async function readFileWithinLimit(
  path: string,
  maxBytes: number,
  options: BoundedFileReadOptions = {},
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NONBLOCK;
    try {
      handle = await open(path, flags);
    } catch {
      throw new BoundedFileError("unavailable", path);
    }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new BoundedFileError("not-a-file", path);
    }
    if (before.size > BigInt(maxBytes)) {
      throw new BoundedFileError("too-large", path, Number(before.size));
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BoundedFileError("too-large", path, Number.MAX_SAFE_INTEGER);
    }
    const expectedSize = Number(before.size);
    const storage = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < storage.byteLength) {
      options.checkAbort?.();
      const { bytesRead } = await handle.read(
        storage,
        offset,
        Math.min(READ_CHUNK_BYTES, storage.byteLength - offset),
        offset,
      );
      if (bytesRead === 0) {
        throw new BoundedFileError("unavailable", path);
      }
      offset += bytesRead;
      await options.afterChunk?.(offset);
    }
    options.checkAbort?.();
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(
      extra,
      0,
      1,
      expectedSize,
    );
    const after = await handle.stat({ bigint: true });
    const pathAfter = await stat(path, { bigint: true });
    if (!isStableFileSnapshot(before, after, pathAfter, extraBytes)) {
      throw new BoundedFileError("unavailable", path);
    }
    return storage;
  } catch (error) {
    if (error instanceof BoundedFileError) throw error;
    throw new BoundedFileError("unavailable", path);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
