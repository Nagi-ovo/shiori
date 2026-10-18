import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLI_INSTALL_CURL,
  CLI_INSTALL_NPM,
  CLI_INSTALL_POWERSHELL,
  CLI_NPM_PACKAGE,
  SUPPORTED_CLI_INSTALL_TARGETS,
  cliArchiveName,
  detectCliInstallTarget,
  parseCliAssetName,
} from "../distribution";
import {
  CLI_INSTALL_CURL as siteCurl,
  CLI_INSTALL_NPM as siteNpm,
  CLI_INSTALL_POWERSHELL as sitePowershell,
} from "../../site/src/content/cliInstall";
import { detectCliInstallTarget as detectNpmTarget } from "../npm/install.mjs";
import npmPackage from "../npm/package.json" with { type: "json" };
import cliPackage from "../package.json" with { type: "json" };
import {
  assembleHostedInstaller,
  assembleHostedPowershellInstaller,
} from "../installer/assemble";

const installerDir = resolve(import.meta.dir, "..", "installer");
const installSh = resolve(installerDir, "install.sh");
const installPs1 = resolve(installerDir, "install.ps1");
const publicDir = resolve(import.meta.dir, "..", "..", "site", "public");
const powershell = Bun.which("pwsh") ?? Bun.which("powershell");
// -NoProfile keeps a developer's profile out of the run; -ExecutionPolicy
// Bypass keeps a policy-locked machine from failing the test rather than
// the installer. Neither applies to the real `irm | iex` path, which runs
// a string and never a script file.
const PS_ARGS = ["-NoProfile", "-ExecutionPolicy", "Bypass"];

describe("CLI download channel", () => {
  test("publishes one install command per platform family", () => {
    expect(siteCurl).toBe(CLI_INSTALL_CURL);
    expect(sitePowershell).toBe(CLI_INSTALL_POWERSHELL);
    expect(siteNpm).toBe(CLI_INSTALL_NPM);
  });

  test("ships an npm fetcher that can actually be published", () => {
    expect(npmPackage.name).toBe(CLI_NPM_PACKAGE);
    expect(npmPackage.private).toBe(false);
    // A scoped package publishes private by default, which on a free account
    // fails outright and on a paid one silently ships something nobody can
    // install. access:public is load-bearing, not decoration.
    expect(npmPackage.name.startsWith("@")).toBe(true);
    expect(npmPackage.publishConfig?.access).toBe("public");
    // `npm install -g @nagi-ovo/shiori@0.1.25` should not be able to mean a
    // different CLI version than 0.1.25. The fetcher installs whatever
    // /api/cli calls newest, so the least we owe a reader is that the two
    // numbers agree.
    expect(npmPackage.version).toBe(cliPackage.version);
  });

  test("names archives so the site manifest and both installers agree", () => {
    expect(parseCliAssetName(cliArchiveName("0.1.25", "win32-x64"))).toEqual({
      version: "0.1.25",
      target: "win32-x64",
    });
  });

  test("maps OS/arch the same way in TypeScript and in the npm runner", () => {
    const cases = [
      ["darwin", "arm64", "darwin-arm64"],
      ["linux", "x64", "linux-x64-gnu"],
      ["linux", "aarch64", "linux-arm64-gnu"],
      ["win32", "x64", "win32-x64"],
      ["win32", "arm64", "win32-arm64"],
      ["darwin", "x64", null],
    ] as const;
    for (const [os, arch, target] of cases) {
      expect(detectCliInstallTarget(os, arch)).toBe(target);
      // install.mjs carries its own copy: it has to run on a machine that
      // has Node and nothing of this repo.
      expect(detectNpmTarget(os, arch)).toBe(target);
    }
  });
});

