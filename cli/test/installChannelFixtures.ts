import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shiori-cli-channel-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function serveCliArchive(archive: Uint8Array, target: string) {
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

export function makeArchive(
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
  // Like a real package, the archive carries the inventory its installs are
  // checked against.
  const listed = [executable, ...Object.keys(files)];
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      files: listed.map((path) => ({ path, size: statSync(join(dir, path)).size })),
    }),
  );
  const entries = [
    executable,
    "manifest.json",
    ...new Set(Object.keys(files).map((path) => path.split("/")[0])),
  ];
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
export function makeTruncatedArchive(dir: string, executable: string): Uint8Array {
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

export function curlInstallerEnv(dir: string, port: number | undefined) {
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
