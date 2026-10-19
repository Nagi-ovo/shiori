import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { builtinModules } from "node:module";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "./package.json" with { type: "json" };
import {
  PDFIUM_ARCHIVES,
  PDFIUM_VERSION,
  fetchPdfium,
  type PdfiumTarget,
} from "../scripts/pdfium/fetch";
import { renderRustNotices, RUST_NOTICES_PATH } from "../scripts/pdfium/rust-notices";

const CLI_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CLI_ROOT, "..");
export function cliTargetName(
  operatingSystem: NodeJS.Platform,
  cpuArchitecture: string,
): string {
  return operatingSystem === "linux"
    ? `linux-${cpuArchitecture}-gnu`
    : `${operatingSystem}-${cpuArchitecture}`;
}

/**
 * Node SEA stores its payload in an ELF note on Linux. GNU strip runs after
 * `node --build-sea`, so stripping that executable can remove or rewrite the
 * injected note while leaving the SEA fuse enabled, producing a startup
 * segfault before the embedded JavaScript runs. Mach-O uses a dedicated SEA
 * segment and still needs its existing size-reduction pass before signing.
 *
 * Stripping was NOT behind the darwin-x64 startup SIGSEGV. An unstripped
 * darwin-x64 build was tried in CI (41e2af13) and crashed identically; the
 * real cause is upstream Mach-O chained-fixup corruption in `--build-sea`,
 * and that target is no longer built. See SUPPORTED_CLI_TARGETS.
 */
export function seaStripArgs(
  operatingSystem: NodeJS.Platform,
): string[] | null {
  return operatingSystem === "darwin" ? ["-x"] : null;
}

/**
 * codesign arguments for the packaged executable.
 *
 * An ad-hoc signature (`--sign -`) is the floor, not a choice: arm64 macOS
 * refuses to execute an unsigned Mach-O at all. It carries no identity, so a
 * user who acquires the archive through a browser — which stamps quarantine —
 * gets "Apple cannot check it for malicious software".
 *
 * With an identity we sign for real and turn on the hardened runtime, which
 * notarization requires. `--timestamp` matters because a signature without
 * one stops verifying the day the certificate expires, rather than staying
 * valid for what was signed while it was live.
 */
export function cliCodesignArgs(
  operatingSystem: NodeJS.Platform,
  identity: string | undefined,
  executable: string,
): string[] | null {
  if (operatingSystem !== "darwin") return null;
  const trimmed = identity?.trim();
  if (!trimmed) return ["--force", "--sign", "-", executable];
  return [
    "--force",
    "--sign",
    trimmed,
    "--options",
    "runtime",
    "--timestamp",
    executable,
  ];
}

const CURRENT_TARGET = cliTargetName(platform(), arch());
export const AUDITED_FONTKIT_SHA256 =
  "d60739f02b41b636ee0cc2fb79ba589958144f9240e585dbc19e6a3b08d82825";
export const AUDITED_NOTO_SC_SHA256 =
  "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9";
export const AUDITED_NOTO_JP_SHA256 =
  "dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073";
export const AUDITED_BUN_VERSION = "1.3.12";
export const AUDITED_NODE_VERSION = "26.5.0";
export const AUDITED_LICENSE_TREE_SHA256 =
  "95df4336ace1280caaea39706ef2f119e43c01c9a1ed232fee09ca8ab27ad7b3";
