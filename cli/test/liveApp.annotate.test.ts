import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
  withFixture,
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
function appHandler(
  result: () => Record<string, unknown>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
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
          ...result(),
        },
      });
    });
  };
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
    const server = createServer(
      appHandler(() => ({ added: 0, annotationIds: [] })),
    );
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

  test("accepts several replies to one callout, and their retry", async () => {
    // A reply spec's ids are the callouts it replied to, while `added` counts
    // the turns (src/live/liveApiBridge.ts): two replies to c1 come back as
    // added 2 with one id. Checking that against "one id per spec entry"
    // reported an outcome-unknown write that had landed, and the prescribed
    // retry (added 0, still one id) failed the same way forever.
    const spec = {
      annotations: [
        { type: "calloutReply", replyTo: "c1", text: "part 1" },
        { type: "calloutReply", replyTo: "c1", text: "part 2" },
        { type: "calloutReply", replyTo: "c2", text: "and this" },
      ],
    };
    let result: Record<string, unknown> = {};
    await withFixture(
      appHandler(() => result),
      async ({ descriptorPath }) => {
        result = { added: 3, annotationIds: ["c1", "c2"] };
        await expect(
          annotateLiveApp(null, { descriptorPath, spec }),
        ).resolves.toMatchObject({ data: { added: 3 } });

        result = { added: 0, annotationIds: ["c1", "c2"] };
        await expect(
          annotateLiveApp(null, { descriptorPath, spec }),
        ).resolves.toMatchObject({ data: { added: 0 } });

        // Still checked: the ids must be exactly the callouts replied to,
        // and no more turns than the spec asked for.
        for (const wrong of [
          { added: 3, annotationIds: ["c2", "c1"] },
          { added: 3, annotationIds: ["c1"] },
          { added: 4, annotationIds: ["c1", "c2"] },
        ]) {
          result = wrong;
          await expect(
            annotateLiveApp(null, { descriptorPath, spec }),
          ).rejects.toMatchObject({ code: "ERR_APP_OUTCOME_UNKNOWN" });
        }
      },
    );
  });
});
