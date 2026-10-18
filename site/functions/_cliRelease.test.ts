import { describe, expect, test } from "bun:test";
import {
  CLI_INSTALL_TARGETS,
  CLI_RELEASE_SCHEMA,
  buildCliReleaseManifest,
  cliManifestEnv,
  parseCliAssetName,
  parseCliReleaseManifest,
  parseGithubSha256,
} from "./_cliRelease";
import {
  CLI_RELEASE_SCHEMA as DISTRIBUTION_SCHEMA,
  SUPPORTED_CLI_INSTALL_TARGETS,
  cliArchiveName,
  parseCliAssetName as parseDistributionAssetName,
  parseGithubSha256 as parseDistributionSha256,
} from "../../cli/distribution";
import type { Release } from "./_release";

const SHA = "a".repeat(64);

function asset(
  name: string,
  extra: Partial<Release["assets"][number]> = {},
): Release["assets"][number] {
  return {
    name,
    size: 12,
    browser_download_url: `https://example.test/${name}`,
    download_count: 0,
    digest: `sha256:${SHA}`,
    ...extra,
  };
}

describe("CLI release asset names", () => {
  test("match the same archive names the CLI package writes", () => {
    expect(parseCliAssetName(cliArchiveName("0.1.25", "darwin-arm64"))).toEqual({
      version: "0.1.25",
      target: "darwin-arm64",
    });
    expect(parseDistributionAssetName("shiori-cli-0.1.25-linux-x64-gnu.tar.gz")).toEqual(
      parseCliAssetName("shiori-cli-0.1.25-linux-x64-gnu.tar.gz"),
    );
  });

  test("ignore desktop installers and unsigned leftovers", () => {
    expect(parseCliAssetName("Shiori_26.9.9_aarch64.dmg")).toBeNull();
    expect(parseCliAssetName("shiori-cli-0.1.25-darwin-x64.tar.gz")).toBeNull();
    expect(parseCliAssetName("shiori-cli-0.1.25-darwin-arm64.zip")).toBeNull();
  });
});

