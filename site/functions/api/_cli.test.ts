import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { onRequestGet } from "./cli";

// Exercises the handler itself, not just its helpers. The bug this file
// exists for lived in the ORDER of two branches inside onRequestGet — a
// helper-only test would have stayed green through it.
//
// Two Workers globals stand in the way: `caches.default` and `fetch`. Both
// are small enough to fake honestly.

const LAST_GOOD_KEY = "https://shiori.internal/api/cli/last-good";
const SHA = "a".repeat(64);

const MANIFEST = JSON.stringify({
  schema: "shiori.cli-release/v1",
  available: true,
  version: "0.1.25",
  targets: {
    "darwin-arm64": {
      url: "https://example.test/shiori-cli-0.1.25-darwin-arm64.tar.gz",
      sha256: SHA,
      size: 12,
    },
  },
});

const store = new Map<string, string>();
let realFetch: typeof globalThis.fetch;
let realCaches: unknown;

function fakeCaches() {
  return {
    default: {
      async match(request: Request) {
        const body = store.get(request.url);
        return body === undefined ? undefined : new Response(body);
      },
      async put(request: Request, response: Response) {
        store.set(request.url, await response.text());
      },
    },
  };
}

function context(url: string) {
  return {
    request: new Request(url),
    env: {},
    waitUntil: (promise: Promise<unknown>) => void promise,
  } as unknown as Parameters<typeof onRequestGet>[0];
}

beforeEach(() => {
  store.clear();
  realFetch = globalThis.fetch;
  realCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = fakeCaches();
  // Every upstream call fails: this is the GitHub outage the fix is about.
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 403 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { caches?: unknown }).caches = realCaches as never;
});

describe("/api/cli during a GitHub outage", () => {
  test("answers format=env in env syntax, not JSON", async () => {
    store.set(LAST_GOOD_KEY, MANIFEST);

    const response = await onRequestGet(
      context("https://shiori.nagi.fun/api/cli?target=darwin-arm64&format=env"),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    // The regression: a JSON body here is what made the POSIX installer
    // report "Unexpected field in release descriptor" during an outage.
    expect(body.startsWith("{")).toBe(false);
    expect(body).toContain("SHIORI_CLI_AVAILABLE=1");
    expect(body).toContain("SHIORI_CLI_VERSION=0.1.25");
    expect(body).toContain(`SHIORI_CLI_SHA256=${SHA}`);
    expect(response.headers.get("X-Cli-Release-Stale")).toBe("1");
  });

  test("still serves JSON to the JSON caller", async () => {
    store.set(LAST_GOOD_KEY, MANIFEST);

    const response = await onRequestGet(context("https://shiori.nagi.fun/api/cli"));
    const body = await response.text();

    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(JSON.parse(body).version).toBe("0.1.25");
  });

  test("reports an outage as an outage, never as 'nothing published yet'", async () => {
    const response = await onRequestGet(
      context("https://shiori.nagi.fun/api/cli?target=darwin-arm64&format=env"),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    // SHIORI_CLI_AVAILABLE=0 is the wire form of "no archive exists". Saying
    // it here would tell a user to wait for a release that already shipped.
    expect(body).not.toContain("SHIORI_CLI_AVAILABLE");
    expect(response.headers.get("X-Upstream-Status")).toBe("403");
  });

  test("ignores a cache entry that is not a usable manifest", async () => {
    store.set(LAST_GOOD_KEY, '{"schema":"shiori.cli-release/v1","available":false}');

    const response = await onRequestGet(
      context("https://shiori.nagi.fun/api/cli?target=darwin-arm64&format=env"),
    );

    expect(response.status).toBe(503);
  });
});

describe("/api/cli with a healthy upstream", () => {
  beforeEach(() => {
    globalThis.fetch = (async () =>
      Response.json([
        {
          tag_name: "v0.1.25",
          assets: [
            {
              name: "shiori-cli-0.1.25-darwin-arm64.tar.gz",
              size: 12,
              browser_download_url:
                "https://example.test/shiori-cli-0.1.25-darwin-arm64.tar.gz",
              download_count: 0,
              digest: `sha256:${SHA}`,
            },
          ],
        },
      ])) as unknown as typeof globalThis.fetch;
  });

  test("warms the last-good cache from an env request too", async () => {
    const response = await onRequestGet(
      context("https://shiori.nagi.fun/api/cli?target=darwin-arm64&format=env"),
    );

    expect(await response.text()).toContain("SHIORI_CLI_AVAILABLE=1");
    // Before the fix only the JSON branch stored this, so a population of
    // curl users left the outage cache permanently cold.
    expect(store.get(LAST_GOOD_KEY)).toContain('"version":"0.1.25"');
  });

  test("fails closed for a target with no published archive", async () => {
    const response = await onRequestGet(
      context("https://shiori.nagi.fun/api/cli?target=win32-x64&format=env"),
    );

    expect(await response.text()).toBe("SHIORI_CLI_AVAILABLE=0\n");
  });
});
