/**
 * Fetches the pinned PDFium build for one target into vendor/pdfium/<target>/.
 * Run: bun scripts/pdfium/fetch.ts [target]   (default: this machine)
 *
 * The version is pinned to the PDFium that pdfium-render's `pdfium_latest`
 * feature binds (pdfium-render 0.9.4 → chromium/7881), never "latest": a newer
 * PDFium can change FFI signatures under the same crate version. Each archive's
 * SHA-256 is pinned here; the hashes were taken on 2026-09-25 from the
 * bblanchon/pdfium-binaries release after `gh attestation verify` confirmed its
 * build provenance. Bumping PDFium means bumping pdfium-render, re-verifying
 * the attestation and replacing every hash below.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PDFIUM_VERSION = "7881";

export const PDFIUM_ARCHIVES = {
  "mac-arm64": "52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40",
  "mac-x64": "6dedf83990e0e3d6b7c93c9e7589c5a126b0ae14b7464d76120cff7a26afb18b",
  "linux-x64": "1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d",
  "linux-arm64": "ee7f7b7d5468958336a818c1cd580bdd20972846b7377b13f9a923d92d1d4674",
  "win-x64": "73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08",
  "win-arm64": "d3035d4d2cacac6ecd1a2ece197a3d702a1b2a58466276b9f870b8cb278a9d84",
  "android-arm64": "16d23bb86c4188d59326dc509938f59df3c417ecfdd3d2ca2f160dc5bd49a839",
  wasm: "added6e8ac024f71cb61cf2b77a205d178e2bdde2e4048fbcd916f68b7264d56",
} as const;

export type PdfiumTarget = keyof typeof PDFIUM_ARCHIVES;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function hostPdfiumTarget(): PdfiumTarget {
  const os = { darwin: "mac", linux: "linux", win32: "win" }[platform() as string];
  const cpu = { arm64: "arm64", x64: "x64" }[arch() as string];
  const target = `${os}-${cpu}`;
  if (!os || !cpu || !(target in PDFIUM_ARCHIVES)) {
    throw new Error(`No pinned PDFium build for ${platform()}-${arch()}`);
  }
  return target as PdfiumTarget;
}

export function pdfiumDir(target: PdfiumTarget): string {
  return join(REPO_ROOT, "vendor", "pdfium", target);
}

export async function fetchPdfium(target: PdfiumTarget): Promise<string> {
  const dir = pdfiumDir(target);
  const stamp = join(dir, ".sha256");
  const expected = PDFIUM_ARCHIVES[target];
  if (existsSync(stamp) && (await readFile(stamp, "utf8")).trim() === expected) {
    return dir;
  }
  const url =
    "https://github.com/bblanchon/pdfium-binaries/releases/download/" +
    `chromium%2F${PDFIUM_VERSION}/pdfium-${target}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error(`pdfium-${target}.tgz: SHA-256 ${actual}, pinned ${expected}`);
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const tgz = join(dir, "pdfium.tgz");
  await writeFile(tgz, archive);
  const untar = spawnSync("tar", ["-xzf", tgz, "-C", dir], { stdio: "inherit" });
  await rm(tgz);
  if (untar.status !== 0) throw new Error(`tar exited ${untar.status}`);
  await writeFile(stamp, `${expected}\n`);
  return dir;
}

if (import.meta.main) {
  const target = (process.argv[2] ?? hostPdfiumTarget()) as PdfiumTarget;
  if (!(target in PDFIUM_ARCHIVES)) {
    throw new Error(`Unknown target ${target}; one of ${Object.keys(PDFIUM_ARCHIVES).join(", ")}`);
  }
  console.log(await fetchPdfium(target));
}
