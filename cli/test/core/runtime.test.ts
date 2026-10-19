import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

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
});
