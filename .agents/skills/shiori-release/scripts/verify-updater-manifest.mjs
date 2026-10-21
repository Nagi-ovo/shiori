#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";

const DEFAULT_MANIFEST =
  "https://updates.shiori.nagi.fun/alpha/latest.json";
const DEFAULT_CONFIG = "src-tauri/tauri.conf.json";
// Every desktop platform the release ships an updater artifact for. A client
// whose key is missing never hears about the release.
const REQUIRED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
  "linux-x86_64",
];

function usage() {
  return `Usage:
  node .agents/skills/shiori-release/scripts/verify-updater-manifest.mjs [options]

Options:
  --manifest <url>      Updater manifest URL. Defaults to ${DEFAULT_MANIFEST}
  --config <path>       Tauri config path. Defaults to ${DEFAULT_CONFIG}
  --platform <name>     Verify one platform key, e.g. windows-x86_64
  --help                Show this message
`;
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    config: DEFAULT_CONFIG,
    platform: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--manifest") {
      args.manifest = argv[++i];
    } else if (arg === "--config") {
      args.config = argv[++i];
    } else if (arg === "--platform") {
      args.platform = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.manifest || !args.config) {
    throw new Error("--manifest and --config require values");
  }
  return args;
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function decodeBase64Text(value, label) {
  try {
    return Buffer.from(String(value).trim(), "base64").toString("utf8");
  } catch (error) {
    throw new Error(`Could not decode ${label} as base64: ${error.message}`);
  }
}

function parsePublicKey(publicKeyText) {
  const lines = publicKeyText.trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error("Updater public key is not in minisign format");
  }

  const bin = Buffer.from(lines[1], "base64");
  if (bin.length !== 42) {
    throw new Error(`Updater public key has invalid length ${bin.length}`);
  }

  const algorithm = bin.subarray(0, 2).toString("ascii");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(`Unsupported updater public key algorithm ${algorithm}`);
  }

  return {
    algorithm,
    keyId: bin.subarray(2, 10).toString("hex"),
    raw: bin.subarray(10, 42),
  };
}

function parseSignature(signatureText) {
  const lines = signatureText.trim().split(/\r?\n/);
  if (lines.length < 4) {
    throw new Error("Signature is not in minisign format");
  }

  const body = Buffer.from(lines[1], "base64");
  const globalSignature = Buffer.from(lines[3], "base64");
  if (body.length !== 74) {
    throw new Error(`Signature body has invalid length ${body.length}`);
  }
  if (globalSignature.length !== 64) {
    throw new Error(
      `Signature global section has invalid length ${globalSignature.length}`,
    );
  }

  const algorithm = body.subarray(0, 2).toString("ascii");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(`Unsupported signature algorithm ${algorithm}`);
  }
  if (!lines[2].startsWith("trusted comment: ")) {
    throw new Error("Signature is missing trusted comment");
  }

  return {
    algorithm,
    keyId: body.subarray(2, 10).toString("hex"),
    signature: body.subarray(10, 74),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature,
  };
}

function ed25519PublicKey(rawPublicKey) {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, rawPublicKey]),
    format: "der",
    type: "spki",
  });
}

function verifyMinisign(payload, signature, publicKey) {
  if (signature.keyId !== publicKey.keyId) {
    throw new Error(
      `Signature key id ${signature.keyId} does not match public key ${publicKey.keyId}`,
    );
  }

  const key = ed25519PublicKey(publicKey.raw);
  const message =
    signature.algorithm === "ED"
      ? crypto.createHash("blake2b512").update(payload).digest()
      : payload;

  const bodyOk = crypto.verify(null, message, key, signature.signature);
  const globalMessage = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, "utf8"),
  ]);
  const globalOk = crypto.verify(
    null,
    globalMessage,
    key,
    signature.globalSignature,
  );

  return bodyOk && globalOk;
}

async function loadUpdaterPublicKey(configPath) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const encoded = config?.plugins?.updater?.pubkey;
  if (!encoded) {
    throw new Error(`No plugins.updater.pubkey found in ${configPath}`);
  }
  return parsePublicKey(decodeBase64Text(encoded, "plugins.updater.pubkey"));
}

// A correctly signed asset from an older release passes every signature
// check, and the client then installs that old build and is offered the same
// update again. Release assets live under the vX.Y.Z tag with the version in
// the file name, so both must name the manifest's version.
function assertAssetVersion(name, url, version) {
  const path = new URL(url).pathname;
  const file = path.slice(path.lastIndexOf("/") + 1);
  if (!path.includes(`/v${version}/`) || !file.includes(`_${version}_`)) {
    throw new Error(`${name} url is not the v${version} asset: ${url}`);
  }
}

async function verifyPlatform(name, platform, publicKey, version) {
  if (!platform?.url || !platform?.signature) {
    throw new Error(`${name} is missing url or signature`);
  }
  assertAssetVersion(name, platform.url, version);

  const embeddedSignatureBase64 = String(platform.signature).trim();
  const remoteSignatureBase64 = (await fetchText(`${platform.url}.sig`)).trim();
  if (embeddedSignatureBase64 !== remoteSignatureBase64) {
    throw new Error(
      `${name} manifest signature does not match ${platform.url}.sig`,
    );
  }

  const signatureText = decodeBase64Text(
    embeddedSignatureBase64,
    `${name} signature`,
  );
  const signature = parseSignature(signatureText);
  const payload = await fetchBytes(platform.url);
  const verified = verifyMinisign(payload, signature, publicKey);
  if (!verified) {
    throw new Error(`${name} signature verification failed`);
  }

  return {
    sha256: crypto.createHash("sha256").update(payload).digest("hex"),
    bytes: payload.length,
    trustedComment: signature.trustedComment,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publicKey = await loadUpdaterPublicKey(args.config);
  const manifest = JSON.parse(await fetchText(args.manifest));
  const platforms = manifest.platforms ?? {};
  const names = args.platform
    ? [args.platform]
    : [...new Set([...REQUIRED_PLATFORMS, ...Object.keys(platforms)])];
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error(`Manifest ${args.manifest} has no version`);
  }

  if (names.length === 0) {
    throw new Error("Manifest has no platforms to verify");
  }

  console.log(`Manifest: ${args.manifest}`);
  console.log(`Version: ${manifest.version}`);
  console.log(`Public key: ${publicKey.algorithm} ${publicKey.keyId}`);

  let failures = 0;
  for (const name of names) {
    if (!platforms[name]) {
      console.error(`FAIL ${name}: platform not found in manifest`);
      failures += 1;
      continue;
    }

    try {
      const result = await verifyPlatform(
        name,
        platforms[name],
        publicKey,
        manifest.version,
      );
      console.log(`OK ${name}`);
      console.log(`  url: ${platforms[name].url}`);
      console.log(`  bytes: ${result.bytes}`);
      console.log(`  sha256: ${result.sha256}`);
      console.log(`  trusted: ${result.trustedComment}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
