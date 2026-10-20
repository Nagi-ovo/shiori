import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The release skill's last gate before announcing a release. It runs as a
// CLI, so it is driven as one: a local server stands in for gh-pages and the
// GitHub release, and every asset is signed with a throwaway minisign key.
//
// Ways the gate can wave a broken manifest through:
// - a platform points at an older release's asset whose own .sig is valid
//   (the client installs the old build and is offered the update again);
// - the version in the URL path and the one in the file name disagree;
// - a desktop platform is missing from the manifest altogether;
// - the manifest carries no version at all.
// And the way it can block a good release: rejecting the URL shapes the
// release really publishes (both macOS tarballs, msi, AppImage).

const SCRIPT = resolve(import.meta.dir, "../../.agents/skills/shiori-release/scripts/verify-updater-manifest.mjs");

const ASSET_NAMES = {
  "darwin-aarch64": (v: string) => `Shiori_${v}_aarch64.app.tar.gz`,
  "darwin-x86_64": (v: string) => `Shiori_${v}_universal.app.tar.gz`,
  "windows-x86_64": (v: string) => `Shiori_${v}_x64_en-US.msi`,
  "linux-x86_64": (v: string) => `Shiori_${v}_amd64.AppImage`,
} as const;
type PlatformKey = keyof typeof ASSET_NAMES;

const keyId = crypto.randomBytes(8);
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);

function minisignSignature(payload: Buffer): string {
  const signature = crypto.sign(null, payload, privateKey);
  const trusted = "timestamp:1\tfile:asset";
  const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
  const text = [
    "untrusted comment: test",
    Buffer.concat([Buffer.from("Ed"), keyId, signature]).toString("base64"),
    `trusted comment: ${trusted}`,
    global.toString("base64"),
  ].join("\n");
  return Buffer.from(`${text}\n`).toString("base64");
}

const files = new Map<string, Buffer | string>();
let requested: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let dir: string;
let configPath: string;

function publish(version: string, platform: PlatformKey): { url: string; signature: string } {
  const path = `/releases/download/v${version}/${ASSET_NAMES[platform](version)}`;
  const payload = Buffer.from(`${platform} ${version}`);
  const signature = minisignSignature(payload);
  files.set(path, payload);
  files.set(`${path}.sig`, signature);
  return { url: `${server.url.origin}${path}`, signature };
}

function fullManifest(version: string) {
  const platforms: Record<string, { url: string; signature: string }> = {};
  for (const platform of Object.keys(ASSET_NAMES) as PlatformKey[]) {
    platforms[platform] = publish(version, platform);
  }
  return { version, platforms };
}

async function verify(manifest: unknown, extraArgs: string[] = []) {
  files.set("/alpha/latest.json", JSON.stringify(manifest));
  requested = [];
  const proc = Bun.spawn(
    [process.execPath, SCRIPT, "--manifest", `${server.url.origin}/alpha/latest.json`, "--config", configPath, ...extraArgs],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      const body = files.get(path);
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
  dir = mkdtempSync(join(tmpdir(), "shiori-updater-verify-"));
  configPath = join(dir, "tauri.conf.json");
  const publicKeyText = `untrusted comment: test\n${Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]).toString("base64")}\n`;
  writeFileSync(
    configPath,
    JSON.stringify({ plugins: { updater: { pubkey: Buffer.from(publicKeyText).toString("base64") } } }),
  );
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("verify-updater-manifest", () => {
  test("passes a manifest whose every desktop platform is this version's signed asset", async () => {
    const result = await verify(fullManifest("26.10.21"));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    for (const platform of Object.keys(ASSET_NAMES)) expect(result.stdout).toContain(`OK ${platform}`);
  });

  test("fails a platform that still points at the previous release's correctly signed asset", async () => {
    const manifest = fullManifest("26.10.21");
    manifest.platforms["darwin-aarch64"] = publish("26.10.20", "darwin-aarch64");
    const result = await verify(manifest);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("darwin-aarch64");
    expect(result.stderr).toContain("26.10.21");
    expect(result.stdout).not.toContain("OK darwin-aarch64");
  });

  test("fails a URL whose file name is another version even under this version's tag", async () => {
    const manifest = fullManifest("26.10.21");
    // The old msi re-uploaded under the new tag, its .sig alongside.
    const stale = publish("26.10.20", "windows-x86_64");
    const path = new URL(stale.url).pathname.replace("/v26.10.20/", "/v26.10.21/");
    files.set(path, files.get(new URL(stale.url).pathname)!);
    files.set(`${path}.sig`, stale.signature);
    manifest.platforms["windows-x86_64"] = { url: `${server.url.origin}${path}`, signature: stale.signature };
    const result = await verify(manifest);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("windows-x86_64");
  });

  test("fails a manifest that leaves out a desktop platform", async () => {
    const manifest = fullManifest("26.10.21");
    delete manifest.platforms["windows-x86_64"];
    const result = await verify(manifest);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("windows-x86_64");
  });

  test("fails a manifest without a version before downloading anything", async () => {
    const { platforms } = fullManifest("26.10.21");
    const result = await verify({ platforms });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("version");
    expect(requested).toEqual(["/alpha/latest.json"]);
  });

  test("--platform checks just that platform, still against the manifest version", async () => {
    const good = await verify({ version: "26.10.21", platforms: { "windows-x86_64": publish("26.10.21", "windows-x86_64") } }, [
      "--platform",
      "windows-x86_64",
    ]);
    expect(good.code).toBe(0);

    const stale = await verify({ version: "26.10.21", platforms: { "windows-x86_64": publish("26.10.20", "windows-x86_64") } }, [
      "--platform",
      "windows-x86_64",
    ]);
    expect(stale.code).toBe(1);
  });
});
