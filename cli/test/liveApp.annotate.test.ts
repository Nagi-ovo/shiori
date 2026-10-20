import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { annotateLiveApp } from "../src/liveApp";
import {
  CONTEXT,
  EMPTY_SPEC,
  contextEnvelope,
  hostCacheFixture,
  json,
  requestBody,
  writeDescriptor,
} from "./liveAppHarness";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Plays a Shiori that applies whatever it is sent and reports `result`. */
function appServer(
  result: (operationId: string) => Record<string, unknown>,
): Server {
  return createServer((request, response) => {
    if (request.url === "/v1/context") {
      json(response, contextEnvelope());
      return;
    }
    void requestBody(request).then((body) => {
      const { operationId } = body as { operationId: string };
      json(response, {
        schema: "shiori.live/v1",
        ok: true,
        data: {
          documentId: CONTEXT.documentId,
          sha256: CONTEXT.sha256,
          pageTopologyHash: CONTEXT.pageTopologyHash,
          operationId,
          dryRun: false,
          annotationCount: CONTEXT.annotationCount,
          ...result(operationId),
        },
      });
    });
  });
}

describe("app annotate", () => {
  test("follows a recycled pid to the live instance, as app context does", async () => {
    // Instance A crashed and the OS gave its pid to something else, so the
    // shared descriptor still looks alive while instance B runs beside it.
    // `app context` rediscovers B on the connect failure; annotate has to do
    // the same, or an agent sees the read work and the write fail.
    const root = await mkdtemp(join(tmpdir(), "shiori-live-annotate-pid-"));
    const { cacheDir, options } = hostCacheFixture(root);
    await mkdir(cacheDir, { recursive: true });
    const server = appServer(() => ({ added: 0, annotationIds: [] }));
    const deadServer = createServer(() => undefined);
    try {
      const livePort = await listen(server);
      const deadPort = await listen(deadServer);
      await new Promise<void>((resolve) => deadServer.close(() => resolve()));
      await writeDescriptor(join(cacheDir, "live-api.4501.json"), livePort, {
        pid: 4501,
      });
      await writeDescriptor(join(cacheDir, "live-api.json"), deadPort, {
        pid: 4502,
      });

      const result = await annotateLiveApp(null, {
        ...options,
        spec: EMPTY_SPEC,
        isProcessAlive: () => true,
      });

      expect(result.context.documentId).toBe(CONTEXT.documentId);
      expect(result.data).toMatchObject({ added: 0, annotationIds: [] });
    } finally {
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });
});
