import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import appPackage from "../../package.json";
import sitePackage from "../../site/package.json";
import tauriConf from "../../src-tauri/tauri.conf.json";

// A release bumps the version in five places by hand (the shiori-release
// skill, step 1). Readers disagree on which one they trust: the updater and
// the CI release jobs read tauri.conf.json, scripts/prepare-release-notes.ts
// reads package.json and names notes/<version>.json after it. Any file left
// behind ships notes and binaries under two different versions.
test("every copy of the app version agrees", () => {
  const cargoToml = readFileSync(
    new URL("../../src-tauri/Cargo.toml", import.meta.url),
    "utf8",
  );
  const cargoLock = readFileSync(
    new URL("../../src-tauri/Cargo.lock", import.meta.url),
    "utf8",
  );
  const version = tauriConf.version;
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect({
    "package.json": appPackage.version,
    "site/package.json": sitePackage.version,
    "src-tauri/Cargo.toml": /^\[package\][^[]*?^version = "([^"]+)"/m.exec(cargoToml)?.[1],
    "src-tauri/Cargo.lock": /^name = "shiori"\nversion = "([^"]+)"/m.exec(cargoLock)?.[1],
  }).toEqual({
    "package.json": version,
    "site/package.json": version,
    "src-tauri/Cargo.toml": version,
    "src-tauri/Cargo.lock": version,
  });
});
