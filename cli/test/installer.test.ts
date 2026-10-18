import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const installerDir = resolve(import.meta.dir, "..", "installer");
const terminalUi = resolve(installerDir, "terminal-ui.sh");
const demo = resolve(installerDir, "demo.sh");
const install = resolve(installerDir, "install.sh");

function runShell(args: string[], env: Record<string, string> = {}) {
  return spawnSync("sh", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

describe("Shiori CLI installer terminal UI", () => {
  test("stays valid POSIX shell", () => {
    for (const script of [terminalUi, demo, install]) {
      const result = runShell(["-n", script]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    }
  });

  test("uses a quiet static fallback outside an interactive terminal", () => {
    const result = runShell([demo, "--static"], {
      LANG: "C",
      LC_ALL: "C",
      SHIORI_INSTALLER_NO_SLEEP: "1",
    });
    expect(result.status).toBe(0);
    // The static banner is "栞  Shiori CLI" — the all-caps wordmark this once
    // asserted was replaced when the branded installer landed (e0b9435) and
    // the expectation was not updated, so this test had been failing since.
    expect(result.stdout).toContain("Shiori CLI");
    expect(result.stdout).toContain("Installing Shiori CLI...");
    expect(result.stdout).toContain("ok  Installing Shiori CLI complete");
    expect(result.stdout).not.toContain("\u001b[");
  });

  test("grows the blue kanji mark and restores the cursor", () => {
    const result = runShell([demo, "--logo-only"], {
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      SHIORI_INSTALLER_FORCE_ANIMATION: "1",
      SHIORI_INSTALLER_NO_SLEEP: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\u001b[?25l");
    expect(result.stdout).toContain("\u001b[38;2;51;136;187m");
    expect(result.stdout).toContain("▀");
    expect(result.stdout).toContain("▄");
    expect(result.stdout).toContain("Shiori CLI");
    expect(result.stdout).toContain("\u001b[?25h");
  });

  test("reveals the Shiori lyric as a restrained terminal bookmark", () => {
    const result = runShell([demo, "--quote-only"], {
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      SHIORI_INSTALLER_FORCE_ANIMATION: "1",
      SHIORI_INSTALLER_NO_SLEEP: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/▎/g)).toHaveLength(2);
    expect(result.stdout).toContain("“普通”とか“あたりまえ”って");
    expect(result.stdout).toContain("なんだろう");
    expect(result.stdout).toContain("— 「栞」 / MyGO!!!!!");
    expect(result.stdout).toContain("\u001b[?25h");
  });

  test("draws the indeterminate download line in place", () => {
    const result = runShell([demo, "--snapshot-progress"], {
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      SHIORI_INSTALLER_FORCE_ANIMATION: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("\r\u001b[K");
    expect(result.stdout).toContain("Installing Shiori CLI");
    expect(result.stdout).toContain("downloading signed archive");
    expect(result.stdout).toContain("█");
    expect(result.stdout).toContain("░");
  });
});
