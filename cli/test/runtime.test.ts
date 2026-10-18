import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };

const CLI_PATH = resolve("cli/src/main.ts");

type CliProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCli(args: string[], cwd = process.cwd()): Promise<CliProcessResult> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  return { exitCode, stdout, stderr };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-runtime-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("shiori CLI process contract", () => {
  test("agent success is one compact JSON envelope on stdout", async () => {
    const result = await runCli([
      "inspect",
      "site/public/welcome.pdf",
      "--agent",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "shiori.cli/v1",
      ok: true,
      command: "inspect",
    });
  });

  test("pretty JSON success is a valid envelope on stdout", async () => {
    const result = await runCli(["version", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "shiori.cli/version/v1",
      name: "shiori",
      version: packageJson.version,
      cliSchemaVersion: 1,
    });
  });

  test("agent usage failure is one JSON envelope on stdout plus stderr diagnostic", async () => {
    const result = await runCli([
      "inspect",
      "site/public/welcome.pdf",
      "--bogus",
      "--agent",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "shiori.cli/v1",
      ok: false,
      error: { code: "ERR_USAGE" },
    });
    expect(result.stderr).toContain("ERR_USAGE:");
    expect(result.stderr).not.toContain('"schema"');
  });

  test("missing option values do not swallow a following --agent flag", async () => {
    const result = await runCli([
      "inspect",
      "site/public/welcome.pdf",
      "--pages",
      "--agent",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "shiori.cli/v1",
      ok: false,
      error: { code: "ERR_USAGE", message: "--pages requires a value" },
    });
    expect(result.stderr).toContain("ERR_USAGE:");
  });

  test("--agent=1 still gets a JSON error envelope for its own rejection", async () => {
    const result = await runCli([
      "text",
      "site/public/welcome.pdf",
      "--agent=1",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "shiori.cli/v1",
      ok: false,
      command: "text",
      error: { code: "ERR_USAGE", message: "--agent does not accept a value" },
    });
  });

  test("help-command errors are not labeled with the help topic", async () => {
    const result = await runCli(["help", "extract", "extra", "--json"]);
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout) as { command?: string };
    expect(payload.command).toBeUndefined();
  });

  test("pretty JSON runtime failure stays on stdout and exits nonzero", async () => {
    const result = await runCli(["inspect", "missing.pdf", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "shiori.cli/v1",
      ok: false,
      error: { code: "ERR_FILE_UNAVAILABLE" },
    });
    expect(result.stderr).toContain("ERR_FILE_UNAVAILABLE:");
  });


  test("human output strips terminal escape sequences from document text", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, "hostile.md"),
        "before\u001b]0;pwned\u0007middle\u001b[2Jafter\tkeep\nline",
      );
      const result = await runCli(["text", "hostile.md"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("\u001b");
      expect(result.stdout).not.toContain("\u0007");
      expect(result.stdout).toContain("before]0;pwnedmiddle[2Jafter\tkeep\nline");
    });
  });

  test("stderr diagnostics strip control characters from error details", async () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    // The missing file's name flows into the error detail verbatim; the
    // stderr boundary must strip the embedded escape sequence.
    const result = await runCli(["inspect", `evil${ESC}]0;pwned${BEL}.md`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ERR_FILE_UNAVAILABLE");
    expect(result.stderr).not.toContain(ESC);
    expect(result.stderr).not.toContain(BEL);
    expect(result.stderr).toContain("evil]0;pwned.md");
  });

  test("-- permits a real file name beginning with a dash", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "--notes.md"), "hello from dash file");
      const result = await runCli(
        ["--agent", "inspect", "--", "--notes.md"],
        dir,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          kind: "document.inspect",
          file: { name: "--notes.md" },
        },
      });
    });
  });
});