describe("POSIX installer", () => {
  test("prints the current machine target without installing", () => {
    const result = spawnSync("sh", [installSh, "--print-target"], {
      encoding: "utf8",
    });
    if (process.platform === "win32") {
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(CLI_INSTALL_POWERSHELL);
      return;
    }
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      detectCliInstallTarget(process.platform, process.arch) ?? "",
    );
  });

  test.skipIf(process.platform === "win32").each(["MINGW64_NT-10.0-19045", "MSYS_NT-10.0-19045", "CYGWIN_NT-10.0-19045"])(
    "sends %s to the PowerShell one-liner",
    (kernel) => {
      // Run the installer under a fake `uname` so the Windows shell branch is
      // exercised on every host, not only on the Windows runner.
      const bin = mkdtempSync(join(tmpdir(), "shiori-uname-"));
      try {
        writeFileSync(
          join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo "${kernel}" ;; *) echo x86_64 ;; esac\n`,
          { mode: 0o755 },
        );
        const result = spawnSync("sh", [installSh, "--print-target"], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(CLI_INSTALL_POWERSHELL);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  test("parses a release env file without eval", () => {
    const env = [
      "SHIORI_CLI_AVAILABLE=1",
      "SHIORI_CLI_VERSION=0.1.25",
      "SHIORI_CLI_TARGET=darwin-arm64",
      "SHIORI_CLI_URL=https://example.test/shiori-cli-0.1.25-darwin-arm64.tar.gz",
      `SHIORI_CLI_SHA256=${"ab".repeat(32)}`,
      "SHIORI_CLI_SIZE=12",
      "",
    ].join("\n");
    const result = spawnSync("sh", [installSh, "--parse-env"], {
      encoding: "utf8",
      input: env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `1 0.1.25 darwin-arm64 ${"ab".repeat(32)}`,
    );
  });

  test("rejects a non-HTTPS URL unless loopback is explicitly allowed", () => {
    const blocked = spawnSync("sh", [installSh, "--parse-env"], {
      encoding: "utf8",
      input: "SHIORI_CLI_URL=http://evil.test/shiori.tar.gz\n",
    });
    expect(blocked.status).not.toBe(0);

    const allowed = spawnSync("sh", [installSh, "--parse-env"], {
      encoding: "utf8",
      env: { ...process.env, SHIORI_CLI_ALLOW_HTTP: "1" },
      input: "SHIORI_CLI_URL=http://127.0.0.1:9/shiori.tar.gz\n",
    });
    expect(allowed.status).toBe(0);
  });
});

// The PowerShell installer only runs on a machine with PowerShell, which the
// macOS dev box is not. These read the script instead, so a divergence
// between the two installers still fails here rather than on a user's
// Windows machine — the Windows-only runner in cli-verify.yml executes the
// pwsh-gated tests below for real.
describe("PowerShell installer source", () => {
  const source = readFileSync(installPs1, "utf8");

  test("accepts exactly the release targets the descriptor can carry", () => {
    const match = /\^\(([a-z0-9|-]+)\)\$/.exec(source);
    expect(match).not.toBeNull();
    expect(match?.[1].split("|").sort()).toEqual(
      [...SUPPORTED_CLI_INSTALL_TARGETS].sort(),
    );
  });

  test("maps Windows architectures the way the TypeScript detector does", () => {
    const arms = [...source.matchAll(/'(amd64|x86_64|arm64)' \{ return '([a-z0-9-]+)' \}/g)];
    expect(arms.length).toBe(3);
    for (const [, architecture, target] of arms) {
      expect(detectCliInstallTarget("win32", architecture)).toBe(target);
    }
  });

  test("stays ASCII so iex runs it whatever the caller's encoding is", () => {
    // Assert on the hosted copy as well: that is the file PowerShell
    // actually executes, and assembly prepends a header of its own.
    for (const text of [source, readFileSync(resolve(publicDir, "cli.ps1"), "utf8")]) {
      const offending = [...text].find((character) => character.charCodeAt(0) > 127);
      expect(offending).toBeUndefined();
    }
  });

  test("sets no preference variables in the caller's scope", () => {
    // `irm | iex` runs in the caller's session; a top-level assignment would
    // silently change their ErrorActionPreference for the rest of it.
    for (const line of source.split("\n")) {
      expect(line).not.toMatch(/^\$(ErrorActionPreference|ProgressPreference)\s*=/);
    }
  });
});

// Gated on Windows, not merely on "is pwsh installed". pwsh also ships on
// GitHub's Linux runners, so the looser gate ran the Windows installer there:
// target detection reads PROCESSOR_ARCHITECTURE and asserted nothing useful,
// and the cold pwsh start blew bun's 5s default timeout on the slower arm64
// runner — a release that failed on a test that could not have been right.
// The two Windows rows in cli-verify.yml and cli-release.yml cover all of it;
// running it on Linux only bought a way to fail.
const skipPowershellTests = !powershell || process.platform !== "win32";
const PS_TIMEOUT = 30_000;

describe.skipIf(skipPowershellTests)(
  "PowerShell installer on Windows",
  () => {
    test("prints the current machine target without installing", () => {
      const result = spawnSync(powershell!, [...PS_ARGS, "-File", installPs1, "print-target"], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(
        detectCliInstallTarget(process.platform, process.arch) ?? "",
      );
    }, PS_TIMEOUT);
  },
);

describe.skipIf(skipPowershellTests)("PowerShell descriptor parsing", () => {

  test("parses a release env file without Invoke-Expression", () => {
    const env = [
      "SHIORI_CLI_AVAILABLE=1",
      "SHIORI_CLI_VERSION=0.1.25",
      "SHIORI_CLI_TARGET=win32-x64",
      "SHIORI_CLI_URL=https://example.test/shiori-cli-0.1.25-win32-x64.tar.gz",
      `SHIORI_CLI_SHA256=${"ab".repeat(32)}`,
      "SHIORI_CLI_SIZE=12",
      "",
    ].join("\n");
    const result = spawnSync(powershell!, [...PS_ARGS, "-File", installPs1, "parse-env"], {
      encoding: "utf8",
      input: env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`1 0.1.25 win32-x64 ${"ab".repeat(32)}`);
  }, PS_TIMEOUT);

  test("rejects a non-HTTPS URL and an unknown field", () => {
    const blocked = spawnSync(powershell!, [...PS_ARGS, "-File", installPs1, "parse-env"], {
      encoding: "utf8",
      input: "SHIORI_CLI_URL=http://evil.test/shiori.tar.gz\n",
    });
    expect(blocked.status).not.toBe(0);

    const unknown = spawnSync(powershell!, [...PS_ARGS, "-File", installPs1, "parse-env"], {
      encoding: "utf8",
      input: "SHIORI_CLI_SURPRISE=1\n",
    });
    expect(unknown.status).not.toBe(0);
  }, PS_TIMEOUT);
});

describe("hosted installer assembly", () => {
  test("keeps site/public/cli.sh identical to the sourced installer files", () => {
    const assembled = assembleHostedInstaller(
      readFileSync(resolve(installerDir, "terminal-ui.sh"), "utf8"),
      readFileSync(installSh, "utf8"),
    );
    expect(readFileSync(resolve(publicDir, "cli.sh"), "utf8")).toBe(assembled);
  });

  test("keeps site/public/cli.ps1 identical to the PowerShell installer", () => {
    const assembled = assembleHostedPowershellInstaller(
      readFileSync(installPs1, "utf8"),
    );
    expect(readFileSync(resolve(publicDir, "cli.ps1"), "utf8")).toBe(assembled);
  });
});
