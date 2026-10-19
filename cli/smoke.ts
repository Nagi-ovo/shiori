import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDITED_LICENSE_TREE_SHA256,
  auditedLicenseTreeDigest,
  cliTargetName,
  nativeCoreFiles,
} from "./build";
import packageJson from "./package.json" with { type: "json" };

const cliRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(cliRoot, "..");
const target = cliTargetName(platform(), arch());
const outputDir = join(cliRoot, "dist", target);
const executable = join(outputDir, platform() === "win32" ? "shiori.exe" : "shiori");

async function main(): Promise<void> {
  await Promise.all([
    access(executable),
    access(join(outputDir, "assets", "fonts", "NotoSansSC-Regular.otf")),
    access(join(outputDir, "assets", "fonts", "NotoSansJP-Regular.otf")),
    access(join(outputDir, "LICENSE")),
    access(join(outputDir, "THIRD_PARTY_NOTICES.md")),
    access(join(outputDir, "licenses", "Node.js-LICENSE.txt")),
    access(join(outputDir, "native", nativeCoreFiles(target).addon)),
    access(join(outputDir, "native", nativeCoreFiles(target).pdfium)),
  ]);
  const packagedLicenseDigest = await auditedLicenseTreeDigest(
    join(outputDir, "licenses"),
  );
  if (packagedLicenseDigest !== AUDITED_LICENSE_TREE_SHA256) {
    throw new Error("Packaged CLI license inventory failed its audit digest");
  }

  // Run every command from a copy outside the repository. Otherwise a
  // dynamic require can walk up to the checkout's node_modules and make an
  // incomplete distribution look healthy. Unix commands go through a
  // symlink as well, matching the normal ~/.local/bin installation.
  const isolatedRoot = await mkdtemp(
    join(platform() === "darwin" ? "/tmp" : tmpdir(), "shiori-cli-isolated-"),
  );
  const isolatedOutput = join(isolatedRoot, "distribution");
  await cp(outputDir, isolatedOutput, { recursive: true });
  const isolatedExecutable = join(
    isolatedOutput,
    platform() === "win32" ? "shiori.exe" : "shiori",
  );
  let smokeExecutable = isolatedExecutable;
  let isolatedBin = isolatedOutput;
  if (platform() !== "win32") {
    isolatedBin = join(isolatedRoot, "bin");
    await mkdir(isolatedBin);
    smokeExecutable = join(isolatedBin, "shiori");
    await symlink(isolatedExecutable, smokeExecutable);
  }

  try {
    const version = await run(["--version"], smokeExecutable);
    if (version.stdout.trim() !== `shiori ${packageJson.version}`) {
      throw new Error(`Unexpected version output: ${version.stdout}`);
    }
    const pathVersion = await run(
      ["--version"],
      platform() === "win32" ? "shiori.exe" : "shiori",
      {
        ...process.env,
        PATH: `${isolatedBin}${delimiter}${process.env.PATH ?? ""}`,
      },
    );
    if (pathVersion.stdout.trim() !== `shiori ${packageJson.version}`) {
      throw new Error(
        `PATH-installed CLI did not execute: ${pathVersion.stdout}`,
      );
    }
    const help = await run(["--help", "--agent"], smokeExecutable);
    const helpJson = JSON.parse(help.stdout) as { schema?: string };
    if (helpJson.schema !== "shiori.cli/help/v1") {
      throw new Error("Compiled CLI help did not return the expected schema");
    }
    const text = await run(
      [
        "text",
        join(repoRoot, "site", "public", "welcome.pdf"),
        "--pages",
        "1",
        "--max-chars",
        "160",
        "--agent",
      ],
      smokeExecutable,
    );
    const textJson = JSON.parse(text.stdout) as {
      ok?: boolean;
      data?: { pages?: Array<{ text?: string }> };
    };
    if (
      !textJson.ok ||
      textJson.data?.pages?.length !== 1 ||
      !textJson.data.pages[0]?.text?.includes("A Local-First PDF Reader")
    ) {
      throw new Error(
        "Compiled CLI did not extract the known welcome PDF text",
      );
    }
    const welcomePdf = join(repoRoot, "site", "public", "welcome.pdf");
    const temp = await mkdtemp(join(tmpdir(), "shiori-cli-smoke-"));
    try {
      const specPath = join(temp, "annotations.json");
      const outputPath = join(temp, "round-trip.pdf");
      const extracted = await run(
        ["extract", welcomePdf, "--as-spec", "--agent"],
        smokeExecutable,
      );
      const pureSpec = JSON.parse(extracted.stdout) as {
        schema?: string;
        ok?: unknown;
      };
      if (pureSpec.schema !== "shiori.annotations/v1" || pureSpec.ok != null) {
        throw new Error("Compiled CLI did not emit a pure annotation spec");
      }
      await writeFile(
        specPath,
        `${JSON.stringify({
          schema: "shiori.annotations/v1",
          annotations: [
            {
              type: "highlight",
              page: 1,
              rects: [{ x: 72, y: 640, w: 200, h: 14 }],
              color: "#f6c744",
              opacity: 0.35,
            },
          ],
        })}\n`,
      );
      const annotated = await run(
        [
          "annotate",
          welcomePdf,
          "--spec",
          specPath,
          "-o",
          outputPath,
          "--agent",
        ],
        smokeExecutable,
      );
      const annotatedPayload = JSON.parse(annotated.stdout) as {
        ok?: boolean;
        data?: { written?: number };
      };
      if (!annotatedPayload.ok || annotatedPayload.data?.written !== 1) {
        throw new Error("Compiled CLI did not write exactly one annotation");
      }
      const roundTrip = await run(
        ["extract", outputPath, "--as-spec", "--agent"],
        smokeExecutable,
      );
      const roundTripSpec = JSON.parse(roundTrip.stdout) as {
        schema?: string;
        annotations?: Array<{ type?: string }>;
      };
      if (
        roundTripSpec.schema !== "shiori.annotations/v1" ||
        roundTripSpec.annotations?.length !== 1 ||
        roundTripSpec.annotations[0]?.type !== "highlight"
      ) {
        throw new Error("Compiled CLI did not extract exactly one annotation");
      }
      const renderOutput = join(temp, "page1.png");
      const rendered = await run(
        [
          "render",
          welcomePdf,
          "--page",
          "1",
          "-o",
          renderOutput,
          "--agent",
        ],
        smokeExecutable,
      );
      const renderPayload = JSON.parse(rendered.stdout) as {
        ok?: boolean;
        data?: { format?: string; widthPx?: number; heightPx?: number };
      };
      if (
        !renderPayload.ok ||
        renderPayload.data?.format !== "png" ||
        renderPayload.data.widthPx !== 1224 ||
        renderPayload.data.heightPx !== 1584
      ) {
        throw new Error("Isolated compiled CLI could not render the expected PNG");
      }
      const png = await readFile(renderOutput);
      if (
        png.byteLength <= 8 ||
        png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      ) {
        throw new Error("Compiled CLI render output is not a non-empty PNG");
      }
      const refusedReplace = await runRaw(
        [
          "render",
          welcomePdf,
          "--page",
          "1",
          "-o",
          renderOutput,
          "--force",
          "--agent",
        ],
        smokeExecutable,
      );
      const refusedReplacePayload = JSON.parse(refusedReplace.stdout) as {
        ok?: boolean;
        error?: { code?: string };
      };
      if (
        refusedReplace.exitCode === 0 ||
        refusedReplacePayload.ok !== false ||
        refusedReplacePayload.error?.code !==
          "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED"
      ) {
        throw new Error("Compiled CLI did not fail closed on output replacement");
      }
      if (!Buffer.from(await readFile(renderOutput)).equals(Buffer.from(png))) {
        throw new Error("Refused replacement changed the existing PNG");
      }
      const failure = await runRaw(
        [
          "inspect",
          welcomePdf,
          "--not-a-real-option",
          "--agent",
        ],
        smokeExecutable,
      );
      if (
        failure.exitCode === 0 ||
        (JSON.parse(failure.stdout) as { ok?: boolean }).ok !== false ||
        !failure.stderr.includes("ERR_USAGE")
      ) {
        throw new Error("Compiled CLI failure contract is not deterministic");
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
  const manifest = JSON.parse(
    await readFile(join(outputDir, "manifest.json"), "utf8"),
  ) as {
    schema?: string;
    version?: string;
    target?: string;
    files?: Array<{ path?: string; size?: number; sha256?: string }>;
  };
  if (
    manifest.schema !== "shiori.cli-distribution/v2" ||
    manifest.version !== packageJson.version ||
    manifest.target !== target
  ) {
    throw new Error("CLI distribution manifest does not match this build");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("CLI distribution manifest has no file inventory");
  }
  const actualPaths = await distributionPaths(outputDir);
  const listedPaths = manifest.files.map((entry) => entry.path ?? "").sort();
  if (JSON.stringify(listedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error("CLI distribution manifest does not cover the complete package");
  }
  for (const entry of manifest.files) {
    if (
      !entry.path ||
      entry.path.startsWith("/") ||
      entry.path.split("/").includes("..")
    ) {
      throw new Error(`Unsafe manifest path: ${String(entry.path)}`);
    }
    const bytes = await readFile(join(outputDir, ...entry.path.split("/")));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (entry.size !== bytes.byteLength || entry.sha256 !== digest) {
      throw new Error(`CLI distribution file does not match manifest: ${entry.path}`);
    }
  }
  console.log(`Shiori CLI ${packageJson.version} smoke passed (${target})`);
}

async function distributionPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  await visit(root);
  return paths.sort();

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (path === "manifest.json") continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) paths.push(path);
      else throw new Error(`Unexpected distribution entry: ${path}`);
    }
  }
}

async function run(
  args: string[],
  command: string = executable,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runRaw(args, command, env);
  if (result.exitCode !== 0) {
    throw new Error(
      `Compiled CLI exited ${result.exitCode} (${String(result.signal)}): ${result.stderr.trim()}`,
    );
  }
  return result;
}

async function runRaw(
  args: string[],
  command: string = executable,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      resolveRun({ exitCode: code ?? -1, signal, stdout, stderr });
    });
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
