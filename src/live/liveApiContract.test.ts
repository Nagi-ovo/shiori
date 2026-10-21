import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type {
  LiveApiAnnotationRequest,
  LiveApiContext,
  LiveApiError,
  LiveApiSuccessData,
} from "../platform/liveApi";

// src/platform/index.ts (pulled in by liveApi.ts) reads the Vite-injected
// __APP_VERSION__ at module scope, which bun test does not define. Stub it
// before the runtime import; the type-only imports above are erased.
(globalThis as Record<string, unknown>).__APP_VERSION__ ??= "0.0.0-test";
const { LIVE_API_ANNOTATION_REQUEST_EVENT, LIVE_API_SCHEMA } = await import(
  "../platform/liveApi"
);

// Cross-language contract tripwire. The wire types exist three times —
// here (frontend), src-tauri/src/live_api.rs (deny_unknown_fields), and
// cli/src/liveApp.ts — and nothing else forces them to agree. Each layer
// asserts against the same checked-in fixture:
//   - the `satisfies` literals below fail to COMPILE when a field is added
//     to or removed from the TS types, forcing a fixture update;
//   - live_api.rs `contract_fixtures_match_wire_types` then fails until the
//     Rust structs accept and reproduce the updated fixture;
//   - cli/test/liveContract.test.ts does the same for the CLI's copies.
// Never edit the fixture without running all three suites.
type ContractFixtures = {
  schema: string;
  event: string;
  context: { full: unknown; minimal: unknown };
  annotationRequestBody: unknown;
  annotationRequestEvent: unknown;
  completion: {
    success: { ok: boolean; data: unknown };
    specInvalid: { ok: boolean; error: unknown };
  };
  descriptor: unknown;
};

const fixtures = JSON.parse(
  readFileSync(new URL("./liveApiContract.fixtures.json", import.meta.url), "utf8"),
) as ContractFixtures;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

describe("live API contract fixtures", () => {
  test("schema and event constants match the fixture", () => {
    expect(LIVE_API_SCHEMA).toBe(fixtures.schema);
    expect(LIVE_API_ANNOTATION_REQUEST_EVENT).toBe(fixtures.event);
  });

  test("LiveApiContext matches the fixture shapes", () => {
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
    } satisfies Required<LiveApiContext>;
    expect(fixtures.context.full).toEqual(full);

    const minimal = {
      documentId: "doc-1f2e3d4c",
      name: "paper.pdf",
      sha256: SHA_A,
      pageTopologyHash: SHA_B,
      pageCount: 1,
      annotationCount: 0,
      dirty: false,
    } satisfies LiveApiContext;
    expect(fixtures.context.minimal).toEqual(minimal);
  });

  test("annotation request event matches the fixture", () => {
    const event = {
      requestId: "0123456789abcdef0123456789abcdef",
      operationId: SHA_C,
      expiresAtMs: 1_893_456_000_000,
      target: { documentId: "doc-1f2e3d4c", sha256: SHA_A, pageTopologyHash: SHA_B },
      spec: { schema: "shiori.annotations/v1", annotations: [] },
      dryRun: false,
      nonce: "again-1",
    } satisfies Required<LiveApiAnnotationRequest>;
    expect(fixtures.annotationRequestEvent).toEqual(event);
  });

  test("completion payloads match the fixture", () => {
    const success = {
      documentId: "doc-1f2e3d4c",
      sha256: SHA_A,
      pageTopologyHash: SHA_B,
      operationId: SHA_C,
      added: 1,
      annotationIds: ["live-op-1"],
      dryRun: false,
      annotationCount: 5,
    } satisfies Required<LiveApiSuccessData>;
    expect(fixtures.completion.success.ok).toBe(true);
    expect(fixtures.completion.success.data).toEqual(success);

    const error = {
      code: "SPEC_INVALID",
      message: "annotations[0].page is out of range",
      details: { index: 0 },
    } satisfies Required<LiveApiError>;
    expect(fixtures.completion.specInvalid.ok).toBe(false);
    expect(fixtures.completion.specInvalid.error).toEqual(error);
  });
});
