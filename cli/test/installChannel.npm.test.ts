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

  // Several agents starting `npx @nagi-ovo/shiori` over a half-written
  // version directory each extract and then replace it. Without one run at
  // a time doing the replacing, a run deleted the tree another had just
  // published, and the others failed on a rename into a non-empty directory.
  // Skipped on Windows, where a scanner holding a handle can fail any rename.
  test.skipIf(process.platform === "win32")(
    "concurrent npm runs all recover a half-extracted version directory",
    async () => {
      if (!target) return;
      await withTempDir(async (dir) => {
        const executable = "shiori";
        const files: Record<string, string> = { "native/shiori_core.node": "addon" };
        for (let i = 0; i < 400; i++) files[`licenses/notice-${i}.txt`] = "notice";
        const { server } = await serveCliArchive(
          makeArchive(mkdtempSync(join(dir, "pkg-")), executable, files),
          target,
        );
        servers.push(server);
        const home = join(dir, ".shiori");
        const partial = join(home, "cli", "0.1.25");
        mkdirSync(join(partial, "licenses"), { recursive: true });
        writeFileSync(join(partial, executable), "#!/bin/sh\necho shiori-partial\n");
        for (let i = 0; i < 400; i++) {
          writeFileSync(join(partial, "licenses", `notice-${i}.txt`), "notice");
        }
        const child = join(dir, "child.mjs");
        writeFileSync(
          child,
          [
            'import { existsSync, readFileSync } from "node:fs";',
            'import { dirname, join } from "node:path";',
            "const { ensureCliBinary } = await import(process.env.INSTALL_MJS);",
            "await new Promise((r) => setTimeout(r, Number(process.env.START_AT) - Date.now()));",
            "try {",
            "  const binary = await ensureCliBinary({",
            "    api: process.env.API, target: process.env.TARGET,",
            '    env: { SHIORI_CLI_HOME: process.env.HOME_DIR, SHIORI_CLI_ALLOW_HTTP: "1" },',
            "  });",
            '  const whole = readFileSync(binary, "utf8").includes("shiori-ok") &&',
            '    existsSync(join(dirname(binary), "native", "shiori_core.node"));',
            '  console.log(whole ? "whole" : "broken");',
            "} catch (error) {",
            "  console.log(`threw ${error.code ?? error.message}`);",
            "}",
          ].join("\n"),
        );
        const startAt = Date.now() + 1500;
        const runs = Array.from({ length: 6 }, () =>
          Bun.spawn([process.execPath, child], {
            env: {
              ...process.env,
              INSTALL_MJS: join(import.meta.dir, "..", "npm", "install.mjs"),
              API: `http://127.0.0.1:${server.port}/api/cli`,
              TARGET: target,
              HOME_DIR: home,
              START_AT: String(startAt),
            },
            stdout: "pipe",
          }),
        );
        const outcomes = await Promise.all(
          runs.map(async (run) => (await new Response(run.stdout).text()).trim()),
        );
        expect(outcomes).toEqual(Array(6).fill("whole"));
      });
    },
    30_000,
  );

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
