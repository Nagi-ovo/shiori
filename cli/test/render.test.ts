import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { main } from "../src/main";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const execFileAsync = promisify(execFile);

// `ls -le` prints an ACL principal as its raw UUID whenever directory
// services fails to resolve the name, which happens intermittently while the
// suite runs in parallel. The ACL is unchanged either way, so fold the two
// spellings of uid -2 together before comparing.
const NOBODY_UUID = /FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE/gi;

function aclEntries(lsOutput: string): string[] {
  return lsOutput
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => line.replace(NOBODY_UUID, "user:nobody"));
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-render-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureCli(args: string[]): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  try {
    await main(args);
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

function expectCliError(
  promise: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    code,
    message: expect.stringContaining(message),
  });
}

describe("shiori render", () => {
  test("renders a page to PNG at the requested scale", async () => {
    await withTempDir(async (dir) => {
      const output = join(dir, "page1.png");
      const stdout = await captureCli([
        "render",
        "site/public/welcome.pdf",
        "--page",
        "1",
        "--scale",
        "2",
        "-o",
        output,
        "--agent",
      ]);
      const payload = JSON.parse(stdout) as {
        data: { widthPx: number; heightPx: number; scale: number; format: string };
      };
      // welcome.pdf page 1 is 612x792pt; scale 2 → 1224x1584px.
      expect(payload.data).toMatchObject({
        format: "png",
        scale: 2,
        widthPx: 1224,
        heightPx: 1584,
      });
      const bytes = await readFile(output);
      expect(Array.from(bytes.subarray(0, 4))).toEqual(PNG_MAGIC);
    });
  });

  test("clamps the scale to the canvas pixel budget", async () => {
    await withTempDir(async (dir) => {
      const output = join(dir, "clamped.png");
      const stdout = await captureCli([
        "render",
        "site/public/welcome.pdf",
        "--page",
        "1",
        "--scale",
        "16",
        "-o",
        output,
        "--agent",
      ]);
      const payload = JSON.parse(stdout) as {
        data: { widthPx: number; heightPx: number; scale: number; requestedScale: number };
      };
      expect(payload.data.requestedScale).toBe(16);
      expect(payload.data.scale).toBeLessThan(16);
      expect(payload.data.widthPx * payload.data.heightPx).toBeLessThanOrEqual(
        32_000_000,
      );
    });
  });

  test("enforces -o, --page bounds, and the existing-output policy", async () => {
    await withTempDir(async (dir) => {
      const output = join(dir, "exists.png");
      await expectCliError(
        main(["render", "site/public/welcome.pdf", "--page", "1"]),
        "ERR_USAGE",
        "render requires -o",
      );
      await expectCliError(
        main([
          "render",
          "site/public/welcome.pdf",
          "--page",
          "99",
          "-o",
          output,
        ]),
        "ERR_USAGE",
        "the document has 3 pages",
      );
      await writeFile(output, "occupied");
      await expectCliError(
        main([
          "render",
          "site/public/welcome.pdf",
          "--page",
          "1",
          "-o",
          output,
        ]),
        "ERR_OUTPUT_EXISTS",
        "new output path",
      );
      await expectCliError(
        main([
          "render",
          "site/public/welcome.pdf",
          "--page",
          "1",
          "-o",
          output,
          "--force",
        ]),
        "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
        "cannot safely replace",
      );
      await expect(readFile(output, "utf8")).resolves.toBe("occupied");
    });
  });

  test("rejects the input path and every existing alias as render output", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "input.pdf");
      await copyFile("site/public/welcome.pdf", input);
      const original = await readFile(input);

      await expectCliError(
        main(["render", input, "--page", "1", "-o", input, "--force"]),
        "ERR_OUTPUT_CONFLICT",
        "must not replace the input",
      );
      expect(await readFile(input)).toEqual(original);

      if (process.platform !== "win32") {
        const symlinkOutput = join(dir, "symlink.png");
        const hardlinkOutput = join(dir, "hardlink.png");
        await symlink(input, symlinkOutput);
        await link(input, hardlinkOutput);
        await expectCliError(
          main([
            "render",
            input,
            "--page",
            "1",
            "-o",
            symlinkOutput,
            "--force",
          ]),
          "ERR_OUTPUT_CONFLICT",
          "must not alias the input",
        );
        await expectCliError(
          main([
            "render",
            input,
            "--page",
            "1",
            "-o",
            hardlinkOutput,
            "--force",
          ]),
          "ERR_OUTPUT_CONFLICT",
          "must not alias the input",
        );
      }
    });
  });

  test("refuses replacement before changing existing metadata", async () => {
    if (process.platform === "win32") return;
    await withTempDir(async (dir) => {
      const output = join(dir, "private.png");
      await main([
        "render",
        "site/public/welcome.pdf",
        "--page",
        "1",
        "-o",
        output,
      ]);
      const original = await readFile(output);
      await chmod(output, 0o444);
      await expectCliError(
        main([
          "render",
          "site/public/welcome.pdf",
          "--page",
          "1",
          "-o",
          output,
          "--force",
        ]),
        "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
        "cannot safely replace",
      );
      expect(await readFile(output)).toEqual(original);
      expect((await stat(output)).mode & 0o777).toBe(0o444);
      if (process.platform === "darwin") {
        await chmod(output, 0o644);
        await execFileAsync("/usr/bin/xattr", [
          "-w",
          "com.shiori.audit",
          "keep",
          output,
        ]);
        await execFileAsync("/bin/chmod", ["+a", "nobody deny read", output]);
        const aclBefore = await execFileAsync("/bin/ls", ["-le", output]);
        const aclEntriesBefore = aclEntries(aclBefore.stdout);
        await expectCliError(
          main([
            "render",
            "site/public/welcome.pdf",
            "--page",
            "1",
            "-o",
            output,
            "--force",
          ]),
          "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
          "cannot safely replace",
        );
        const xattr = await execFileAsync("/usr/bin/xattr", [
          "-p",
          "com.shiori.audit",
          output,
        ]);
        const acl = await execFileAsync("/bin/ls", ["-le", output]);
        expect(xattr.stdout.trim()).toBe("keep");
        expect(aclEntries(acl.stdout)).toEqual(aclEntriesBefore);
      }
    });
  });

  test("rejects pathological page dimensions before allocating a canvas", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "huge-page.pdf");
      const output = join(dir, "huge-page.png");
      const pdf = await PDFDocument.create();
      pdf.addPage([1_000_000_000, 1]);
      await writeFile(input, await pdf.save());

      await expectCliError(
        main(["render", input, "--page", "1", "-o", output, "--agent"]),
        "ERR_PDF_PAGE_TOO_LARGE",
        "dimensions are too large",
      );
    });
  });
});
import { execFile } from "node:child_process";
