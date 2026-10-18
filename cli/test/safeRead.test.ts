import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BoundedFileError,
  isStableFileSnapshot,
  readFileWithinLimit,
} from "../src/safeRead";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-safe-read-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("bounded file reads", () => {
  test("fails closed if the opened path is replaced during the read", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "input.bin");
      const moved = join(dir, "original.bin");
      const expected = Buffer.alloc(2 * 1024 * 1024, 0x61);
      await writeFile(path, expected);

      await expect(
        readFileWithinLimit(path, expected.byteLength, {
          afterChunk: async (offset) => {
            if (offset !== 1024 * 1024) return;
            await rename(path, moved);
            await writeFile(path, "replacement path contents");
          },
        }),
      ).rejects.toMatchObject({
        name: "BoundedFileError",
        reason: "unavailable",
      });
      await expect(readFile(path, "utf8")).resolves.toBe(
        "replacement path contents",
      );
    });
  });

  test("rejects growth and truncation during a read", async () => {
    await withTempDir(async (dir) => {
      const grown = join(dir, "grown.bin");
      const truncated = join(dir, "truncated.bin");
      const bytes = Buffer.alloc(2 * 1024 * 1024, 0x62);
      await writeFile(grown, bytes);
      await writeFile(truncated, bytes);

      await expect(
        readFileWithinLimit(grown, bytes.byteLength + 1, {
          afterChunk: async (offset) => {
            if (offset === 1024 * 1024) await appendFile(grown, "x");
          },
        }),
      ).rejects.toMatchObject({
        name: "BoundedFileError",
        reason: "unavailable",
      });
      await expect(
        readFileWithinLimit(truncated, bytes.byteLength, {
          afterChunk: async (offset) => {
            if (offset === 1024 * 1024) await truncate(truncated, 1);
          },
        }),
      ).rejects.toBeInstanceOf(BoundedFileError);
    });
  });

  test("checks the size before allocating the destination buffer", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "large.bin");
      await writeFile(path, "12345");
      await expect(readFileWithinLimit(path, 4)).rejects.toMatchObject({
        name: "BoundedFileError",
        reason: "too-large",
        sizeBytes: 5,
      });
    });
  });

  test("treats a zero inode as unverifiable instead of equal", () => {
    const metadata = {
      dev: 1n,
      ino: 0n,
      size: 5n,
      mtimeNs: 10n,
      ctimeNs: 11n,
    };
    expect(isStableFileSnapshot(metadata, metadata, metadata, 0)).toBe(false);
  });
});
