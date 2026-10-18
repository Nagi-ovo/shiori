import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  annotateLiveApp,
  getLiveAppContext,
  liveOperationId,
  readLiveAppDescriptor,
  resolveLiveAppDescriptorPath,
  type LiveAppClientOptions,
  type LiveAppContext,
} from "../src/liveApp";
import { main } from "../src/main";

const CLI_PATH = resolve("cli/src/main.ts");

const TOKEN = "a".repeat(64);
const SHA256 = "b".repeat(64);
const OTHER_SHA256 = "c".repeat(64);
const PAGE_TOPOLOGY_HASH = "d".repeat(64);
const EMPTY_SPEC = { schema: "shiori.annotations/v1", annotations: [] };
const EMPTY_OPERATION_ID = liveOperationId(
  SHA256,
  PAGE_TOPOLOGY_HASH,
  EMPTY_SPEC,
);
const LEGACY_EMPTY_OPERATION_ID = liveOperationId(
  SHA256,
  PAGE_TOPOLOGY_HASH,
  { annotations: [] },
);
const RETRY_SPEC = {
  schema: "shiori.annotations/v1",
  annotations: [
    { type: "note", page: 1, at: { x: 10, y: 20 }, text: "retry", color: "#f6c744" },
  ],
};
const RETRY_OPERATION_ID = liveOperationId(
  SHA256,
  PAGE_TOPOLOGY_HASH,
  RETRY_SPEC,
);

