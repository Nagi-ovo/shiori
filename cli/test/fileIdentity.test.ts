import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  FileIdentityUnverifiableError,
  compareFileIdentities,
  readFileIdentity,
  type FileIdentity,
} from "../src/fileIdentity";

function identity(
  canonicalPath: string,
  dev: bigint,
  ino: bigint,
): FileIdentity {
  return { canonicalPath, dev, ino };
}

describe("CLI file identity", () => {
  test("canonical paths prove aliases even when inode reporting is unavailable", () => {
    expect(
      compareFileIdentities(
        identity("/canonical/document.pdf", 0n, 0n),
        identity("/canonical/document.pdf", 1n, 0n),
      ),
    ).toBe("same");
  });

  test("device and inode identify hard-link aliases", () => {
    expect(
      compareFileIdentities(
        identity("/one.pdf", 4n, 9n),
        identity("/two.pdf", 4n, 9n),
      ),
    ).toBe("same");
    expect(
      compareFileIdentities(
        identity("/one.pdf", 4n, 9n),
        identity("/two.pdf", 4n, 10n),
      ),
    ).toBe("different");
  });

  test("fails closed when distinct canonical paths have a zero inode", () => {
    expect(() =>
      compareFileIdentities(
        identity("/one.pdf", 4n, 0n),
        identity("/two.pdf", 4n, 10n),
      ),
    ).toThrow(FileIdentityUnverifiableError);
  });

  test("resolves real filesystem hard links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-file-identity-"));
    try {
      const original = join(dir, "original.pdf");
      const alias = join(dir, "alias.pdf");
      await writeFile(original, "pdf bytes");
      await link(original, alias);

      expect(
        compareFileIdentities(
          await readFileIdentity(original),
          await readFileIdentity(alias),
        ),
      ).toBe("same");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
