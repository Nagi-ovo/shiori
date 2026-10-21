import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { onRequestGet } from "./[platform]";

// Drives the /download/<platform> handler with the two Workers globals it
// needs, `caches.default` and `fetch`, faked as in api/_cli.test.ts. The
// download buttons on the homepage are plain links to this route, so what it
// redirects to is what the user gets.

const store = new Map<string, string>();
let pending: Promise<unknown>[] = [];
let upstream: () => Response;
let realFetch: typeof globalThis.fetch;
let realCaches: unknown;

const MSI = "https://github.com/Nagi-ovo/shiori/releases/download/v26.10.20/Shiori_26.10.20_x64_en-US.msi";

const healthy = () =>
  Response.json([
    {
      tag_name: "v26.10.20",
      published_at: "2026-10-20T00:00:00Z",
      assets: [{ name: "Shiori_26.10.20_x64_en-US.msi", size: 1, browser_download_url: MSI, download_count: 0 }],
    },
  ]);
const rateLimited = () => new Response("rate limited", { status: 403 });

async function download(platform: string): Promise<string | null> {
  const response = await onRequestGet({
    request: new Request(`https://shiori.nagi.fun/download/${platform}`),
    params: { platform },
    env: {},
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
  } as unknown as Parameters<typeof onRequestGet>[0]);
  await Promise.all(pending);
  pending = [];
  expect(response.status).toBe(302);
  return response.headers.get("Location");
}

// The edge cache of the GitHub release list expires; the colo goes cold.
function expireReleaseListCache() {
  for (const key of [...store.keys()]) {
    if (key.startsWith("https://api.github.com/")) store.delete(key);
  }
}

beforeEach(() => {
  store.clear();
  pending = [];
  realFetch = globalThis.fetch;
  realCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = {
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
  globalThis.fetch = (async () => upstream()) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { caches?: unknown }).caches = realCaches as never;
});

describe("/download/<platform>", () => {
  test("redirects to the newest installer while GitHub answers", async () => {
    upstream = healthy;
    expect(await download("windows")).toBe(MSI);
  });

  test("keeps handing out the last installer it resolved when GitHub then fails on a cold cache", async () => {
    upstream = healthy;
    await download("windows");

    expireReleaseListCache();
    upstream = rateLimited;
    // Before the fix this bounced to /#download, which looks like the page
    // just reloaded, on every click until GitHub recovered.
    expect(await download("windows")).toBe(MSI);
  });

  test("never serves one platform's installer for another", async () => {
    upstream = healthy;
    await download("windows");

    expireReleaseListCache();
    upstream = rateLimited;
    expect(await download("linux-appimage")).toBe("https://shiori.nagi.fun/#download");
  });

  test("falls back to the download section when it has never resolved an installer", async () => {
    upstream = rateLimited;
    expect(await download("windows")).toBe("https://shiori.nagi.fun/#download");
  });

  test("sends an unknown platform to the download section", async () => {
    upstream = healthy;
    expect(await download("beos")).toBe("https://shiori.nagi.fun/#download");
  });
});
