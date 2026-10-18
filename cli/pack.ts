import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliTargetName } from "./build";
import { cliArchiveName, isCliInstallTarget } from "./distribution";
import packageJson from "./package.json" with { type: "json" };

const CLI_ROOT = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const target = cliTargetName(platform(), arch());
  if (!isCliInstallTarget(target)) {
    throw new Error(`No download-channel archive for ${target}`);
  }
  const source = join(CLI_ROOT, "dist", target);
  const executable = platform() === "win32" ? "shiori.exe" : "shiori";
  await access(join(source, executable));
  const archives = join(CLI_ROOT, "dist", "archives");
  await mkdir(archives, { recursive: true });
  const archive = join(archives, cliArchiveName(packageJson.version, target));
  await run("tar", ["-czf", archive, "-C", source, "."]);
  console.log(archive);
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited ${code}`));
    });
  });
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
