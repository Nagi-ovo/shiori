import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { liveOperationId, type LiveAppContext } from "../src/liveApp";
import { main } from "../src/main";

const SHA256 = "b".repeat(64);
const PAGE_TOPOLOGY_HASH = "d".repeat(64);
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// A file name is the user's to choose, and the app passes it through as it
// is: this one carries an OSC 52 sequence that writes the clipboard.
const CONTEXT: LiveAppContext = {
  documentId: "doc-live-human",
  name: `evil${ESC}]52;c;cHduZWQ=${BEL}.pdf`,
  path: "/tmp/evil.pdf",
  sha256: SHA256,
  pageTopologyHash: PAGE_TOPOLOGY_HASH,
  pageCount: 1,
  activePage: null,
  annotationCount: 0,
  dirty: false,
};

function json(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function requestBody(request: IncomingMessage): Promise<{ dryRun?: boolean }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Runs `shiori app annotate` in human mode against a fake app; returns stdout. */
async function humanAnnotate(dryRun: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-live-human-test-"));
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      json(response, { schema: "shiori.live/v1", ok: true, data: { context: CONTEXT } });
      return;
    }
    void requestBody(request).then((body) =>
      json(response, {
        schema: "shiori.live/v1",
        ok: true,
        data: {
          documentId: CONTEXT.documentId,
          sha256: SHA256,
          pageTopologyHash: PAGE_TOPOLOGY_HASH,
          added: 0,
          annotationIds: [],
          dryRun: body.dryRun === true,
          annotationCount: 0,
          operationId: liveOperationId(SHA256, PAGE_TOPOLOGY_HASH, { annotations: [] }),
        },
      }),
    );
  });
  const logs: string[] = [];
  const originalLog = console.log;
  const originalDescriptor = process.env.SHIORI_LIVE_API_DESCRIPTOR;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const descriptorPath = join(dir, "live-api.json");
    await writeFile(
      descriptorPath,
      JSON.stringify({
        schema: "shiori.live/v1",
        port: (server.address() as AddressInfo).port,
        token: "a".repeat(64),
        pid: process.pid,
        appVersion: "0.1.26",
      }),
    );
    await chmod(descriptorPath, 0o600);
    const specPath = join(dir, "spec.json");
    await writeFile(specPath, JSON.stringify({ annotations: [] }));
    process.env.SHIORI_LIVE_API_DESCRIPTOR = descriptorPath;
    console.log = (message?: unknown) => logs.push(String(message ?? ""));
    await main(["app", "annotate", "--spec", specPath, ...(dryRun ? ["--dry-run"] : [])]);
  } finally {
    console.log = originalLog;
    if (originalDescriptor == null) delete process.env.SHIORI_LIVE_API_DESCRIPTOR;
    else process.env.SHIORI_LIVE_API_DESCRIPTOR = originalDescriptor;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
  }
  return logs.join("\n");
}

describe("app annotate human output", () => {
  for (const [dryRun, line] of [
    [true, "Dry run: 0 annotations ready for evil]52;c;cHduZWQ=.pdf."],
    [false, "Applied 0 annotations to evil]52;c;cHduZWQ=.pdf."],
  ] as const) {
    test(`strips terminal escapes from the document name (dry run: ${dryRun})`, async () => {
      const stdout = await humanAnnotate(dryRun);
      expect(stdout).not.toContain(ESC);
      expect(stdout).not.toContain(BEL);
      expect(stdout).toBe(line);
    });
  }
});
