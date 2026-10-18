import {
  link,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AtomicOutputExistsError,
  AtomicOutputPublishedOutcomeUnknownError,
  AtomicOutputUnsupportedError,
  commitAtomicOutput,
  openAtomicOutputTemp,
  readAtomicOutputIdentity,
} from "../src/atomicOutput";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const realOperations = {
  link,
  rm: async (path: string, options: { force: boolean }) => {
    await rm(path, options);
  },
  finalize: async (
    handle: Awaited<ReturnType<typeof open>>,
    mode: number,
  ) => {
    await handle.chmod(mode);
    await handle.sync();
  },
};

async function identity(path: string) {
  const handle = await open(path, "r");
  try {
    return await readAtomicOutputIdentity(handle);
  } finally {
    await handle.close();
  }
}

describe("atomic CLI output publication", () => {
  test("never replaces a destination that exists at commit time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const temp = join(dir, ".output.tmp");
      const output = join(dir, "output.bin");
      await writeFile(temp, "new bytes");
      await writeFile(output, "important bytes");

      await expect(
        commitAtomicOutput(temp, output, await identity(temp)),
      ).rejects.toBeInstanceOf(AtomicOutputExistsError);
      await expect(readFile(output, "utf8")).resolves.toBe("important bytes");
      await expect(readFile(temp, "utf8")).resolves.toBe("new bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("publishes a complete new file without exposing a replace primitive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const firstTemp = join(dir, ".first.tmp");
      const output = join(dir, "output.bin");
      await writeFile(firstTemp, "first");
      await commitAtomicOutput(firstTemp, output, await identity(firstTemp));
      await expect(readFile(output, "utf8")).resolves.toBe("first");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed when atomic no-replace publication is unsupported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const temp = join(dir, ".output.tmp");
      const output = join(dir, "output.bin");
      await writeFile(temp, "complete bytes");

      await expect(
        commitAtomicOutput(temp, output, await identity(temp), {
          ...realOperations,
          link: async () => {
            throw errno("ENOTSUP");
          },
        }),
      ).rejects.toBeInstanceOf(AtomicOutputUnsupportedError);
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(temp, "utf8")).resolves.toBe("complete bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unsupported publication never damages an existing destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const temp = join(dir, ".output.tmp");
      const output = join(dir, "output.bin");
      await writeFile(temp, "new bytes");
      await writeFile(output, "important bytes");

      await expect(
        commitAtomicOutput(temp, output, await identity(temp), {
          ...realOperations,
          link: async () => {
            throw errno("EOPNOTSUPP");
          },
        }),
      ).rejects.toBeInstanceOf(AtomicOutputUnsupportedError);
      await expect(readFile(output, "utf8")).resolves.toBe("important bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a temp-path substitution instead of reporting attacker bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const temp = join(dir, ".output.tmp");
      const attacker = join(dir, "attacker.bin");
      const output = join(dir, "output.bin");
      await writeFile(temp, "trusted bytes");
      await writeFile(attacker, "substituted bytes");
      const handle = await open(temp, "r");
      try {
        const expected = await readAtomicOutputIdentity(handle);
        await expect(
          commitAtomicOutput(temp, output, expected, {
            ...realOperations,
            link: async (source, destination) => {
              await rm(source);
              await link(attacker, source);
              await link(source, destination);
            },
          }),
        ).rejects.toBeInstanceOf(AtomicOutputPublishedOutcomeUnknownError);
      } finally {
        await handle.close();
      }
      // The path is untrusted after the mismatch; the key guarantee is that
      // the CLI fails instead of authenticating these bytes as its output.
      await expect(readFile(output, "utf8")).resolves.toBe("substituted bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an in-place temp overwrite before reporting success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const temp = join(dir, ".output.tmp");
      const output = join(dir, "output.bin");
      await writeFile(temp, "trusted bytes");
      const expected = await identity(temp);

      await expect(
        commitAtomicOutput(temp, output, expected, {
          ...realOperations,
          link: async (source, destination) => {
            await writeFile(source, "attacker");
            await link(source, destination);
          },
        }),
      ).rejects.toBeInstanceOf(AtomicOutputPublishedOutcomeUnknownError);
      await expect(readFile(output, "utf8")).resolves.toBe("attacker");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks finalization errors after link as outcome unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const temp = join(dir, ".output.tmp");
      const output = join(dir, "output.bin");
      await writeFile(temp, "complete bytes");
      const expected = await identity(temp);

      await expect(
        commitAtomicOutput(temp, output, expected, {
          ...realOperations,
          finalize: async () => {
            throw errno("EIO");
          },
        }),
      ).rejects.toMatchObject({
        name: "AtomicOutputPublishedOutcomeUnknownError",
        outputPath: output,
      });
      await expect(readFile(output, "utf8")).resolves.toBe("complete bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reserves new-output temp names without following a symlink", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const temp = join(dir, ".output.tmp");
      const output = join(dir, "output.bin");
      const victim = join(dir, "victim.bin");
      await writeFile(output, "old output");
      await writeFile(victim, "do not touch");
      await symlink(victim, temp);

      await expect(openAtomicOutputTemp(temp)).rejects.toMatchObject(
        { code: "EEXIST" },
      );
      await expect(readFile(victim, "utf8")).resolves.toBe("do not touch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps temporary bytes owner-only until publication", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "shiori-cli-atomic-output-"));
    try {
      const temp = join(dir, ".output.tmp");
      const handle = await openAtomicOutputTemp(temp);
      try {
        expect((await stat(temp)).mode & 0o777).toBe(0o600);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
