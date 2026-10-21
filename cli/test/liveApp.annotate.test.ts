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
import { liveOperationIdMatches } from "../../src/live/liveOperationId";
import { annotateLiveApp, describeAnnotateResult } from "../src/liveApp";
import { main } from "../src/main";
import {
  CONTEXT,
  captureMain,
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
    // the turns (src/live/liveAnnotationPrepare.ts): two replies to c1 come back as
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

  test("says so when the app already applied this exact spec", async () => {
    // The operation id hashes the spec, and its receipt outlives Undo and a
    // discarded draft, so sending the same spec again on purpose adds nothing.
    // "Applied 0 annotations" read like a no-op bug; the agent needs the
    // reason and the way out (change the spec).
    const spec = {
      annotations: [{ type: "calloutReply", replyTo: "c1", text: "again" }],
    };
    let result: Record<string, unknown> = {};
    await withFixture(
      appHandler(() => result),
      async ({ descriptorPath }) => {
        result = { added: 0, annotationIds: ["c1"], alreadyApplied: true };
        const repeated = await annotateLiveApp(null, { descriptorPath, spec });
        expect(repeated.data.alreadyApplied).toBe(true);
        expect(describeAnnotateResult(repeated)).toContain("already applied");

        result = { added: 1, annotationIds: ["c1"] };
        const fresh = await annotateLiveApp(null, { descriptorPath, spec });
        expect(fresh.data.alreadyApplied).toBeUndefined();
        expect(describeAnnotateResult(fresh)).toBe(
          `Applied 1 annotations to ${CONTEXT.name}.`,
        );

        result = { added: 0, annotationIds: ["c1"], alreadyApplied: "yes" };
        await expect(
          annotateLiveApp(null, { descriptorPath, spec }),
        ).rejects.toMatchObject({ code: "ERR_APP_OUTCOME_UNKNOWN" });
      },
    );
  });

  test("--nonce applies an identical spec again as a new operation", async () => {
    // The receipt of an operation outlives Undo and a discarded draft, so the
    // same spec is the same operation and adds nothing. A nonce makes it a
    // new one; the app has to accept the id the CLI derived with it, and a
    // call without one must post exactly what it always did.
    const bodies: Record<string, unknown>[] = [];
    await withFixture(
      (request, response) => {
        if (request.url === "/v1/context") {
          json(response, contextEnvelope());
          return;
        }
        void requestBody(request).then(async (body) => {
          const posted = body as Record<string, unknown> & { operationId: string };
          bodies.push(posted);
          if (posted.nonce === "lost-1") {
            response.destroy();
            return;
          }
          if (!(await liveOperationIdMatches(posted as never))) {
            json(response, {
              schema: "shiori.live/v1",
              ok: false,
              error: { code: "SPEC_INVALID", message: "operation id mismatch" },
            });
            return;
          }
          json(response, {
            schema: "shiori.live/v1",
            ok: true,
            data: {
              documentId: CONTEXT.documentId,
              sha256: CONTEXT.sha256,
              pageTopologyHash: CONTEXT.pageTopologyHash,
              operationId: posted.operationId,
              added: 1,
              annotationIds: ["h1"],
              dryRun: false,
              annotationCount: CONTEXT.annotationCount + 1,
            },
          });
        });
      },
      async ({ descriptorPath }) => {
        const args = ["app", "annotate", "--highlight", "the bound", "--json"];
        await captureMain(args, descriptorPath);
        const again = await captureMain([...args, "--nonce", "again-1"], descriptorPath);
        expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, data: { added: 1 } });
        expect(bodies).toHaveLength(2);
        expect("nonce" in bodies[0]!).toBe(false);
        expect(bodies[1]).toMatchObject({ nonce: "again-1" });
        expect(bodies[1]!.operationId).not.toBe(bodies[0]!.operationId);

        // A retry is the same operation only with the same nonce, so the
        // outcome-unknown advice has to carry it.
        await expect(
          annotateLiveApp(null, { descriptorPath, spec: EMPTY_SPEC, nonce: "lost-1" }),
        ).rejects.toMatchObject({
          code: "ERR_APP_OUTCOME_UNKNOWN",
          detail: expect.stringContaining("--nonce lost-1"),
        });

        // Malformed nonces fail before anything is posted.
        for (const nonce of ["", "has space", "x".repeat(65)]) {
          await expect(
            annotateLiveApp(null, { descriptorPath, spec: EMPTY_SPEC, nonce }),
          ).rejects.toMatchObject({ code: "ERR_SPEC_INVALID" });
        }
        expect(bodies).toHaveLength(3);
      },
    );
    await expect(main(["app", "context", "--nonce", "again-1"])).rejects.toMatchObject({
      code: "ERR_USAGE",
      message: "Unknown option for app context: --nonce",
    });
  });
});
