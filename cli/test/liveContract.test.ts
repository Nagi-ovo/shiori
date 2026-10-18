import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type {
  LiveAnnotationResult,
  LiveAppContext,
  LiveAppDescriptor,
} from "../src/liveApp";

// CLI leg of the cross-language contract tripwire — see
// src/live/liveApiContract.test.ts for how the three suites chain together.
// The literals type-check against the CLI's own copies of the wire types, so
// a CLI-side field addition/removal breaks compilation here until the shared
// fixture (and with it the frontend and Rust suites) is updated.
type ContractFixtures = {
  schema: string;
  context: { full: unknown; minimal: unknown };
  completion: { success: { ok: boolean; data: unknown } };
  descriptor: unknown;
};

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../src/live/liveApiContract.fixtures.json", import.meta.url),
    "utf8",
  ),
) as ContractFixtures;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

describe("live API contract fixtures (CLI types)", () => {
  test("LiveAppContext matches the fixture shapes", () => {
    const full = {
      documentId: "doc-1f2e3d4c",
      name: "paper.pdf",
      path: "/Users/jesse/Documents/paper.pdf",
      sha256: SHA_A,
      pageTopologyHash: SHA_B,
      pageCount: 12,
      activePage: { page: 3, widthPt: 612.5, heightPt: 792.25, rotation: 90 },
      annotationCount: 4,
      dirty: true,
      annotations: [
        {
          id: "live-op-1",
          type: "callout",
          page: 3,
          text: "Why is this bound tight?",
          quote: "the bound is tight for n > 2",
          thread: [
            { role: "user", text: "and the other one?" },
            { role: "agent", author: "Claude Code", text: "same argument" },
          ],
        },
      ],
      annotationsTruncated: true,
    } satisfies Required<LiveAppContext>;
    expect(fixtures.context.full).toEqual(full);

    const minimal = {
      documentId: "doc-1f2e3d4c",
      name: "paper.pdf",
      sha256: SHA_A,
      pageTopologyHash: SHA_B,
      pageCount: 1,
      annotationCount: 0,
      dirty: false,
    } satisfies LiveAppContext;
    expect(fixtures.context.minimal).toEqual(minimal);
  });

  test("LiveAnnotationResult matches the fixture", () => {
    const success = {
      documentId: "doc-1f2e3d4c",
      sha256: SHA_A,
      pageTopologyHash: SHA_B,
      operationId: SHA_C,
      added: 1,
      annotationIds: ["live-op-1"],
      dryRun: false,
      annotationCount: 5,
    } satisfies Required<LiveAnnotationResult>;
    expect(fixtures.completion.success.data).toEqual(success);
  });

  test("LiveAppDescriptor matches the fixture", () => {
    const descriptor = {
      schema: "shiori.live/v1",
      port: 49321,
      token: "d".repeat(64),
      pid: 4242,
      appVersion: "0.1.26",
    } satisfies Required<LiveAppDescriptor>;
    expect(fixtures.descriptor).toEqual(descriptor);
    expect(fixtures.schema).toBe(descriptor.schema);
  });
});