const CONTEXT: LiveAppContext = {
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

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

async function withFixture<T>(
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

async function writeDescriptor(
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

function hostCacheFixture(root: string): {
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

function json(
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

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function captureMain(
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

async function runCli(
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

function contextEnvelope(context: LiveAppContext | null = CONTEXT): unknown {
  return {
    schema: "shiori.live/v1",
    ok: true,
    data: { context },
  };
}

describe("Shiori live app client", () => {
  test("validates app subcommands and command-specific arguments", async () => {
    await expect(main(["app"])).rejects.toMatchObject({
      code: "ERR_USAGE",
      message: expect.stringContaining("subcommand"),
    });
    await expect(main(["app", "unknown"])).rejects.toMatchObject({
      code: "ERR_USAGE",
      message: expect.stringContaining("Unknown app subcommand"),
    });
    await expect(main(["app", "context", "extra"])).rejects.toMatchObject({
      code: "ERR_USAGE",
      message: expect.stringContaining("Unexpected positional"),
    });
    await expect(main(["app", "context", "--dry-run"])).rejects.toMatchObject({
      code: "ERR_USAGE",
      message: expect.stringContaining("app context"),
    });
    await expect(
      main(["app", "context", "--spec", "spec.json"]),
    ).rejects.toMatchObject({ code: "ERR_USAGE" });
    await expect(
      main(["app", "context", "--base-sha256", SHA256]),
    ).rejects.toMatchObject({ code: "ERR_USAGE" });
    await expect(main(["app", "annotate"])).rejects.toMatchObject({
      code: "ERR_USAGE",
      message: expect.stringContaining("--spec"),
    });

    const help = await captureMain(["app", "annotate", "--help"]);
    expect(help.stdout).toContain("shiori app annotate --spec <spec.json>");
  });

  test("discovers platform cache descriptors exactly", () => {
    expect(
      resolveLiveAppDescriptorPath({
        platform: "darwin",
        homeDir: "/Users/test",
        env: {},
      }),
    ).toBe("/Users/test/Library/Caches/fun.nagi.shiori/live-api.json");
    expect(
      resolveLiveAppDescriptorPath({
        platform: "linux",
        homeDir: "/home/test",
        env: { XDG_CACHE_HOME: "/var/cache/test" },
      }),
    ).toBe("/var/cache/test/fun.nagi.shiori/live-api.json");
    expect(
      resolveLiveAppDescriptorPath({
        platform: "linux",
        homeDir: "/home/test",
        env: {},
      }),
    ).toBe("/home/test/.cache/fun.nagi.shiori/live-api.json");
    expect(
      resolveLiveAppDescriptorPath({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      }),
    ).toBe("C:\\Users\\test\\AppData\\Local\\fun.nagi.shiori\\live-api.json");
  });

  test("derives a canonical operation ID from target topology and spec", () => {
    const spec = {
      annotations: [{ type: "note", page: 1, at: { y: 2, x: 1 } }],
      schema: "shiori.annotations/v1",
    };
    const first = liveOperationId(SHA256, PAGE_TOPOLOGY_HASH, spec);
    const reordered = liveOperationId(SHA256, PAGE_TOPOLOGY_HASH, {
      schema: "shiori.annotations/v1",
      annotations: [{ at: { x: 1, y: 2 }, page: 1, type: "note" }],
    });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(liveOperationId(SHA256, OTHER_SHA256, spec)).not.toBe(first);

    let tooDeep: unknown = {};
    for (let depth = 0; depth < 130; depth += 1) tooDeep = { value: tooDeep };
    expect(() => liveOperationId(SHA256, PAGE_TOPOLOGY_HASH, tooDeep)).toThrow(
      expect.objectContaining({ code: "ERR_SPEC_INVALID" }),
    );
  });

  test("GET context authenticates only to the loopback descriptor port", async () => {
    await withFixture(
      (request, response) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("/v1/context");
        expect(request.socket.localAddress).toBe("127.0.0.1");
        expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
        json(response, contextEnvelope());
      },
      async ({ descriptorPath }) => {
        await expect(getLiveAppContext({ descriptorPath })).resolves.toEqual(CONTEXT);
      },
    );

  });

  test("CLI context uses the app.context agent envelope", async () => {
    await withFixture(
      (_request, response) => json(response, contextEnvelope()),
      async ({ descriptorPath }) => {
        const result = await captureMain(
          ["app", "context", "--agent"],
          descriptorPath,
        );
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain("\n");
        expect(JSON.parse(result.stdout)).toMatchObject({
          schema: "shiori.cli/v1",
          ok: true,
          command: "app.context",
          data: { documentId: CONTEXT.documentId, sha256: SHA256 },
        });
      },
    );
  });

  test("accepts a document context without an active page", async () => {
    const contextWithoutActivePage: LiveAppContext = { ...CONTEXT };
    delete contextWithoutActivePage.activePage;
    await withFixture(
      (_request, response) => json(response, contextEnvelope(contextWithoutActivePage)),
      async ({ descriptorPath }) => {
        await expect(getLiveAppContext({ descriptorPath })).resolves.toEqual(
          contextWithoutActivePage,
        );
      },
    );
  });

  test("POST annotate anchors the spec to context and preserves dry-run", async () => {
    const methods: string[] = [];
    await withFixture(
      async (request, response) => {
        methods.push(`${request.method} ${request.url}`);
        if (request.method === "GET") {
          json(response, contextEnvelope());
          return;
        }
        expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(await requestBody(request)).toEqual({
          target: {
            documentId: CONTEXT.documentId,
            sha256: SHA256,
            pageTopologyHash: PAGE_TOPOLOGY_HASH,
          },
          operationId: EMPTY_OPERATION_ID,
          spec: EMPTY_SPEC,
          dryRun: true,
        });
        json(response, {
          schema: "shiori.live/v1",
          ok: true,
          data: {
            documentId: CONTEXT.documentId,
            sha256: SHA256,
            pageTopologyHash: PAGE_TOPOLOGY_HASH,
            added: 0,
            annotationIds: [],
            dryRun: true,
            annotationCount: CONTEXT.annotationCount,
            operationId: EMPTY_OPERATION_ID,
          },
        });
      },
      async ({ dir, descriptorPath }) => {
        const specPath = join(dir, "spec.json");
        await writeFile(
          specPath,
          JSON.stringify({ schema: "shiori.annotations/v1", annotations: [] }),
        );
        const result = await annotateLiveApp(specPath, {
          descriptorPath,
          dryRun: true,
          baseSha256: SHA256,
        });
        expect(result.data).toMatchObject({ added: 0, dryRun: true });
        expect(result.context.name).toBe(CONTEXT.name);
      },
    );
    expect(methods).toEqual(["GET /v1/context", "POST /v1/annotations"]);
  });

  test("CLI annotate uses the app.annotate agent envelope", async () => {
    await withFixture(
      async (request, response) => {
        if (request.method === "GET") {
          json(response, contextEnvelope());
          return;
        }
        const body = await requestBody(request) as { dryRun?: unknown };
        expect(body.dryRun).toBe(true);
        json(response, {
          schema: "shiori.live/v1",
          ok: true,
          data: {
            documentId: CONTEXT.documentId,
            sha256: SHA256,
            pageTopologyHash: PAGE_TOPOLOGY_HASH,
            added: 0,
            annotationIds: [],
            dryRun: true,
            annotationCount: CONTEXT.annotationCount,
            operationId: LEGACY_EMPTY_OPERATION_ID,
          },
        });
      },
      async ({ dir, descriptorPath }) => {
        const specPath = join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify({ annotations: [] }));
        const result = await captureMain(
          ["app", "annotate", "--spec", specPath, "--dry-run", "--agent"],
          descriptorPath,
        );
        expect(JSON.parse(result.stdout)).toMatchObject({
          schema: "shiori.cli/v1",
          ok: true,
          command: "app.annotate",
          data: { added: 0, dryRun: true },
        });
      },
    );
  });

  test("accepts an idempotent retry with no new additions", async () => {
    await withFixture(
      (request, response) => {
        if (request.method === "GET") {
          json(response, contextEnvelope());
          return;
        }
        json(response, {
          schema: "shiori.live/v1",
          ok: true,
          data: {
            documentId: CONTEXT.documentId,
            sha256: SHA256,
            pageTopologyHash: PAGE_TOPOLOGY_HASH,
            added: 0,
            annotationIds: ["stable-operation-annotation"],
            dryRun: false,
            annotationCount: CONTEXT.annotationCount + 1,
            operationId: RETRY_OPERATION_ID,
          },
        });
      },
      async ({ dir, descriptorPath }) => {
        const specPath = join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify(RETRY_SPEC));
        await expect(
          annotateLiveApp(specPath, { descriptorPath }),
        ).resolves.toMatchObject({
          data: { added: 0, annotationIds: ["stable-operation-annotation"] },
        });
      },
    );
  });

  test("rejects a success result with the wrong operation ID count", async () => {
    await withFixture(
      (request, response) => {
        if (request.method === "GET") {
          json(response, contextEnvelope());
          return;
        }
        json(response, {
          schema: "shiori.live/v1",
          ok: true,
          data: {
            documentId: CONTEXT.documentId,
            sha256: SHA256,
            pageTopologyHash: PAGE_TOPOLOGY_HASH,
            added: 0,
            annotationIds: ["unexpected-id"],
            dryRun: false,
            annotationCount: CONTEXT.annotationCount,
            operationId: LEGACY_EMPTY_OPERATION_ID,
          },
        });
      },
      async ({ dir, descriptorPath }) => {
        const specPath = join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify({ annotations: [] }));
        await expect(
          annotateLiveApp(specPath, { descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_APP_OUTCOME_UNKNOWN" });
      },
    );
  });

  test("CLI process returns a stable app error envelope without secrets", async () => {
    await withFixture(
      (_request, response) => json(response, contextEnvelope(null)),
      async ({ descriptorPath }) => {
        const result = await runCli(
          ["app", "context", "--agent"],
          descriptorPath,
        );
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          schema: "shiori.cli/v1",
          ok: false,
          command: "app.context",
          error: { code: "ERR_APP_NO_PDF" },
        });
        expect(result.stderr).toContain("ERR_APP_NO_PDF");
        expect(`${result.stdout}${result.stderr}`).not.toContain(TOKEN);
      },
    );
  });

  test("base hash mismatch fails closed before reading or posting a spec", async () => {
    let postCount = 0;
    await withFixture(
      (request, response) => {
        if (request.method === "POST") postCount += 1;
        json(response, contextEnvelope());
      },
      async ({ dir, descriptorPath }) => {
        await expect(
          annotateLiveApp(join(dir, "missing.json"), {
            descriptorPath,
            baseSha256: OTHER_SHA256,
          }),
        ).rejects.toMatchObject({ code: "ERR_APP_TARGET_CHANGED" });
      },
    );
    expect(postCount).toBe(0);
  });

  test("rejects inconsistent or duplicate annotation result IDs", async () => {
    await withFixture(
      (request, response) => {
        if (request.method === "GET") {
          json(response, contextEnvelope());
          return;
        }
        json(response, {
          schema: "shiori.live/v1",
          ok: true,
          data: {
            documentId: CONTEXT.documentId,
            sha256: SHA256,
            pageTopologyHash: PAGE_TOPOLOGY_HASH,
            added: 2,
            annotationIds: ["same-id", "same-id"],
            dryRun: false,
            annotationCount: 6,
            operationId: LEGACY_EMPTY_OPERATION_ID,
          },
        });
      },
      async ({ dir, descriptorPath }) => {
        const specPath = join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify({ annotations: [] }));
        await expect(
          annotateLiveApp(specPath, { descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_APP_OUTCOME_UNKNOWN" });
      },
    );
  });

  test("maps no PDF and remote mutation errors to stable local codes", async () => {
    await withFixture(
      (request, response) => {
        if (request.url === "/v1/context") {
          json(response, contextEnvelope(null));
          return;
        }
        json(response, {
          schema: "shiori.live/v1",
          ok: false,
          error: { code: "SPEC_INVALID", message: "bad spec" },
        }, 422);
      },
      async ({ descriptorPath }) => {
        await expect(getLiveAppContext({ descriptorPath })).rejects.toMatchObject({
          code: "ERR_APP_NO_PDF",
        });
      },
    );

    await withFixture(
      (request, response) => {
        if (request.url === "/v1/context") {
          json(response, contextEnvelope());
          return;
        }
        json(
          response,
          {
            schema: "shiori.live/v1",
            ok: false,
            error: { code: "TARGET_CHANGED", message: "changed" },
          },
          409,
        );
      },
      async ({ dir, descriptorPath }) => {
        const specPath = join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify({ annotations: [] }));
        await expect(
          annotateLiveApp(specPath, { descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_APP_TARGET_CHANGED" });
      },
    );

    for (const [remoteCode, status, localCode] of [
      ["SPEC_INVALID", 422, "ERR_SPEC_INVALID"],
      ["OPERATION_CONFLICT", 409, "ERR_APP_OPERATION_CONFLICT"],
    ] as const) {
      await withFixture(
        (request, response) => {
          if (request.url === "/v1/context") {
            json(response, contextEnvelope());
            return;
          }
          json(
            response,
            {
              schema: "shiori.live/v1",
              ok: false,
              error: { code: remoteCode, message: "rejected" },
            },
            status,
          );
        },
        async ({ dir, descriptorPath }) => {
          const specPath = join(dir, "spec.json");
          await writeFile(specPath, JSON.stringify({ annotations: [] }));
          await expect(
            annotateLiveApp(specPath, { descriptorPath }),
          ).rejects.toMatchObject({ code: localCode });
        },
      );
    }

    for (const [reason, localCode] of [
      ["TEXT_UNAVAILABLE", "ERR_TEXT_UNAVAILABLE"],
      ["ANCHOR_UNRESOLVED", "ERR_ANCHOR_UNRESOLVED"],
    ] as const) {
      await withFixture(
        (request, response) => {
          if (request.url === "/v1/context") {
            json(response, contextEnvelope());
            return;
          }
          json(
            response,
            {
              schema: "shiori.live/v1",
              ok: false,
              error: {
                code: "SPEC_INVALID",
                message: "anchor failed",
                details: { reason },
              },
            },
            422,
          );
        },
        async ({ dir, descriptorPath }) => {
          const specPath = join(dir, "spec.json");
          await writeFile(specPath, JSON.stringify({ annotations: [] }));
          await expect(
            annotateLiveApp(specPath, { descriptorPath }),
          ).rejects.toMatchObject({ code: localCode });
        },
      );
    }
  });

  test("surfaces sanitized server messages and details, and maps APP_BUSY", async () => {
    await withFixture(
      (request, response) => {
        if (request.url === "/v1/context") {
          json(response, contextEnvelope());
          return;
        }
        json(
          response,
          {
            schema: "shiori.live/v1",
            ok: false,
            error: {
              code: "SPEC_INVALID",
              message: `annotations[3].color is invalid (token ${TOKEN})`,
              details: { index: 3, token: TOKEN },
            },
          },
          422,
        );
      },
      async ({ dir, descriptorPath }) => {
        const specPath = join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify({ annotations: [] }));
        let error: unknown;
        try {
          await annotateLiveApp(specPath, { descriptorPath });
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ code: "ERR_SPEC_INVALID" });
        const detail = (error as { detail?: string }).detail ?? "";
        expect(detail).toContain("annotations[3].color is invalid");
        expect(detail).toContain('"index":3');
        expect(detail).not.toContain(TOKEN);
      },
    );

    await withFixture(
      (request, response) => {
        if (request.url === "/v1/context") {
          json(response, contextEnvelope());
          return;
        }
        json(
          response,
          {
            schema: "shiori.live/v1",
            ok: false,
            error: { code: "APP_BUSY", message: "busy with another request" },
          },
          503,
        );
      },
      async ({ dir, descriptorPath }) => {
        const specPath = join(dir, "spec.json");
        await writeFile(specPath, JSON.stringify({ annotations: [] }));
        await expect(
          annotateLiveApp(specPath, { descriptorPath }),
        ).rejects.toMatchObject({
          code: "ERR_APP_BUSY",
          detail: expect.stringContaining("safe to retry"),
        });
      },
    );
  });

  test("marks POST timeouts and transport failures as outcome unknown", async () => {
    const run = async (
      handler: (request: IncomingMessage, response: ServerResponse) => void,
    ) => {
      await withFixture(
        (request, response) => {
          if (request.method === "GET") {
            json(response, contextEnvelope());
            return;
          }
          handler(request, response);
        },
        async ({ dir, descriptorPath }) => {
          const specPath = join(dir, "spec.json");
          await writeFile(specPath, JSON.stringify({ annotations: [] }));
          let error: unknown;
          try {
            await annotateLiveApp(specPath, { descriptorPath });
          } catch (caught) {
            error = caught;
          }
          expect(error).toMatchObject({ code: "ERR_APP_OUTCOME_UNKNOWN" });
          const detail = (error as { detail?: string }).detail ?? "";
          expect(detail).toContain(`operationId=${LEGACY_EMPTY_OPERATION_ID}`);
          expect(detail).toContain(`documentId=${CONTEXT.documentId}`);
          expect(detail).toContain(`sha256=${SHA256}`);
          expect(detail).toContain(`pageTopologyHash=${PAGE_TOPOLOGY_HASH}`);
          expect(detail).not.toContain(TOKEN);
        },
      );
    };

    await run((_request, response) => {
      json(
        response,
        {
          schema: "shiori.live/v1",
          ok: false,
          error: { code: "REQUEST_TIMEOUT", message: "frontend timeout" },
        },
        504,
      );
    });
    await run((_request, response) => {
      json(
        response,
        {
          schema: "shiori.live/v1",
          ok: false,
          error: { code: "INTERNAL", message: "completion failed" },
        },
        500,
      );
    });
    await run((request) => request.socket.destroy());
  });

  test("rejects non-absolute, malformed, and over-permissive descriptors", async () => {
    await expect(
      readLiveAppDescriptor({ descriptorPath: "relative/live-api.json" }),
    ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });

    await withFixture(
      (_request, response) => json(response, contextEnvelope()),
      async ({ dir, descriptorPath }) => {
        await expect(
          readLiveAppDescriptor({ descriptorPath: join(dir, "missing.json") }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });

        await writeDescriptor(descriptorPath, 1234, { token: "not-a-token" });
        await expect(
          readLiveAppDescriptor({ descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });

        await writeDescriptor(descriptorPath, 1234, { schema: "wrong" });
        await expect(
          readLiveAppDescriptor({ descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });

        // Version skew is a distinct, actionable failure, not "invalid".
        await writeDescriptor(descriptorPath, 1234, { schema: "shiori.live/v2" });
        await expect(
          readLiveAppDescriptor({ descriptorPath }),
        ).rejects.toMatchObject({
          code: "ERR_APP_UNAVAILABLE",
          message: expect.stringContaining("schema mismatch"),
          detail: expect.stringContaining("matching versions"),
        });

        await writeDescriptor(descriptorPath, 0);
        await expect(
          readLiveAppDescriptor({ descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });

        await writeDescriptor(descriptorPath, 1234, { pid: 0 });
        await expect(
          readLiveAppDescriptor({ descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });

        await writeDescriptor(descriptorPath, 1234);
        await expect(
          readLiveAppDescriptor({
            descriptorPath,
            isProcessAlive: () => false,
          }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });

        await chmod(descriptorPath, 0o666);
        await expect(
          readLiveAppDescriptor({ descriptorPath, platform: "linux" }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });
      },
    );
  });

  test("rediscovers a live instance after another one overwrites and dies", async () => {
    // A starts, B starts and takes over the shared descriptor, then B dies
    // without cleaning up. A is still running, so the CLI must find it again
    // instead of reporting Shiori as unavailable until the user restarts A.
    const root = await mkdtemp(join(tmpdir(), "shiori-live-rediscover-"));
    const { cacheDir, options: hostOptions } = hostCacheFixture(root);
    await mkdir(cacheDir, { recursive: true });
    const alivePid = 4101;
    const deadPid = 4102;
    const options = {
      ...hostOptions,
      isProcessAlive: (pid: number) => pid === alivePid,
    };
    try {
      await writeDescriptor(join(cacheDir, `live-api.${alivePid}.json`), 5101, {
        pid: alivePid,
      });
      await writeDescriptor(join(cacheDir, `live-api.${deadPid}.json`), 5102, {
        pid: deadPid,
      });
      // The shared descriptor points at B, the instance that is now gone.
      await writeDescriptor(join(cacheDir, "live-api.json"), 5102, {
        pid: deadPid,
      });

      const descriptor = await readLiveAppDescriptor(options);
      expect(descriptor.pid).toBe(alivePid);
      expect(descriptor.port).toBe(5101);

      // The dead instance's file is pruned so the directory cannot grow one
      // entry per crashed launch forever.
      const remaining = await readdir(cacheDir);
      expect(remaining).not.toContain(`live-api.${deadPid}.json`);
      expect(remaining).toContain(`live-api.${alivePid}.json`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers when a dead instance's pid was recycled by something else", async () => {
    // Liveness is a pid check and pids get reused. A crashed instance leaves
    // the shared descriptor naming its pid; if the OS hands that pid to an
    // unrelated process, the pid looks alive, so rediscovery never triggers
    // and the CLI keeps aiming at a port nothing is listening on. Only failing
    // to connect distinguishes the two.
    const root = await mkdtemp(join(tmpdir(), "shiori-live-pidreuse-"));
    const { cacheDir, options } = hostCacheFixture(root);
    await mkdir(cacheDir, { recursive: true });
    const server = createServer((request, response) => {
      if (request.url === "/v1/context") {
        json(response, contextEnvelope());
        return;
      }
      response.writeHead(404);
      response.end();
    });
    // A port bound and immediately released: connecting to it is refused,
    // which is exactly what a recycled pid's "descriptor" looks like.
    const deadServer = createServer(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve, reject) => {
        deadServer.once("error", reject);
        deadServer.listen(0, "127.0.0.1", resolve);
      });
      const livePort = (server.address() as AddressInfo).port;
      const deadPort = (deadServer.address() as AddressInfo).port;
      await new Promise<void>((resolve) => {
        deadServer.close(() => resolve());
      });

      const livePid = 4301;
      const recycledPid = 4302;
      await writeDescriptor(
        join(cacheDir, `live-api.${livePid}.json`),
        livePort,
        { pid: livePid },
      );
      // The crashed instance's own file is gone; only the shared pointer is
      // left behind, naming a pid that now belongs to someone else.
      await writeDescriptor(join(cacheDir, "live-api.json"), deadPort, {
        pid: recycledPid,
      });

      const context = await getLiveAppContext({
        ...options,
        // Both pids resolve: the recycled one belongs to an unrelated process.
        isProcessAlive: () => true,
      });

      expect(context.documentId).toBe(CONTEXT.documentId);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to guess when a recycled pid leaves several live candidates", async () => {
    // Same rule as the plain dead-pointer path: one candidate is
    // unambiguous, several is a question only the caller can answer. Silently
    // taking the lowest pid would let `app context` describe one window's
    // document while `app annotate` targeted another.
    const root = await mkdtemp(join(tmpdir(), "shiori-live-pidreuse-many-"));
    const { cacheDir, options } = hostCacheFixture(root);
    await mkdir(cacheDir, { recursive: true });
    const servers = [createServer(() => undefined), createServer(() => undefined)];
    const deadServer = createServer(() => undefined);
    try {
      for (const server of [...servers, deadServer]) {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
      }
      const deadPort = (deadServer.address() as AddressInfo).port;
      await new Promise<void>((resolve) => deadServer.close(() => resolve()));

      await writeDescriptor(join(cacheDir, "live-api.4401.json"),
        (servers[0]!.address() as AddressInfo).port, { pid: 4401 });
      await writeDescriptor(join(cacheDir, "live-api.4402.json"),
        (servers[1]!.address() as AddressInfo).port, { pid: 4402 });
      await writeDescriptor(join(cacheDir, "live-api.json"), deadPort, {
        pid: 4403,
      });

      await expect(
        getLiveAppContext({
          ...options,
          isProcessAlive: () => true,
        }),
      ).rejects.toMatchObject({
        code: "ERR_APP_UNAVAILABLE",
        message: expect.stringContaining("4401, 4402"),
      });
    } finally {
      for (const server of servers) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("asks which instance to use when several are alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "shiori-live-ambiguous-"));
    const { cacheDir, options } = hostCacheFixture(root);
    await mkdir(cacheDir, { recursive: true });
    try {
      await writeDescriptor(join(cacheDir, "live-api.4201.json"), 5201, {
        pid: 4201,
      });
      await writeDescriptor(join(cacheDir, "live-api.4202.json"), 5202, {
        pid: 4202,
      });
      await writeDescriptor(join(cacheDir, "live-api.json"), 5203, {
        pid: 4203,
      });

      await expect(
        readLiveAppDescriptor({
          ...options,
          // Both instances are up; only the shared descriptor's owner is gone.
          isProcessAlive: (pid: number) => pid === 4201 || pid === 4202,
        }),
      ).rejects.toMatchObject({
        code: "ERR_APP_UNAVAILABLE",
        message: expect.stringContaining("4201, 4202"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed responses", async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{not json");
      },
      async ({ descriptorPath }) => {
        await expect(getLiveAppContext({ descriptorPath })).rejects.toMatchObject({
          code: "ERR_APP_UNAVAILABLE",
        });
      },
    );
  });

  test("rejects oversized responses", async () => {
    await withFixture(
      (_request, response) => {
        json(response, {
          schema: "shiori.live/v1",
          ok: true,
          data: { context: CONTEXT, padding: "x".repeat(1_000) },
        });
      },
      async ({ descriptorPath }) => {
        await expect(
          getLiveAppContext({ descriptorPath, maxResponseBytes: 128 }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });
      },
    );
  });

  test("times out slow responses", async () => {
    await withFixture(
      (_request, response) => {
        // Respond after the client's deadline so the fixture can still close
        // deterministically on runtimes that retain half-closed HTTP sockets.
        setTimeout(() => json(response, contextEnvelope()), 100);
      },
      async ({ descriptorPath }) => {
        await expect(
          getLiveAppContext({ descriptorPath, timeoutMs: 25 }),
        ).rejects.toMatchObject({ code: "ERR_APP_UNAVAILABLE" });
      },
    );
  });

  test("checks spec size and JSON before POST", async () => {
    let postCount = 0;
    await withFixture(
      (request, response) => {
        if (request.method === "POST") postCount += 1;
        json(response, contextEnvelope());
      },
      async ({ dir, descriptorPath }) => {
        const malformed = join(dir, "malformed.json");
        await writeFile(malformed, "{");
        await expect(
          annotateLiveApp(malformed, { descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_SPEC_INVALID" });

        const oversized = join(dir, "oversized.json");
        await writeFile(oversized, "");
        await truncate(oversized, 5 * 1024 * 1024 + 1);
        await expect(
          annotateLiveApp(oversized, { descriptorPath }),
        ).rejects.toMatchObject({ code: "ERR_FILE_TOO_LARGE" });

        if (process.platform !== "win32") {
          const fifo = join(dir, "spec.fifo");
          expect(spawnSync("mkfifo", [fifo], { stdio: "ignore" }).status).toBe(0);
          await expect(
            annotateLiveApp(fifo, { descriptorPath }),
          ).rejects.toMatchObject({ code: "ERR_FILE_UNAVAILABLE" });
        }
      },
    );
    expect(postCount).toBe(0);
  });

  test("does not leak descriptor tokens through authentication errors", async () => {
    await withFixture(
      (_request, response) => {
        json(
          response,
          {
            schema: "shiori.live/v1",
            ok: false,
            error: { code: "AUTH_FAILED", message: `bad token ${TOKEN}` },
          },
          401,
        );
      },
      async ({ descriptorPath }) => {
        let error: unknown;
        try {
          await getLiveAppContext({ descriptorPath });
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({ code: "ERR_APP_AUTH" });
        expect(String(error)).not.toContain(TOKEN);
      },
    );
  });
});
