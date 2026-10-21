import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectCliInstallTarget } from "../distribution";
import { ensureCliBinary } from "../npm/install.mjs";

const installSh = join(import.meta.dir, "..", "installer", "install.sh");
const installPs1 = join(import.meta.dir, "..", "installer", "install.ps1");
const powershell = Bun.which("pwsh") ?? Bun.which("powershell");

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shiori-cli-channel-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function serveCliArchive(archive: Uint8Array, target: string) {
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/archive.tar.gz") {
        return new Response(archive, {
          headers: { "Content-Type": "application/gzip" },
        });
      }
      if (url.pathname === "/api/cli") {
        if (url.searchParams.get("format") === "env") {
          return new Response(
            [
              "SHIORI_CLI_AVAILABLE=1",
              "SHIORI_CLI_VERSION=0.1.25",
              `SHIORI_CLI_TARGET=${target}`,
              `SHIORI_CLI_URL=http://127.0.0.1:${server.port}/archive.tar.gz`,
              `SHIORI_CLI_SHA256=${sha256}`,
              "SHIORI_CLI_SIZE=1",
              "",
            ].join("\n"),
          );
        }
        return Response.json({
          schema: "shiori.cli-release/v1",
          available: true,
          version: "0.1.25",
          targets: {
            [target]: {
              url: `http://127.0.0.1:${server.port}/archive.tar.gz`,
              sha256,
              size: archive.byteLength,
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, sha256 };
}

function makeArchive(
  dir: string,
  executable: string,
  files: Record<string, string> = {},
): Uint8Array {
  const bin = join(dir, executable);
  writeFileSync(bin, "#!/bin/sh\necho shiori-ok\n");
  chmodSync(bin, 0o755);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const entries = [executable, ...new Set(Object.keys(files).map((path) => path.split("/")[0]))];
  const archive = join(dir, "shiori-cli.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, ...entries], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(packed.status).toBe(0);
  return new Uint8Array(readFileSync(archive));
}

// An archive cut off mid-stream whose digest is still the one the release
// API serves: the executable is the first entry and extracts whole, then tar
// fails on the native addon behind it. That is the state a full disk or an
// I/O error during extraction leaves, and it has to read as a failed install.
function makeTruncatedArchive(dir: string, executable: string): Uint8Array {
  writeFileSync(join(dir, executable), "#!/bin/sh\necho shiori-partial\n");
  chmodSync(join(dir, executable), 0o755);
  mkdirSync(join(dir, "native"), { recursive: true });
  writeFileSync(join(dir, "native", "shiori_core.node"), randomBytes(512 * 1024));
  const archive = join(dir, "shiori-cli-truncated.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, executable, "native"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(packed.status).toBe(0);
  const whole = readFileSync(archive);
  return new Uint8Array(whole.subarray(0, Math.floor(whole.byteLength / 2)));
}

function curlInstallerEnv(dir: string, port: number | undefined) {
  const home = join(dir, "home");
  return {
    ...process.env,
    HOME: home,
    SHIORI_CLI_HOME: join(home, ".shiori"),
    SHIORI_CLI_BIN_DIR: join(dir, "bin"),
    SHIORI_CLI_API: `http://127.0.0.1:${port}/api/cli`,
    SHIORI_CLI_ALLOW_HTTP: "1",
    SHIORI_INSTALLER_NO_SLEEP: "1",
    TERM: "dumb",
  };
}

describe("CLI install channel", () => {
  const target = detectCliInstallTarget(process.platform, process.arch);
  const servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  test("curl installer extracts the archive and links shiori", async () => {
    if (!target || process.platform === "win32") return;
    await withTempDir(async (dir) => {
      const archive = makeArchive(dir, "shiori");
      const { server } = await serveCliArchive(archive, target);
      servers.push(server);
      const home = join(dir, "home");
      const binDir = join(dir, "bin");
      const proc = Bun.spawn(["sh", installSh], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          SHIORI_CLI_HOME: join(home, ".shiori"),
          SHIORI_CLI_BIN_DIR: binDir,
          SHIORI_CLI_API: `http://127.0.0.1:${server.port}/api/cli`,
          SHIORI_CLI_ALLOW_HTTP: "1",
          SHIORI_INSTALLER_NO_SLEEP: "1",
          TERM: "dumb",
        },
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(status).toBe(0);
      expect(stdout).toContain("Installing Shiori CLI");
      const linked = spawnSync(join(binDir, "shiori"), [], { encoding: "utf8" });
      expect(linked.status).toBe(0);
      expect(linked.stdout).toContain("shiori-ok");
    });
  });

  // Piped stdout is how agents and CI run `curl ... | sh`, and it takes the
  // installer's non-animated path. A failed extraction there once linked the
  // half-extracted binary and printed "complete" with exit status 0.
  test("curl installer fails when the archive does not extract", async () => {
    if (!target || process.platform === "win32") return;
    await withTempDir(async (dir) => {
      const archive = makeTruncatedArchive(dir, "shiori");
      const { server } = await serveCliArchive(archive, target);
      servers.push(server);
      const proc = Bun.spawn(["sh", installSh], {
        stdout: "pipe",
        stderr: "pipe",
        env: curlInstallerEnv(dir, server.port),
      });
      const [stdout, status] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      expect(status).not.toBe(0);
      expect(stdout).not.toContain("complete");
      expect(existsSync(join(dir, "bin", "shiori"))).toBe(false);
    });
  });

  // The Windows half of the channel. It runs only where PowerShell and the
  // registry exist, so on a mac this describe block is one test shorter —
  // cli-verify.yml's windows-2025 and windows-11-arm rows are where it runs.
  // Bun.spawn, never spawnSync. A synchronous spawn blocks the event loop
  // that the Bun.serve above needs to answer the installer's request, so the
  // two deadlock in the same process — on Windows that hung the whole test
  // step until the job's 30-minute timeout cancelled the release.
  test.skipIf(!powershell || process.platform !== "win32")(
    "PowerShell installer puts shiori.exe on PATH beside its engine",
    async () => {
      if (!target) return;
      await withTempDir(async (dir) => {
        const archive = makeArchive(dir, "shiori.exe", {
          "native/shiori_core.node": "addon",
          "assets/fonts/NotoSansSC-Regular.otf": "font",
        });
        const { server } = await serveCliArchive(archive, target);
        servers.push(server);
        const home = join(dir, "home");
        // What an earlier installer left: a hard link in bin\ that, run from
        // PATH, looked for native\ in bin\ and never found it.
        mkdirSync(join(home, "bin"), { recursive: true });
        writeFileSync(join(home, "bin", "shiori.exe"), "stale");
        const install = async () => {
          const proc = Bun.spawn(
            [powershell!, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installPs1],
            {
              stdout: "pipe",
              stderr: "pipe",
              env: {
                ...process.env,
                SHIORI_CLI_HOME: home,
                SHIORI_CLI_API: `http://127.0.0.1:${server.port}/api/cli`,
                SHIORI_CLI_ALLOW_HTTP: "1",
                // Never rewrite the runner's user PATH from a test.
                SHIORI_CLI_SKIP_PATH: "1",
              },
            },
          );
          const [stderr, status] = await Promise.all([
            new Response(proc.stderr).text(),
            proc.exited,
            new Response(proc.stdout).text(),
          ]);
          expect(stderr).toBe("");
          expect(status).toBe(0);
        };
        // Twice: the second run replaces the cli\current junction, which
        // must not take the version directory behind it along.
        await install();
        await install();
        // The CLI finds its engine and fonts beside the path it was started
        // by (process.execPath), so they must sit beside the exe on PATH.
        const onPath = join(home, "cli", "current", "shiori.exe");
        const source = join(home, "cli", "0.1.25", "shiori.exe");
        expect(readFileSync(onPath)).toEqual(readFileSync(source));
        expect(readFileSync(join(dirname(onPath), "native", "shiori_core.node"), "utf8")).toBe(
          "addon",
        );
        expect(
          existsSync(join(dirname(onPath), "assets", "fonts", "NotoSansSC-Regular.otf")),
        ).toBe(true);
        expect(existsSync(join(home, "bin", "shiori.exe"))).toBe(false);
      });
    },
    // Two cold PowerShell starts; the arm64 runner is slow to start one.
    120_000,
  );

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
