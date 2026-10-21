import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { detectCliInstallTarget } from "../distribution";
import { ensureCliBinary } from "../npm/install.mjs";
import {
  makeArchive,
  makeTruncatedArchive,
  serveCliArchive,
  withTempDir,
} from "./installChannelFixtures";

describe("CLI install channel: npm runner", () => {
  const target = detectCliInstallTarget(process.platform, process.arch);
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  // An interrupted or failed extraction must not become the cache: the
  // runner used to extract in place and then trust any directory holding the
  // executable, so the next run kept launching the half-installed binary.
  test("npm runner never caches a failed extraction", async () => {
    if (!target) return;
    await withTempDir(async (dir) => {
      const executable = target.startsWith("win32") ? "shiori.exe" : "shiori";
      const env = { SHIORI_CLI_HOME: join(dir, ".shiori"), SHIORI_CLI_ALLOW_HTTP: "1" };
      const truncated = await serveCliArchive(
        makeTruncatedArchive(mkdtempSync(join(dir, "bad-")), executable),
        target,
      );
      servers.push(truncated.server);
      await expect(
        ensureCliBinary({ api: `http://127.0.0.1:${truncated.server.port}/api/cli`, env, target }),
      ).rejects.toThrow();

      const good = await serveCliArchive(
        makeArchive(mkdtempSync(join(dir, "good-")), executable),
        target,
      );
      servers.push(good.server);
      const binary = await ensureCliBinary({
        api: `http://127.0.0.1:${good.server.port}/api/cli`,
        env,
        target,
      });
      expect(readFileSync(binary, "utf8")).toContain("shiori-ok");
    });
  });

  // What an interrupted run of the old in-place runner left on disk: the
  // executable without the rest of the package. It has to be replaced, not
  // launched.
  test("npm runner replaces a half-extracted version directory", async () => {
    if (!target) return;
    await withTempDir(async (dir) => {
      const executable = target.startsWith("win32") ? "shiori.exe" : "shiori";
      const home = join(dir, ".shiori");
      mkdirSync(join(home, "cli", "0.1.25"), { recursive: true });
      writeFileSync(join(home, "cli", "0.1.25", executable), "#!/bin/sh\necho shiori-partial\n");
      const { server } = await serveCliArchive(makeArchive(dir, executable), target);
      servers.push(server);
      const binary = await ensureCliBinary({
        api: `http://127.0.0.1:${server.port}/api/cli`,
        env: { SHIORI_CLI_HOME: home, SHIORI_CLI_ALLOW_HTTP: "1" },
        target,
      });
      expect(readFileSync(binary, "utf8")).toContain("shiori-ok");
    });
  });

  // The curl and PowerShell installers extract in place and leave no marker.
  // Their directory can be reused only when it holds everything the
  // package's manifest lists at full size: tar stopped inside the engine
  // addon leaves the addon there but short, and a run launching that tree
  // fails every PDF command.
  test("npm runner reuses a whole curl install and replaces a cut-short one", async () => {
    if (!target) return;
    await withTempDir(async (dir) => {
      const executable = target.startsWith("win32") ? "shiori.exe" : "shiori";
      const { server } = await serveCliArchive(
        makeArchive(mkdtempSync(join(dir, "pkg-")), executable),
        target,
      );
      servers.push(server);
      const packaged: Record<string, string> = {
        [executable]: "#!/bin/sh\necho shiori-curl\n",
        "native/shiori_core.node": "a".repeat(4096),
        "assets/fonts/NotoSansSC-Regular.otf": "f".repeat(4096),
      };
      // `extracted` maps each path tar got to before it stopped to how many
      // of its bytes landed.
      const seedCurlInstall = (home: string, extracted: Record<string, number>) => {
        const version = join(home, "cli", "0.1.25");
        for (const [path, length] of Object.entries(extracted)) {
          mkdirSync(dirname(join(version, path)), { recursive: true });
          writeFileSync(join(version, path), packaged[path].slice(0, length));
        }
        writeFileSync(
          join(version, "manifest.json"),
          JSON.stringify({
            schema: "shiori.cli-distribution/v2",
            files: Object.entries(packaged).map(([path, body]) => ({
              path,
              size: Buffer.byteLength(body),
              sha256: createHash("sha256").update(body).digest("hex"),
            })),
          }),
        );
      };
      const install = (home: string) =>
        ensureCliBinary({
          api: `http://127.0.0.1:${server.port}/api/cli`,
          env: { SHIORI_CLI_HOME: home, SHIORI_CLI_ALLOW_HTTP: "1" },
          target,
        });

      const whole = join(dir, "whole");
      seedCurlInstall(
        whole,
        Object.fromEntries(Object.entries(packaged).map(([path, body]) => [path, body.length])),
      );
      expect(readFileSync(await install(whole), "utf8")).toContain("shiori-curl");

      const cut = join(dir, "cut");
      seedCurlInstall(cut, {
        [executable]: packaged[executable].length,
        "native/shiori_core.node": 1024,
      });
      expect(readFileSync(await install(cut), "utf8")).toContain("shiori-ok");
    });
  });

  // The archive used to go through a fixed name in the shared temp
  // directory, written with a plain truncate-and-write: whatever sat at that
  // name, another user's file or a symlink to one of ours, got the bytes.
  test.skipIf(process.platform === "win32")(
    "npm runner writes nothing through a predictable temp path",
    async () => {
      if (!target) return;
      await withTempDir(async (dir) => {
        const { server } = await serveCliArchive(makeArchive(dir, "shiori"), target);
        servers.push(server);
        const fakeTmp = join(dir, "tmp");
        mkdirSync(fakeTmp);
        const victim = join(dir, "victim.txt");
        writeFileSync(victim, "keep me");
        symlinkSync(victim, join(fakeTmp, `shiori-cli-0.1.25-${target}.tar.gz`));
        const previousTmp = process.env.TMPDIR;
        process.env.TMPDIR = fakeTmp;
        try {
          await ensureCliBinary({
            api: `http://127.0.0.1:${server.port}/api/cli`,
            env: { SHIORI_CLI_HOME: join(dir, ".shiori"), SHIORI_CLI_ALLOW_HTTP: "1" },
            target,
          });
        } finally {
          if (previousTmp === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = previousTmp;
        }
        expect(readFileSync(victim, "utf8")).toBe("keep me");
      });
    },
  );

  test("npm runner caches the same archive the curl installer gets", async () => {
    if (!target) return;
    await withTempDir(async (dir) => {
      const archive = makeArchive(
        dir,
        target.startsWith("win32") ? "shiori.exe" : "shiori",
      );
      const { server } = await serveCliArchive(archive, target);
      servers.push(server);
      const binary = await ensureCliBinary({
        api: `http://127.0.0.1:${server.port}/api/cli`,
        env: { SHIORI_CLI_HOME: join(dir, ".shiori"), SHIORI_CLI_ALLOW_HTTP: "1" },
        target,
      });
      // The stand-in "binary" is a shell script. Windows cannot execute one
      // named .exe — it is not a PE image — so there the assertion is that
      // the right bytes landed at the cached path, which is what this test
      // is actually about. Running it is a bonus the POSIX runners get.
      expect(existsSync(binary)).toBe(true);
      if (process.platform === "win32") {
        expect(readFileSync(binary, "utf8")).toContain("shiori-ok");
        return;
      }
      const result = spawnSync(binary, [], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("shiori-ok");
    });
  });
});
