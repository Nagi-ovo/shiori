import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AUDITED_BUN_VERSION,
  AUDITED_LICENSE_TREE_SHA256,
  AUDITED_NODE_VERSION,
  assertAuditedBundledPackages,
  assertAuditedExternalImports,
  assertAuditedLicenseTreeDigest,
  assertAuditedFontkitBundleDigest,
  assertAuditedBunVersion,
  assertSeaBuildNodeVersion,
  SUPPORTED_CLI_TARGETS,
  cliTargetName,
  copyCliLicense,
  findNodeLicense,
  nativeCoreFiles,
  pdfiumTargetForCliTarget,
  seaStripArgs,
} from "../build";
import { PDFIUM_ARCHIVES } from "../../scripts/pdfium/fetch";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-build-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Shiori CLI distribution build", () => {
  test("finds Node licenses in Windows and Unix distribution layouts", async () => {
    await withTempDir(async (dir) => {
      const bin = join(dir, "bin");
      const executable = join(bin, "node.exe");
      await mkdir(bin);
      await writeFile(executable, "");

      const beside = join(bin, "LICENSE");
      await writeFile(beside, "windows");
      await expect(findNodeLicense(executable)).resolves.toBe(beside);

      await rm(beside);
      const above = join(dir, "LICENSE");
      await writeFile(above, "unix");
      await expect(findNodeLicense(executable)).resolves.toBe(above);
    });
  });

  test("ships the repository LICENSE at the archive root", async () => {
    await withTempDir(async (dir) => {
      const repoRoot = join(dir, "repo");
      const outputDir = join(dir, "dist");
      await mkdir(repoRoot);
      await mkdir(outputDir);
      await writeFile(join(repoRoot, "LICENSE"), "MIT License\n");

      await copyCliLicense(outputDir, repoRoot);
      expect(await readFile(join(outputDir, "LICENSE"), "utf8")).toBe("MIT License\n");
    });
  });

  test("refuses to package without the repository LICENSE", async () => {
    await withTempDir(async (dir) => {
      await expect(copyCliLicense(dir, join(dir, "missing-repo"))).rejects.toThrow(
        "CLI archive must ship the repository LICENSE",
      );
    });
  });

  test("pins Node because SEA bytes and bundled runtime are version-sensitive", () => {
    expect(() => assertSeaBuildNodeVersion(AUDITED_NODE_VERSION)).not.toThrow();
    expect(() => assertSeaBuildNodeVersion("25.9.0")).toThrow(
      `Node.js ${AUDITED_NODE_VERSION} is required`,
    );
    expect(() => assertSeaBuildNodeVersion("27.0.0")).toThrow(
      `Node.js ${AUDITED_NODE_VERSION} is required`,
    );
  });

  test("pins Bun because minified bundle bytes are version-sensitive", () => {
    expect(() => assertAuditedBunVersion(AUDITED_BUN_VERSION)).not.toThrow();
    expect(() => assertAuditedBunVersion("1.3.13")).toThrow(
      `Bun ${AUDITED_BUN_VERSION} is required`,
    );
  });

  // A release target without a pinned, hashed PDFium would ship an addon
  // with nothing to bind; one added to the matrix must bring its build.
  test("every release target has a pinned PDFium build to ship beside the addon", () => {
    for (const target of SUPPORTED_CLI_TARGETS) {
      expect(PDFIUM_ARCHIVES[pdfiumTargetForCliTarget(target)]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(() => pdfiumTargetForCliTarget("darwin-x64")).toThrow();
    expect(nativeCoreFiles("win32-x64").pdfium).toBe("pdfium.dll");
    expect(nativeCoreFiles("darwin-arm64").pdfium).toBe("libpdfium.dylib");
    expect(nativeCoreFiles("linux-arm64-gnu").pdfium).toBe("libpdfium.so");
  });

  test("labels Linux distributions as glibc rather than generic Linux", () => {
    expect(cliTargetName("linux", "x64")).toBe("linux-x64-gnu");
    expect(cliTargetName("linux", "arm64")).toBe("linux-arm64-gnu");
    expect(cliTargetName("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliTargetName("win32", "x64")).toBe("win32-x64");
  });

  test("never strips a Linux SEA after its ELF note is injected", () => {
    expect(seaStripArgs("linux")).toBeNull();
    expect(seaStripArgs("darwin")).toEqual(["-x"]);
    expect(seaStripArgs("win32")).toBeNull();
  });

  test("forces a new license audit when the prebundled fontkit blob changes", () => {
    expect(() =>
      assertAuditedFontkitBundleDigest(
        "d60739f02b41b636ee0cc2fb79ba589958144f9240e585dbc19e6a3b08d82825",
      ),
    ).not.toThrow();
    expect(() => assertAuditedFontkitBundleDigest("changed")).toThrow(
      "refresh SBOM.md",
    );
  });

  test("fails closed when the reachable npm dependency set changes", () => {
    const audited = [
      "@pdf-lib/fontkit",
      "@pdf-lib/standard-fonts",
      "@pdf-lib/upng",
      "entities",
      "nanoid",
      "pako",
      "parse5",
      "pdf-lib",
      "tslib",
    ];
    expect(() => assertAuditedBundledPackages(audited)).not.toThrow();
    expect(() => assertAuditedBundledPackages([...audited, "new-package"])).toThrow(
      "refresh SBOM.md",
    );
    expect(() => assertAuditedBundledPackages(audited.slice(1))).toThrow(
      "refresh SBOM.md",
    );
  });

  test("allows only Node builtins to remain external", () => {
    expect(() =>
      assertAuditedExternalImports([
        { path: "fs/promises", original: "node:fs/promises", external: true },
        { path: "node:path", external: true },
        { path: "ignored", external: false },
      ]),
    ).not.toThrow();
    expect(() =>
      assertAuditedExternalImports([
        { path: "new-package", external: true },
      ]),
    ).toThrow("unaudited external imports");
  });

  test("forces a new audit when any packaged license text changes", () => {
    expect(() =>
      assertAuditedLicenseTreeDigest(AUDITED_LICENSE_TREE_SHA256),
    ).not.toThrow();
    expect(() => assertAuditedLicenseTreeDigest("changed")).toThrow(
      "refresh SBOM.md",
    );
  });
});
