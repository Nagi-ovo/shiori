import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUPPORTED_CLI_INSTALL_TARGETS } from "../distribution";
import { CLI_ENTITLEMENTS, cliCodesignArgs } from "../build";
import rootPackage from "../../package.json" with { type: "json" };

const release = readFileSync(
  resolve(import.meta.dir, "..", "..", ".github", "workflows", "cli-release.yml"),
  "utf8",
);

describe("CLI release channel wiring", () => {
  test("releases the CLI on its own tag, not the desktop app's", () => {
    // Sharing v* meant an app bump re-uploaded an identically-named archive
    // onto a second release, since cli/package.json versions separately.
    expect(release).toContain('- "cli-v*"');
    expect(release).not.toContain('- "v*"');
    expect(release).toContain("^cli-v[0-9]+");
  });

  test("builds a row for every target the installers can ask for", () => {
    // A target the descriptor advertises but no runner packs is an install
    // that fails only on the platform nobody here is sitting in front of.
    for (const target of SUPPORTED_CLI_INSTALL_TARGETS) {
      expect(release).toContain(`target: ${target}`);
    }
    expect(release).toContain("Expected 5 CLI archives");
    expect(SUPPORTED_CLI_INSTALL_TARGETS.length).toBe(5);
  });

  test("publishes only after every archive is uploaded", () => {
    // A release published before its uploads finish is briefly one where
    // some platforms install and others report nothing published.
    const upload = release.indexOf("gh release upload");
    const publish = release.indexOf("--draft=false");
    expect(upload).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(upload);
    // And it must not sit as a draft forever: a draft is invisible to the
    // site's read-only token, so /api/cli would stay available:false.
    expect(release).toContain("--draft=false");
  });

  test("publishes the fetcher directory, not the repository root", () => {
    // `npm publish --prefix cli/npm` does NOT publish cli/npm. --prefix sets
    // the install location; publish still packs the current directory. Run
    // from the repo root it packed 1106 files and 16.3 MB of Shiori source,
    // and the only thing that stopped it reaching npm was the root
    // package.json being private.
    const script = rootPackage.scripts["cli:npm-publish"];
    expect(script).toContain("cli/npm");
    expect(script).not.toContain("--prefix");
  });

  test("keeps the repository root unpublishable", () => {
    // Load-bearing: it is the backstop for any command that packs the root
    // by accident; the root is an app, not an npm package.
    expect(rootPackage.private).toBe(true);
  });
});

describe("macOS code signing", () => {
  const exe = "/tmp/shiori";

  test("the release verifies the signature it just applied", () => {
    // A signing step that silently no-ops ships an ad-hoc binary under a
    // release that claims to be signed. The workflow greps codesign's output
    // for a real authority, so a missing certificate fails the release.
    expect(release).toContain("SHIORI_CLI_SIGN_IDENTITY");
    expect(release).toContain("Authority=Developer ID Application");
    expect(release).toContain("notarytool submit");
  });

  test("falls back to ad-hoc when no identity is configured", () => {
    // Local builds and forks have no certificate. They must still produce a
    // runnable binary: arm64 macOS will not execute an unsigned Mach-O.
    expect(cliCodesignArgs("darwin", undefined, exe)).toEqual([
      "--force",
      "--sign",
      "-",
      exe,
    ]);
    expect(cliCodesignArgs("darwin", "   ", exe)).toEqual([
      "--force",
      "--sign",
      "-",
      exe,
    ]);
  });

  test("signs with the identity, hardened runtime and a timestamp", () => {
    const id = "Developer ID Application: Zexi Zhang (PJM828YBFJ)";
    const args = cliCodesignArgs("darwin", id, exe);
    expect(args).toContain(id);
    // Notarization rejects anything not built against the hardened runtime.
    expect(args).toContain("--options");
    expect(args).toContain("runtime");
    // Without a timestamp the signature stops verifying when the certificate
    // expires, instead of staying valid for what was signed while it was live.
    expect(args).toContain("--timestamp");
    expect(args).not.toContain("-");
  });

  test("lets the hardened executable JIT", () => {
    // V8 cannot reserve executable memory under the hardened runtime without
    // allow-jit: 0.1.27 crashed at startup on every Mac. GitHub's macOS
    // runners do not enforce it, so the release smoke passed anyway and the
    // workflow checks the entitlement on the signed binary instead.
    const args = cliCodesignArgs("darwin", "Developer ID", exe, CLI_ENTITLEMENTS);
    expect(args?.[args.indexOf("--entitlements") + 1]).toBe(CLI_ENTITLEMENTS);
    // Any whitespace between key and value: Windows checkouts get CRLF.
    expect(readFileSync(CLI_ENTITLEMENTS, "utf8")).toMatch(
      /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/,
    );
    expect(release).toContain("com.apple.security.cs.allow-jit");
  });

  test("does not try to codesign anywhere but macOS", () => {
    expect(cliCodesignArgs("linux", "whatever", exe)).toBeNull();
    expect(cliCodesignArgs("win32", "whatever", exe)).toBeNull();
  });
});
