import { describe, expect, test } from "bun:test";
import {
  buildReleaseInfo,
  wantsLegacyApkPath,
  githubHeaders,
  upstreamFailureResponse,
  type Release,
} from "./_release";

const cors = (contentType: string) => ({
  "Content-Type": contentType,
  "Access-Control-Allow-Origin": "*",
});

describe("githubHeaders", () => {
  test("anonymous requests still carry the User-Agent GitHub demands", () => {
    const headers = githubHeaders(undefined);
    expect(headers["User-Agent"]).toBe("shiori-site-pages-function");
    expect(headers.Authorization).toBeUndefined();
  });

  test("a configured token is sent as a bearer so the request leaves the shared IP quota", () => {
    expect(githubHeaders("  ghp_abc  ").Authorization).toBe("Bearer ghp_abc");
  });

  test("a blank token is treated as unset rather than sent as 'Bearer '", () => {
    expect(githubHeaders("   ").Authorization).toBeUndefined();
  });
});

describe("upstreamFailureResponse", () => {
  const opts = { maxAgeSeconds: 300, staleHeader: "X-Release-Stale", cors };

  test("serves the last-good payload when the upstream is rate-limited", async () => {
    const res = upstreamFailureResponse('{"version":"26.9.7"}', 403, opts);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"version":"26.9.7"}');
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Release-Stale")).toBe("1");
    expect(res.headers.get("X-Upstream-Status")).toBe("403");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  test("502s with the upstream status when there is nothing to fall back to", async () => {
    const res = upstreamFailureResponse(null, 403, opts);
    expect(res.status).toBe(502);
    expect(res.headers.get("X-Upstream-Status")).toBe("403");
    expect(res.headers.get("X-Release-Stale")).toBeNull();
  });

  test("reports 'none' when the failure was a cache miss with no status", () => {
    expect(upstreamFailureResponse(null, null, opts).headers.get("X-Upstream-Status")).toBe("none");
  });
});

describe("buildReleaseInfo", () => {
  const asset = (name: string, extra: Partial<Release["assets"][number]> = {}) => ({
    name,
    size: 1,
    browser_download_url: `https://example.test/${name}`,
    download_count: 0,
    ...extra,
  });
  const releases: Release[] = [
    {
      tag_name: "v26.9.7",
      published_at: "2026-09-07T15:09:47Z",
      assets: [
        asset("Shiori_26.9.7_aarch64.dmg", { digest: `sha256:${"AB".repeat(32)}` }),
        asset("Shiori_26.9.7_x64_en-US.msi", { digest: "sha256:abc" }),
      ],
    },
    {
      tag_name: "v26.9.6",
      published_at: "2026-09-01T00:00:00Z",
      assets: [asset("Shiori_26.9.6.apk")],
    },
  ];

  test("returns null for an empty window so the handler takes the fallback path", () => {
    expect(buildReleaseInfo([])).toBeNull();
  });

  test("resolves each platform to the newest release that carries its asset", () => {
    const info = buildReleaseInfo(releases);
    expect(info?.version).toBe("26.9.7");
    expect(info?.platforms["mac-silicon"]).toMatchObject({
      version: "26.9.7",
      sha256: "ab".repeat(32),
    });
    expect(info?.platforms.android).toMatchObject({
      version: "26.9.6",
      filename: "Shiori_26.9.6.apk",
      url: "https://example.test/Shiori_26.9.6.apk",
    });
    expect(info?.platforms.android?.sha256).toBeUndefined();
    // A malformed digest is dropped: the Android updater would reject it.
    expect(info?.platforms.windows?.filename).toBe("Shiori_26.9.7_x64_en-US.msi");
    expect(info?.platforms.windows?.sha256).toBeUndefined();
  });

  // Installed direct-APK builds only accept the shiori-releases download
  // path, so the APK URL must keep that form after the repo rename.
  test("serves a post-rename APK URL under the path installed Android builds accept", () => {
    const tail = "releases/download/v26.10.1/Shiori_26.10.1.apk";
    const info = buildReleaseInfo([
      {
        tag_name: "v26.10.1",
        published_at: "2026-10-20T00:00:00Z",
        assets: [
          asset("Shiori_26.10.1.apk", {
            browser_download_url: `https://github.com/Nagi-ovo/shiori/${tail}`,
          }),
          asset("Shiori_26.10.1_aarch64.dmg", {
            browser_download_url: "https://github.com/Nagi-ovo/shiori/releases/download/v26.10.1/Shiori_26.10.1_aarch64.dmg",
          }),
        ],
      },
    ]);
    expect(info?.platforms.android?.url).toBe(
      `https://github.com/Nagi-ovo/shiori-releases/${tail}`,
    );
    expect(info?.platforms["mac-silicon"]?.url).toBe(
      "https://github.com/Nagi-ovo/shiori/releases/download/v26.10.1/Shiori_26.10.1_aarch64.dmg",
    );
  });

  test("serves the renamed APK URL as is to builds that ask for it", () => {
    const url = "https://github.com/Nagi-ovo/shiori/releases/download/v26.10.1/Shiori_26.10.1.apk";
    const info = buildReleaseInfo(
      [
        {
          tag_name: "v26.10.1",
          published_at: "2026-10-20T00:00:00Z",
          assets: [asset("Shiori_26.10.1.apk", { browser_download_url: url })],
        },
      ],
      { legacyApkPath: false },
    );
    expect(info?.platforms.android?.url).toBe(url);
  });

  test("only a request naming the renamed repo opts out of the old APK path", () => {
    expect(wantsLegacyApkPath("https://shiori.nagi.fun/api/release")).toBe(true);
    expect(wantsLegacyApkPath("https://shiori.nagi.fun/api/release?apkRepo=other")).toBe(true);
    expect(wantsLegacyApkPath("https://shiori.nagi.fun/api/release?apkRepo=shiori")).toBe(false);
  });

  test("leaves a pre-rename APK URL as GitHub returned it", () => {
    const url = "https://github.com/Nagi-ovo/shiori-releases/releases/download/v26.9.6/Shiori_26.9.6.apk";
    const info = buildReleaseInfo([
      {
        tag_name: "v26.9.6",
        published_at: "2026-09-01T00:00:00Z",
        assets: [asset("Shiori_26.9.6.apk", { browser_download_url: url })],
      },
    ]);
    expect(info?.platforms.android?.url).toBe(url);
  });
});