export const AUDITED_LICENSE_FILES = [
  "Apache-2.0.txt",
  "fontkit-bundle/base64-arraybuffer-MIT.txt",
  "fontkit-bundle/base64-js-1.3.0-MIT.txt",
  "fontkit-bundle/base64-js-1.3.1-MIT.txt",
  "fontkit-bundle/buffer-MIT.txt",
  "fontkit-bundle/clone-MIT.txt",
  "fontkit-bundle/deep-equal-MIT.txt",
  "fontkit-bundle/define-properties-MIT.txt",
  "fontkit-bundle/es-abstract-MIT.txt",
  "fontkit-bundle/function-bind-MIT.txt",
  "fontkit-bundle/HarfBuzz-old-MIT.txt",
  "fontkit-bundle/has-MIT.txt",
  "fontkit-bundle/has-symbols-MIT.txt",
  "fontkit-bundle/iconv-lite-MIT.txt",
  "fontkit-bundle/ieee754-BSD-3-Clause.txt",
  "fontkit-bundle/is-arguments-MIT.txt",
  "fontkit-bundle/is-date-object-MIT.txt",
  "fontkit-bundle/is-regex-MIT.txt",
  "fontkit-bundle/metadata-declared-licenses.txt",
  "fontkit-bundle/object-is-MIT.txt",
  "fontkit-bundle/object-keys-MIT.txt",
  "fontkit-bundle/pdf-lib-unicode-properties-MIT.txt",
  "fontkit-bundle/process-es6-MIT.txt",
  "fontkit-bundle/regexp.prototype.flags-MIT.txt",
  "fontkit-bundle/safe-buffer-MIT.txt",
  "fontkit-bundle/safer-buffer-MIT.txt",
  "fontkit-bundle/string_decoder-MIT.txt",
  "fontkit-bundle/tiny-inflate-1.0.3-MIT.txt",
  "fontkit-bundled-NOTICES.txt",
  "Noto-CJK-OFL-1.1.txt",
  "pdf-lib-fontkit-MIT.txt",
  "pdfium/abseil.txt",
  "pdfium/agg23.txt",
  "pdfium/fast_float.txt",
  "pdfium/freetype.txt",
  "pdfium/icu.txt",
  "pdfium/lcms.txt",
  "pdfium/libjpeg_turbo.ijg",
  "pdfium/libjpeg_turbo.md",
  "pdfium/libopenjpeg.txt",
  "pdfium/libpng.txt",
  "pdfium/libtiff.txt",
  "pdfium/llvm-libc.txt",
  "pdfium/pdfium-binaries-MIT.txt",
  "pdfium/pdfium.txt",
  "pdfium/simdutf.txt",
  "pdfium/zlib.txt",
  "rust-crates-NOTICES.txt",
] as const;
const AUDITED_DEPENDENCIES = [
  ["node_modules/pdf-lib/package.json", "pdf-lib", "1.17.1", "MIT"],
  ["node_modules/@pdf-lib/fontkit/package.json", "@pdf-lib/fontkit", "1.1.1", "MIT"],
  ["node_modules/@pdf-lib/standard-fonts/package.json", "@pdf-lib/standard-fonts", "1.0.0", "MIT"],
  ["node_modules/@pdf-lib/upng/package.json", "@pdf-lib/upng", "1.0.1", "MIT"],
  ["node_modules/pako/package.json", "pako", "1.0.11", "(MIT AND Zlib)"],
  ["node_modules/parse5/package.json", "parse5", "7.3.0", "MIT"],
  ["node_modules/parse5/node_modules/entities/package.json", "entities", "6.0.1", "BSD-2-Clause"],
  ["node_modules/nanoid/package.json", "nanoid", "5.1.16", "MIT"],
  ["node_modules/tslib/package.json", "tslib", "2.8.1", "0BSD"],
] as const;
const AUDITED_BUNDLED_PACKAGES = AUDITED_DEPENDENCIES.map(
  ([, name]) => name,
).sort((a, b) => a.localeCompare(b));
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);
// darwin-x64 is deliberately absent. `node --build-sea` corrupts Mach-O
// chained fixups on x86_64, so the packaged CLI segfaults in dyld before any
// JavaScript runs — 100% reproducible, and nothing in this repo can fix it.
// Node.js skipped its own SEA tests on x64 macOS rather than fix it
// (nodejs/node#60250, tracking nodejs/node#62893), and pnpm dropped the same
// artifact for the same reason (pnpm/pnpm#11455). Shipping a binary that
// cannot start is worse than not shipping one. See docs/POSTMORTEMS.md.
export const SUPPORTED_CLI_TARGETS = [
  "darwin-arm64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-arm64",
  "win32-x64",
] as const;
const SUPPORTED_TARGETS = new Set<string>(SUPPORTED_CLI_TARGETS);
// shiori-core's PDFium build for each CLI target (scripts/pdfium/fetch.ts).
const PDFIUM_TARGET_BY_TARGET: Readonly<Record<string, PdfiumTarget>> = {
  "darwin-arm64": "mac-arm64",
  "linux-arm64-gnu": "linux-arm64",
  "linux-x64-gnu": "linux-x64",
  "win32-arm64": "win-arm64",
  "win32-x64": "win-x64",
};

