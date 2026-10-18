import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { refreshDistributionManifest } from "../manifest";
import {
  AUDITED_BUN_VERSION,
  AUDITED_FONTKIT_SHA256,
  AUDITED_LICENSE_TREE_SHA256,
  AUDITED_NODE_VERSION,
  AUDITED_NOTO_JP_SHA256,
  AUDITED_NOTO_SC_SHA256,
} from "../build";
import packageJson from "../package.json" with { type: "json" };

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-manifest-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("CLI post-signing manifest refresh", () => {
  test("updates hashes without rebuilding, replacing, or deleting signed files", async () => {
    await withTempDir(async (dir) => {
      const executable = join(dir, "shiori");
      const bindingDirectory = join(
        dir,
        "node_modules",
        "@napi-rs",
        "canvas-darwin-arm64",
      );
      const binding = join(bindingDirectory, "skia.darwin-arm64.node");
      const signature = join(dir, "shiori.signature");
      await mkdir(bindingDirectory, { recursive: true });
      await writeFile(executable, "signed executable bytes");
      await writeFile(binding, "signed native binding bytes");
      await writeFile(signature, "release signature bytes");
      await writeFile(
        join(dir, "manifest.json"),
        `${JSON.stringify({
          ...validManifest(),
          schema: "shiori.cli-distribution/v2",
          name: packageJson.name,
          version: packageJson.version,
          target: "darwin-arm64",
          runtime: `node v${AUDITED_NODE_VERSION}`,
          bundler: `bun ${AUDITED_BUN_VERSION}`,
          executable: "shiori",
          files: [{ path: "shiori", size: 1, sha256: "stale" }],
        })}\n`,
      );
      const executableBefore = await stat(executable);
      const bindingBefore = await stat(binding);
      const executableBytes = await readFile(executable);
      const bindingBytes = await readFile(binding);

      await refreshDistributionManifest(dir, "darwin-arm64");

      expect(await readFile(executable)).toEqual(executableBytes);
      expect(await readFile(binding)).toEqual(bindingBytes);
      const executableAfter = await stat(executable);
      const bindingAfter = await stat(binding);
      expect(executableAfter.ino).toBe(executableBefore.ino);
      expect(bindingAfter.ino).toBe(bindingBefore.ino);
      expect(executableAfter.mtimeMs).toBe(executableBefore.mtimeMs);
      expect(bindingAfter.mtimeMs).toBe(bindingBefore.mtimeMs);
      expect((await readdir(dir)).sort()).toEqual(
        ["manifest.json", "node_modules", "shiori", "shiori.signature"].sort(),
      );

      const manifest = JSON.parse(
        await readFile(join(dir, "manifest.json"), "utf8"),
      ) as {
        runtime?: string;
        bundler?: string;
        files?: Array<{ path: string; size: number; sha256: string }>;
      };
      expect(manifest.runtime).toBe(`node v${AUDITED_NODE_VERSION}`);
      expect(manifest.bundler).toBe(`bun ${AUDITED_BUN_VERSION}`);
      expect(manifest.files).toEqual([
        {
          path: "node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node",
          size: bindingBytes.byteLength,
          sha256: digest(bindingBytes),
        },
        {
          path: "shiori",
          size: executableBytes.byteLength,
          sha256: digest(executableBytes),
        },
        {
          path: "shiori.signature",
          size: 23,
          sha256: digest(new TextEncoder().encode("release signature bytes")),
        },
      ]);
    });
  });

  test("refuses to invent or refresh an unrelated manifest", async () => {
    await withTempDir(async (dir) => {
      const payload = join(dir, "shiori");
      await writeFile(payload, "signed bytes");
      await expect(
        refreshDistributionManifest(dir, "darwin-arm64"),
      ).rejects.toThrow();
      await expect(readFile(payload, "utf8")).resolves.toBe("signed bytes");

      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          schema: "not-shiori",
          name: packageJson.name,
          version: packageJson.version,
          target: "darwin-arm64",
          files: [],
        }),
      );
      await expect(
        refreshDistributionManifest(dir, "darwin-arm64"),
      ).rejects.toThrow("invalid schema");
      await expect(readFile(payload, "utf8")).resolves.toBe("signed bytes");
    });
  });

  test("fails closed on stale manifest temps instead of signing them in", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const stale = join(dir, ".manifest.json.shiori-tmp-111-dead");
      await writeFile(join(dir, "shiori"), "signed bytes");
      await writeFile(manifestPath, JSON.stringify(validManifest()));
      await writeFile(stale, "partial manifest");
      const before = await readFile(manifestPath);

      await expect(
        refreshDistributionManifest(dir, "darwin-arm64"),
      ).rejects.toThrow("stale manifest temp");
      expect(await readFile(manifestPath)).toEqual(before);
      await expect(readFile(stale, "utf8")).resolves.toBe("partial manifest");
    });
  });

  test("validates every signed v2 invariant before refreshing", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "shiori"), "signed bytes");
      const invalid: Array<Record<string, unknown>> = [
        { ...validManifest(), runtime: 17 },
        { ...validManifest(), runtime: "node v25.9.0" },
        { ...validManifest(), bundler: null },
        { ...validManifest(), executable: "../../outside" },
        { ...validManifest(), assets: "/absolute" },
        { ...validManifest(), audits: {} },
        { ...validManifest(), unexpected: true },
      ];
      for (const manifest of invalid) {
        await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
        await expect(
          refreshDistributionManifest(dir, "darwin-arm64"),
        ).rejects.toThrow();
      }
    });
  });
});

function validManifest(): Record<string, unknown> {
  return {
    schema: "shiori.cli-distribution/v2",
    name: packageJson.name,
    version: packageJson.version,
    target: "darwin-arm64",
    runtime: `node v${AUDITED_NODE_VERSION}`,
    bundler: `bun ${AUDITED_BUN_VERSION}`,
    executable: "shiori",
    assets: "assets/",
    audits: {
      fontkitSha256: AUDITED_FONTKIT_SHA256,
      notoSansScSha256: AUDITED_NOTO_SC_SHA256,
      notoSansJpSha256: AUDITED_NOTO_JP_SHA256,
      licenseTreeSha256: AUDITED_LICENSE_TREE_SHA256,
    },
    files: [],
  };
}
