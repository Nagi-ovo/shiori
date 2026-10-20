// Shared fixtures for the live app client tests: a loopback server that
// plays Shiori, descriptor files, and ways to drive the CLI entry point.
// Split out of liveApp.test.ts so other suites can reuse them.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  liveOperationId,
  resolveLiveAppDescriptorPath,
  type LiveAppClientOptions,
  type LiveAppContext,
} from "../src/liveApp";
import { main } from "../src/main";

export const CLI_PATH = resolve("cli/src/main.ts");

export const TOKEN = "a".repeat(64);
export const SHA256 = "b".repeat(64);
export const OTHER_SHA256 = "c".repeat(64);
export const PAGE_TOPOLOGY_HASH = "d".repeat(64);
export const EMPTY_SPEC = { schema: "shiori.annotations/v1", annotations: [] };
export const EMPTY_OPERATION_ID = liveOperationId(
  SHA256,
  PAGE_TOPOLOGY_HASH,
  EMPTY_SPEC,
);
export const LEGACY_EMPTY_OPERATION_ID = liveOperationId(
  SHA256,
  PAGE_TOPOLOGY_HASH,
  { annotations: [] },
);
export const RETRY_SPEC = {
  schema: "shiori.annotations/v1",
  annotations: [
    { type: "note", page: 1, at: { x: 10, y: 20 }, text: "retry", color: "#f6c744" },
  ],
};
export const RETRY_OPERATION_ID = liveOperationId(
  SHA256,
  PAGE_TOPOLOGY_HASH,
  RETRY_SPEC,
);

export const CONTEXT: LiveAppContext = {
  documentId: "doc-live-test",
  name: "Live test.pdf",
  path: "/tmp/Live test.pdf",
  sha256: SHA256,
  pageTopologyHash: PAGE_TOPOLOGY_HASH,
  pageCount: 3,
  activePage: {
    page: 2,
    widthPt: 612,
    heightPt: 792,
    rotation: 0,
  },
  annotationCount: 4,
  dirty: false,
};

export type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

export async function withFixture<T>(
  handler: Handler,
  run: (fixture: { dir: string; descriptorPath: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-live-app-test-"));
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const descriptorPath = join(dir, "live-api.json");
    await writeDescriptor(descriptorPath, port);
    return await run({ dir, descriptorPath });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeDescriptor(
  path: string,
  port: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      schema: "shiori.live/v1",
      port,
      token: TOKEN,
      pid: process.pid,
      appVersion: "0.1.26",
      ...overrides,
    }),
  );
  await chmod(path, 0o600);
}

export function hostCacheFixture(root: string): {
  cacheDir: string;
  options: LiveAppClientOptions;
} {
  const options: LiveAppClientOptions =
    process.platform === "win32"
      ? { env: { LOCALAPPDATA: root } }
      : process.platform === "darwin"
        ? { env: {}, homeDir: root }
        : { env: { XDG_CACHE_HOME: root } };
  return {
    cacheDir: dirname(resolveLiveAppDescriptorPath(options)),
    options,
  };
}

export function json(
  response: ServerResponse,
  value: unknown,
  status = 200,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function captureMain(
  args: string[],
  descriptorPath?: string,
): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalDescriptor = process.env.SHIORI_LIVE_API_DESCRIPTOR;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = (message?: unknown) => errors.push(String(message ?? ""));
  if (descriptorPath) process.env.SHIORI_LIVE_API_DESCRIPTOR = descriptorPath;
  else delete process.env.SHIORI_LIVE_API_DESCRIPTOR;
  try {
    await main(args);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (originalDescriptor == null) delete process.env.SHIORI_LIVE_API_DESCRIPTOR;
    else process.env.SHIORI_LIVE_API_DESCRIPTOR = originalDescriptor;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

export async function runCli(
  args: string[],
  descriptorPath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SHIORI_LIVE_API_DESCRIPTOR: descriptorPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  return { exitCode, stdout, stderr };
}

export function contextEnvelope(context: LiveAppContext | null = CONTEXT): unknown {
  return {
    schema: "shiori.live/v1",
    ok: true,
    data: { context },
  };
}