async function main(): Promise<void> {
  assertAuditedBunVersion(Bun.version);
  const nodeVersionOutput = await run("node", ["--version"]);
  assertSeaBuildNodeVersion(nodeVersionOutput.replace(/^v/, ""));
  const requested = optionValue(process.argv.slice(2), "--target") ?? "current";
  const target = requested === "current" ? CURRENT_TARGET : requested;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`Unsupported CLI target: ${target}`);
  }
  if (target !== CURRENT_TARGET) {
    throw new Error(
      `Target ${target} must be built on its matching CI runner (current: ${CURRENT_TARGET})`,
    );
  }
  await assertAuditedInputs();

  const buildDir = join(CLI_ROOT, ".build", target);
  const outputDir = join(CLI_ROOT, "dist", target);
  const executableName = platform() === "win32" ? "shiori.exe" : "shiori";
  const executable = join(outputDir, executableName);
  await rm(buildDir, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const bundlePath = join(buildDir, "shiori.mjs");
  const metafilePath = join(buildDir, "bundle-meta.json");
  const build = await Bun.build({
    entrypoints: [join(CLI_ROOT, "src", "main.ts")],
    outdir: buildDir,
    naming: basename(bundlePath),
    target: "node",
    format: "esm",
    packages: "bundle",
    minify: true,
    metafile: metafilePath,
    sourcemap: "none",
  });
  if (!build.success) {
    throw new AggregateError(build.logs, "Could not bundle Shiori CLI");
  }
  await assertAuditedBundleMetafile(metafilePath);
  assertBundleDefinesEachErrorClassOnce(await readFile(bundlePath, "utf8"));

  const seaConfigPath = join(buildDir, "sea-config.json");
  await writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: bundlePath,
        mainFormat: "module",
        output: executable,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgvExtension: "none",
      },
      null,
      2,
    )}\n`,
  );
  await run("node", ["--build-sea", seaConfigPath]);
  if (platform() !== "win32") await chmod(executable, 0o755);
  const stripArgs = seaStripArgs(platform());
  if (stripArgs) await run("strip", [...stripArgs, executable]);
  if (process.env.SHIORI_CLI_SKIP_ADHOC_SIGN !== "1") {
    const signArgs = cliCodesignArgs(
      platform(),
      process.env.SHIORI_CLI_SIGN_IDENTITY,
      executable,
    );
    if (signArgs) await run("codesign", signArgs);
  }

  await copyRuntimeAssets(outputDir);
  await copyNativeCore(outputDir, target);
  await copyNotices(outputDir);
  const files = await distributionFiles(outputDir);
  await writeFile(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(
      {
        schema: "shiori.cli-distribution/v2",
        name: packageJson.name,
        version: packageJson.version,
        target,
        runtime: `node ${nodeVersionOutput}`,
        // Bun.build minification changes across Bun releases, so the file
        // hashes below are only reproducible from source with this bundler.
        bundler: `bun ${Bun.version}`,
        executable: executableName,
        assets: "assets/",
        native: "native/",
        audits: {
          fontkitSha256: AUDITED_FONTKIT_SHA256,
          notoSansScSha256: AUDITED_NOTO_SC_SHA256,
          notoSansJpSha256: AUDITED_NOTO_JP_SHA256,
          licenseTreeSha256: AUDITED_LICENSE_TREE_SHA256,
          pdfium: `chromium/${PDFIUM_VERSION}`,
          pdfiumArchiveSha256: PDFIUM_ARCHIVES[pdfiumTargetForCliTarget(target)],
        },
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log(outputDir);
}

async function assertAuditedInputs(): Promise<void> {
  for (const [path, expectedName, expectedVersion, expectedLicense] of
    AUDITED_DEPENDENCIES) {
    const value = JSON.parse(await readFile(join(REPO_ROOT, path), "utf8")) as {
      name?: string;
      version?: string;
      license?: string;
    };
    if (
      value.name !== expectedName ||
      value.version !== expectedVersion ||
      value.license !== expectedLicense
    ) {
      throw new Error(
        `${expectedName} metadata changed; refresh SBOM.md and bundled license notices before release`,
      );
    }
  }
  assertAuditedFontkitBundleDigest(
    createHash("sha256")
      .update(
        await readFile(
          join(
            REPO_ROOT,
            "node_modules",
            "@pdf-lib",
            "fontkit",
            "dist",
            "fontkit.umd.js",
          ),
        ),
      )
      .digest("hex"),
  );
  await assertAuditedFile(
    join(REPO_ROOT, "src", "assets", "fonts", "NotoSansSC-Regular.otf"),
    AUDITED_NOTO_SC_SHA256,
    "Noto Sans SC font",
  );
  await assertAuditedFile(
    join(REPO_ROOT, "src", "assets", "fonts", "NotoSansJP-Regular.otf"),
    AUDITED_NOTO_JP_SHA256,
    "Noto Sans JP font",
  );
  const licenseRoot = join(CLI_ROOT, "licenses");
  const actualLicenseFiles = (await distributionFiles(licenseRoot)).map(
    ({ path }) => path,
  );
  if (
    JSON.stringify(actualLicenseFiles) !== JSON.stringify(AUDITED_LICENSE_FILES)
  ) {
    throw new Error(
      "CLI license file inventory changed; refresh SBOM.md and the license audit before release",
    );
  }
  assertAuditedLicenseTreeDigest(await auditedLicenseTreeDigest(licenseRoot));
}

async function assertAuditedFile(
  path: string,
  expected: string,
  label: string,
): Promise<void> {
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `${label} changed; refresh SBOM.md and bundled license notices before release`,
    );
  }
}

export function assertAuditedFontkitBundleDigest(actual: string): void {
  if (actual !== AUDITED_FONTKIT_SHA256) {
    throw new Error(
      "@pdf-lib/fontkit bundle changed; refresh SBOM.md and bundled license notices before release",
    );
  }
}

export function assertAuditedBundledPackages(actual: readonly string[]): void {
  const normalized = [...new Set(actual)].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(normalized) !== JSON.stringify(AUDITED_BUNDLED_PACKAGES)) {
    throw new Error(
      `CLI bundled dependency set changed (${normalized.join(", ")}); refresh SBOM.md and bundled license notices before release`,
    );
  }
}

type MetafileImport = {
  path?: string;
  original?: string;
  external?: boolean;
};

export function assertAuditedExternalImports(
  imports: readonly MetafileImport[],
): void {
  const unexpected = imports
    .filter(({ external }) => external === true)
    .filter(({ path, original }) => {
      const references = [path, original].filter(
        (value): value is string => typeof value === "string" && value !== "",
      );
      return (
        references.length === 0 ||
        references.some((value) => !isNodeBuiltinImport(value))
      );
    })
    .map(({ path, original }) => original ?? path ?? "<empty>");
  if (unexpected.length > 0) {
    throw new Error(
      `CLI bundle contains unaudited external imports: ${unexpected.join(", ")}`,
    );
  }
}

/**
 * Each error class once: a module bundled twice brings its classes twice,
 * and an instanceof against one copy misses errors thrown by the other, so
 * the packaged CLI misreports them while every test from source passes.
 * Bun did this when the entry carried a `#!/usr/bin/env bun` line (it then
 * linked that entry for the bun target and its imports for node as well).
 * Class names survive minification, so `this.name = "…"` finds the copies.
 */
