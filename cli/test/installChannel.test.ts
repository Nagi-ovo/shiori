import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectCliInstallTarget } from "../distribution";
import {
  curlInstallerEnv,
  makeArchive,
  makeTruncatedArchive,
  serveCliArchive,
  withTempDir,
} from "./installChannelFixtures";

const installSh = join(import.meta.dir, "..", "installer", "install.sh");
const installPs1 = join(import.meta.dir, "..", "installer", "install.ps1");
const powershell = Bun.which("pwsh") ?? Bun.which("powershell");

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
});