describe("buildCliReleaseManifest", () => {
  test("stays unavailable until a hashed CLI archive exists", () => {
    const releases: Release[] = [
      {
        tag_name: "v26.9.9",
        published_at: "2026-09-09T00:00:00Z",
        assets: [asset("Shiori_26.9.9_aarch64.dmg")],
      },
    ];
    expect(buildCliReleaseManifest(releases)).toEqual({
      schema: "shiori.cli-release/v1",
      available: false,
    });
  });

  test("takes the newest CLI version and drops older targets", () => {
    const releases: Release[] = [
      {
        tag_name: "v26.9.9",
        published_at: "2026-09-09T00:00:00Z",
        assets: [
          asset("shiori-cli-0.1.25-darwin-arm64.tar.gz"),
          asset("shiori-cli-0.1.24-linux-x64-gnu.tar.gz"),
        ],
      },
    ];
    const manifest = buildCliReleaseManifest(releases);
    expect(manifest).toEqual({
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
  });

  test("serves the newest release when one CLI version sits on two", () => {
    // Before the CLI had its own tag, an app bump re-uploaded the same
    // archive name onto a second release. Both parse to 0.1.25, so neither
    // wins on version — and picking by array position handed out the OLDER
    // release's URLs.
    const releases: Release[] = [
      {
        tag_name: "cli-v0.1.25",
        published_at: "2026-09-13T00:00:00Z",
        assets: [
          asset("shiori-cli-0.1.25-darwin-arm64.tar.gz", {
            browser_download_url: "https://example.test/new/shiori.tar.gz",
          }),
        ],
      },
      {
        tag_name: "v26.9.9",
        published_at: "2026-09-01T00:00:00Z",
        assets: [
          asset("shiori-cli-0.1.25-darwin-arm64.tar.gz", {
            browser_download_url: "https://example.test/old/shiori.tar.gz",
          }),
        ],
      },
    ];
    const manifest = buildCliReleaseManifest(releases);
    expect(manifest.available && manifest.targets["darwin-arm64"]?.url).toBe(
      "https://example.test/new/shiori.tar.gz",
    );
  });

  test("picks by publish time, not by the order GitHub happened to return", () => {
    const newest = {
      tag_name: "cli-v0.1.25",
      published_at: "2026-09-13T00:00:00Z",
      assets: [
        asset("shiori-cli-0.1.25-linux-x64-gnu.tar.gz", {
          browser_download_url: "https://example.test/new/shiori.tar.gz",
        }),
      ],
    } satisfies Release;
    const oldest = {
      tag_name: "v26.9.9",
      published_at: "2026-09-01T00:00:00Z",
      assets: [
        asset("shiori-cli-0.1.25-linux-x64-gnu.tar.gz", {
          browser_download_url: "https://example.test/old/shiori.tar.gz",
        }),
      ],
    } satisfies Release;

    for (const releases of [
      [newest, oldest],
      [oldest, newest],
    ]) {
      const manifest = buildCliReleaseManifest(releases);
      expect(manifest.available && manifest.targets["linux-x64-gnu"]?.url).toBe(
        "https://example.test/new/shiori.tar.gz",
      );
    }
  });

  test("an unverifiable archive cannot displace a version that has a digest", () => {
    const releases: Release[] = [
      {
        tag_name: "cli-v0.1.26",
        published_at: "2026-09-13T00:00:00Z",
        assets: [
          asset("shiori-cli-0.1.26-darwin-arm64.tar.gz", { digest: undefined }),
        ],
      },
      {
        tag_name: "cli-v0.1.25",
        published_at: "2026-09-01T00:00:00Z",
        assets: [asset("shiori-cli-0.1.25-darwin-arm64.tar.gz")],
      },
    ];
    const manifest = buildCliReleaseManifest(releases);
    expect(manifest.available && manifest.version).toBe("0.1.25");
  });

  test("rejects an archive whose GitHub digest is missing", () => {
    const releases: Release[] = [
      {
        tag_name: "v0.1.25",
        published_at: "2026-09-13T00:00:00Z",
        assets: [asset("shiori-cli-0.1.25-darwin-arm64.tar.gz", { digest: undefined })],
      },
    ];
    expect(buildCliReleaseManifest(releases).available).toBe(false);
  });
});

describe("cliManifestEnv", () => {
  const ready = buildCliReleaseManifest([
    {
      tag_name: "v0.1.25",
      published_at: "2026-09-13T00:00:00Z",
      assets: [asset("shiori-cli-0.1.25-darwin-arm64.tar.gz")],
    },
  ]);

  test("emits assignments the POSIX installer can parse without eval", () => {
    expect(cliManifestEnv(ready, "darwin-arm64")).toBe(
      [
        "SHIORI_CLI_AVAILABLE=1",
        "SHIORI_CLI_VERSION=0.1.25",
        "SHIORI_CLI_TARGET=darwin-arm64",
        "SHIORI_CLI_URL=https://example.test/shiori-cli-0.1.25-darwin-arm64.tar.gz",
        `SHIORI_CLI_SHA256=${SHA}`,
        "SHIORI_CLI_SIZE=12",
        "",
      ].join("\n"),
    );
  });

  test("fails closed for an unknown or unpublished target", () => {
    expect(cliManifestEnv(ready, "darwin-x64")).toBe("SHIORI_CLI_AVAILABLE=0\n");
    expect(cliManifestEnv({ schema: "shiori.cli-release/v1", available: false }, "darwin-arm64")).toBe(
      "SHIORI_CLI_AVAILABLE=0\n",
    );
  });
});

// The cached manifest is what /api/cli serves to a running installer when
// GitHub is unreachable, so it is re-validated on the way back out.
describe("parseCliReleaseManifest", () => {
  const stored = JSON.stringify({
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

  test("round-trips a manifest the installer can act on", () => {
    const manifest = parseCliReleaseManifest(stored);
    expect(manifest?.available).toBe(true);
    expect(cliManifestEnv(manifest!, "darwin-arm64")).toContain(
      "SHIORI_CLI_VERSION=0.1.25",
    );
  });

  test("fails closed on an empty, malformed, or foreign cache entry", () => {
    expect(parseCliReleaseManifest(null)).toBeNull();
    expect(parseCliReleaseManifest("")).toBeNull();
    expect(parseCliReleaseManifest("{oops")).toBeNull();
    expect(parseCliReleaseManifest(JSON.stringify({ schema: "other/v1" }))).toBeNull();
  });

  test("drops a target whose cached URL or digest went bad", () => {
    const tampered = JSON.parse(stored) as {
      targets: Record<string, { url: string; sha256: string }>;
    };
    tampered.targets["darwin-arm64"].url = "http://example.test/evil.tar.gz";
    expect(parseCliReleaseManifest(JSON.stringify(tampered))).toBeNull();

    const shortDigest = JSON.parse(stored) as {
      targets: Record<string, { url: string; sha256: string }>;
    };
    shortDigest.targets["darwin-arm64"].sha256 = "abc";
    expect(parseCliReleaseManifest(JSON.stringify(shortDigest))).toBeNull();
  });
});

// The Pages Function keeps its own copy of the CLI's distribution contract
// (cli/distribution.ts): importing across the project root is untested for
// the Cloudflare bundle. Each way the copies could drift is checked here —
// a target added on one side only, a renamed schema, a digest parsed
// differently. Asset names are covered by the tests above.
describe("the Pages copy of the CLI distribution contract", () => {
  test("serves the targets the CLI ships, under the same schema", () => {
    expect([...CLI_INSTALL_TARGETS].sort()).toEqual([...SUPPORTED_CLI_INSTALL_TARGETS].sort());
    expect(CLI_RELEASE_SCHEMA).toBe(DISTRIBUTION_SCHEMA);
  });

  test("parses release digests as the installers do", () => {
    for (const digest of [`sha256:${"AB".repeat(32)}`, "sha256:abc", " sha256:" + SHA, undefined, ""]) {
      expect(parseGithubSha256(digest)).toBe(parseDistributionSha256(digest));
    }
  });
});