export function assertBundleDefinesEachErrorClassOnce(bundle: string): void {
  const seen = new Map<string, number>();
  for (const [, name] of bundle.matchAll(/this\.name\s*=\s*"([^"]+)"/g)) {
    seen.set(name!, (seen.get(name!) ?? 0) + 1);
  }
  const duplicated = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
  if (duplicated.length > 0) {
    throw new Error(
      `CLI bundle defines these error classes more than once, so a module is bundled twice: ${duplicated.join(", ")}`,
    );
  }
}

async function assertAuditedBundleMetafile(path: string): Promise<void> {
  const metafile = JSON.parse(await readFile(path, "utf8")) as {
    inputs?: Record<string, { imports?: MetafileImport[] }>;
    outputs?: Record<string, unknown>;
  };
  if (!metafile.inputs || !metafile.outputs) {
    throw new Error("CLI bundle metafile is missing inputs or outputs");
  }
  const packages = Object.keys(metafile.inputs).flatMap((input) => {
    const name = packageNameFromModulePath(input);
    return name ? [name] : [];
  });
  assertAuditedBundledPackages(packages);
  assertAuditedExternalImports(
    Object.values(metafile.inputs).flatMap(({ imports = [] }) => imports),
  );
}

function isNodeBuiltinImport(path: string): boolean {
  return (
    NODE_BUILTINS.has(path) || NODE_BUILTINS.has(path.replace(/^node:/, ""))
  );
}

