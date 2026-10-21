import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { liveOperationCanonicalPayload } from "./liveOperation";

const SHA = "a".repeat(64);
const TOPOLOGY = "b".repeat(64);
const SPEC = { annotations: [{ type: "highlight", quote: "the bound" }] };

// Receipts already stored in users' drafts are keyed by ids hashed from this
// exact text, and the CLI hashes the same text before it posts. A request
// without a nonce has to keep producing it byte for byte.
const LEGACY =
  `{"pageTopologyHash":"${TOPOLOGY}","schema":"shiori.live.operation/v1",` +
  `"sha256":"${SHA}","spec":{"annotations":[{"quote":"the bound","type":"highlight"}]}}`;

describe("live operation canonical payload", () => {
  test("is unchanged for a request without a nonce", () => {
    expect(liveOperationCanonicalPayload(SHA, TOPOLOGY, SPEC)).toBe(LEGACY);
    expect(liveOperationCanonicalPayload(SHA, TOPOLOGY, SPEC, undefined)).toBe(LEGACY);
  });

  test("carries a nonce, so the same spec hashes to a new operation", () => {
    const withNonce = liveOperationCanonicalPayload(SHA, TOPOLOGY, SPEC, "again-1");
    expect(withNonce).toBe(`{"nonce":"again-1",${LEGACY.slice(1)}`);
    const id = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(id(withNonce)).not.toBe(id(LEGACY));
  });
});
