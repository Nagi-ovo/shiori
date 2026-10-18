/**
 * Stages PDFium for the desktop bundle being built, into src-tauri/pdfium/
 * (ignored by git): the library, which tauri.conf.json's platform files ship
 * (macOS Frameworks, Windows/Linux resources), and its license texts.
 * Runs as part of tauri.conf.json's beforeBuildCommand, which Tauri gives the
 * build's TAURI_ENV_TARGET_TRIPLE; a universal macOS build gets both
 * architectures joined with lipo. Mobile builds stage nothing (plan stage 5).
 * Run by hand: bun scripts/pdfium/stage-app.ts [target-triple]
 */
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchPdfium, type PdfiumTarget } from "./fetch";

const STAGE = resolve(import.meta.dir, "../../src-tauri/pdfium");

const BY_TRIPLE: Record<string, PdfiumTarget[]> = {
  "aarch64-apple-darwin": ["mac-arm64"],
  "x86_64-apple-darwin": ["mac-x64"],
  "universal-apple-darwin": ["mac-arm64", "mac-x64"],
  "x86_64-pc-windows-msvc": ["win-x64"],
  "aarch64-pc-windows-msvc": ["win-arm64"],
  "x86_64-unknown-linux-gnu": ["linux-x64"],
  "aarch64-unknown-linux-gnu": ["linux-arm64"],
};

function hostTriple(): string {
  const run = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = /^host: (.+)$/m.exec(run.stdout ?? "")?.[1];
  if (!host) throw new Error("Cannot tell the build target: set TAURI_ENV_TARGET_TRIPLE");
  return host;
}

export async function stageAppPdfium(triple: string): Promise<string | null> {
  if (/android|ios/.test(triple)) return null;
  const targets = BY_TRIPLE[triple];
  if (!targets) throw new Error(`No pinned PDFium for ${triple}`);
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  const dirs = await Promise.all(targets.map((target) => fetchPdfium(target)));
  const [first] = targets;
  const [firstDir] = dirs;
  if (first!.startsWith("mac")) {
    const libs = dirs.map((dir) => join(dir, "lib", "libpdfium.dylib"));
    if (libs.length === 1) {
      await copyFile(libs[0]!, join(STAGE, "libpdfium.dylib"));
    } else {
      const lipo = spawnSync("lipo", ["-create", ...libs, "-output", join(STAGE, "libpdfium.dylib")], {
        stdio: "inherit",
      });
      if (lipo.status !== 0) throw new Error(`lipo exited ${lipo.status}`);
    }
  } else if (first!.startsWith("win")) {
    await copyFile(join(firstDir!, "bin", "pdfium.dll"), join(STAGE, "pdfium.dll"));
  } else {
    await copyFile(join(firstDir!, "lib", "libpdfium.so"), join(STAGE, "libpdfium.so"));
  }
  // The license set is the same on every target (cli/licenses/pdfium/ keeps
  // the reviewed copy); ship the one built with this library.
  await cp(join(firstDir!, "licenses"), join(STAGE, "licenses"), { recursive: true });
  await copyFile(join(firstDir!, "LICENSE"), join(STAGE, "licenses", "pdfium-binaries-MIT.txt"));
  return STAGE;
}

if (import.meta.main) {
  const triple = process.argv[2] ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
  console.log((await stageAppPdfium(triple)) ?? `no PDFium for ${triple}`);
}
