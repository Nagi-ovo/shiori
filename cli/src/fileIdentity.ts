import { realpath, stat } from "node:fs/promises";

export type FileIdentity = {
  /** Canonical path after resolving every symlink in the existing path. */
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
};

export class FileIdentityUnverifiableError extends Error {
  constructor() {
    super("Filesystem did not provide a usable file identity");
    this.name = "FileIdentityUnverifiableError";
  }
}

/** Resolve symlinks before reading the underlying file identity. */
export async function readFileIdentity(path: string): Promise<FileIdentity> {
  const canonicalPath = await realpath(path);
  const metadata = await stat(canonicalPath, { bigint: true });
  return {
    canonicalPath,
    dev: metadata.dev,
    ino: metadata.ino,
  };
}

/**
 * Compare canonical paths first, then device/inode for hard-link aliases.
 * A zero inode cannot prove that two different canonical paths are distinct,
 * so callers that protect user data must fail closed.
 */
export function compareFileIdentities(
  left: FileIdentity,
  right: FileIdentity,
): "same" | "different" {
  if (left.canonicalPath === right.canonicalPath) return "same";
  if (left.ino === 0n || right.ino === 0n) {
    throw new FileIdentityUnverifiableError();
  }
  return left.dev === right.dev && left.ino === right.ino
    ? "same"
    : "different";
}