function packageNameFromModulePath(modulePath: string): string | null {
  const parts = modulePath.replaceAll("\\", "/").split("/");
  const index = parts.lastIndexOf("node_modules");
  const first = index >= 0 ? parts[index + 1] : undefined;
  if (!first) return null;
  if (!first.startsWith("@")) return first;
  const second = parts[index + 2];
  return second ? `${first}/${second}` : null;
}

export function assertAuditedLicenseTreeDigest(actual: string): void {
  if (actual !== AUDITED_LICENSE_TREE_SHA256) {
    throw new Error(
      "CLI license texts changed; refresh SBOM.md and the license audit before release",
    );
  }
}

export async function auditedLicenseTreeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of AUDITED_LICENSE_FILES) {
    const bytes = await readFile(join(root, ...path.split("/")));
    hash.update(`${path}\0${bytes.byteLength}\0`);
    hash.update(createHash("sha256").update(bytes).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function copyRuntimeAssets(outputDir: string): Promise<void> {
  const assets = join(outputDir, "assets");
  await mkdir(join(assets, "fonts"), { recursive: true });
  await copyFile(
    join(REPO_ROOT, "src", "assets", "fonts", "NotoSansSC-Regular.otf"),
    join(assets, "fonts", "NotoSansSC-Regular.otf"),
  );
  await copyFile(
    join(REPO_ROOT, "src", "assets", "fonts", "NotoSansJP-Regular.otf"),
    join(assets, "fonts", "NotoSansJP-Regular.otf"),
  );
}

export function pdfiumTargetForCliTarget(target: string): PdfiumTarget {
  const pdfium = PDFIUM_TARGET_BY_TARGET[target];
  if (!pdfium) throw new Error(`No pinned PDFium build for target ${target}`);
  return pdfium;
}

/** File names inside `native/`: the shiori-core addon and the PDFium it binds. */
export function nativeCoreFiles(target: string): { addon: string; pdfium: string } {
  const os = target.split("-")[0];
  return {
    addon: "shiori_core.node",
    pdfium: os === "win32" ? "pdfium.dll" : os === "darwin" ? "libpdfium.dylib" : "libpdfium.so",
  };
}

/**
 * Builds the shiori-core addon for this runner's target and puts it in
 * `native/` beside the pinned PDFium (cli/src/coreEngine.ts loads them from
 * there). On macOS both are signed like the executable: a hardened runtime
 * only loads libraries signed by the same team.
 */
/** Where two texts part, for a failure that only one platform's runner sees. */
function firstDifference(expected: string, actual: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const line = a.findIndex((text, i) => text !== b[i]);
  const at = line === -1 ? a.length : line;
  return [
    `committed ${expected.length} chars / ${a.length} lines, rendered ${actual.length} chars / ${b.length} lines`,
    `first difference at line ${at + 1}:`,
    `  committed: ${JSON.stringify(a[at] ?? "<end>")}`,
    `  rendered:  ${JSON.stringify(b[at] ?? "<end>")}`,
  ].join("\n");
}

async function copyNativeCore(outputDir: string, target: string): Promise<void> {
  const rendered = renderRustNotices();
  const committed = await readFile(RUST_NOTICES_PATH, "utf8");
  if (rendered !== committed) {
    throw new Error(
      "Rust dependency notices are stale; run bun scripts/pdfium/rust-notices.ts and refresh SBOM.md\n" +
        firstDifference(committed, rendered),
    );
  }
  const pdfiumDir = await fetchPdfium(pdfiumTargetForCliTarget(target));
  await run("cargo", [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    join(REPO_ROOT, "crates", "shiori-core-node", "Cargo.toml"),
  ]);
  const native = join(outputDir, "native");
  await mkdir(native, { recursive: true });
  const files = nativeCoreFiles(target);
  const os = target.split("-")[0];
  const built =
    os === "win32"
      ? "shiori_core_node.dll"
      : os === "darwin"
        ? "libshiori_core_node.dylib"
        : "libshiori_core_node.so";
  await copyFile(
    join(REPO_ROOT, "crates", "shiori-core-node", "target", "release", built),
    join(native, files.addon),
  );
  await copyFile(
    join(pdfiumDir, os === "win32" ? "bin" : "lib", files.pdfium),
    join(native, files.pdfium),
  );
  if (process.env.SHIORI_CLI_SKIP_ADHOC_SIGN !== "1") {
    for (const file of [files.addon, files.pdfium]) {
      const signArgs = cliCodesignArgs(
        platform(),
        process.env.SHIORI_CLI_SIGN_IDENTITY,
        join(native, file),
      );
      if (signArgs) await run("codesign", signArgs);
    }
  }
}

async function copyNotices(outputDir: string): Promise<void> {
  await copyFile(join(CLI_ROOT, "README.md"), join(outputDir, "README.md"));
  await copyFile(join(CLI_ROOT, "SBOM.md"), join(outputDir, "SBOM.md"));
  await copyFile(
    join(CLI_ROOT, "THIRD_PARTY_NOTICES.md"),
    join(outputDir, "THIRD_PARTY_NOTICES.md"),
  );
  await copyCliLicense(outputDir);
  const licensesDir = join(outputDir, "licenses");
  await cp(join(CLI_ROOT, "licenses"), licensesDir, { recursive: true });
  const nodeExecutable = (await run("node", ["-p", "process.execPath"])).trim();
  await copyFile(
    await findNodeLicense(nodeExecutable),
    join(licensesDir, "Node.js-LICENSE.txt"),
  );
  const licenses: Array<[string, string]> = [
    ["node_modules/pdf-lib/LICENSE.md", "pdf-lib-MIT.txt"],
    ["node_modules/@pdf-lib/standard-fonts/LICENSE.md", "pdf-lib-standard-fonts-MIT.txt"],
    ["node_modules/@pdf-lib/upng/LICENSE", "pdf-lib-upng-MIT.txt"],
    ["node_modules/pako/LICENSE", "pako-MIT-Zlib.txt"],
    ["node_modules/parse5/LICENSE", "parse5-MIT.txt"],
    [
      "node_modules/parse5/node_modules/entities/LICENSE",
      "entities-BSD-2-Clause.txt",
    ],
    ["node_modules/nanoid/LICENSE", "nanoid-MIT.txt"],
    ["node_modules/tslib/LICENSE.txt", "tslib-0BSD.txt"],
  ];
  for (const [source, destination] of licenses) {
    await copyFile(join(REPO_ROOT, source), join(licensesDir, destination));
  }
}

// The CLI is MIT like the rest of the repository; MIT requires the notice to
// travel with every copy, so the archive carries the root LICENSE. It sits at
// the archive root, outside the audited licenses/ tree of third-party texts.
export async function copyCliLicense(
  outputDir: string,
  repoRoot: string = REPO_ROOT,
): Promise<void> {
  const source = join(repoRoot, "LICENSE");
  try {
    await access(source);
  } catch {
    throw new Error(
      `CLI archive must ship the repository LICENSE, but ${source} is missing`,
    );
  }
  await copyFile(source, join(outputDir, "LICENSE"));
}

export async function findNodeLicense(nodeExecutable: string): Promise<string> {
  const candidates = [
    join(dirname(nodeExecutable), "LICENSE"),
    resolve(dirname(nodeExecutable), "..", "LICENSE"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next layout. Windows distributions commonly keep the
      // license beside node.exe; Unix installations commonly keep it above bin/.
    }
  }
  throw new Error(
    `Could not find the Node.js LICENSE beside or above ${nodeExecutable}`,
  );
}

export type DistributionFile = {
  path: string;
  size: number;
  sha256: string;
};

export async function distributionFiles(
  root: string,
  options: { exclude?: (path: string) => boolean } = {},
): Promise<DistributionFile[]> {
  const files: DistributionFile[] = [];
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (path === "manifest.json") continue;
      if (options.exclude?.(path)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Distribution contains unsupported entry: ${path}`);
      }
      const bytes = await readFile(absolute);
      files.push({
        path,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}

export function assertSeaBuildNodeVersion(version: string): void {
  if (version !== AUDITED_NODE_VERSION) {
    throw new Error(
      `Node.js ${AUDITED_NODE_VERSION} is required for reproducible CLI SEA builds (found ${version})`,
    );
  }
}

export function assertAuditedBunVersion(version: string): void {
  if (version !== AUDITED_BUN_VERSION) {
    throw new Error(
      `Bun ${AUDITED_BUN_VERSION} is required for reproducible CLI bundles (found ${version})`,
    );
  }
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

async function run(command: string, args: string[]): Promise<string> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else rejectRun(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
