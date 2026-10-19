import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { main } from "../../src/main";

async function captureCli(args: string[]): Promise<{
  stdout: string;
  error: unknown;
}> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  console.warn = () => undefined;
  console.error = () => undefined;
  let error: unknown = null;
  try {
    await main(args);
  } catch (err) {
    error = err;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  return { stdout: logs.join("\n"), error };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-pages-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makePdf(path: string, pageTexts: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 700, size: 14, font });
  }
  await writeFile(path, await doc.save());
}

describe("--pages with an empty value", () => {
  // `shiori text book.pdf --pages "$RANGE"` with RANGE unset is the shape this
  // guards. An empty value used to read as "no selection given" and quietly
  // processed the whole document, while `--pages " "` and `--pages=` both
  // errored — so the same mistake failed loudly or silently depending on
  // whitespace.
  test("is a usage error, not a silent select-everything", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "book.pdf");
      await makePdf(input, ["alpha", "bravo", "charlie"]);

      const { error } = await captureCli(["text", input, "--pages", ""]);
      expect(error).toBeTruthy();
      expect(String((error as { code?: string }).code ?? "")).toBe("ERR_USAGE");
    });
  });

  test("agent mode reports the error rather than an empty response", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "book.pdf");
      await makePdf(input, ["alpha", "bravo"]);

      const { error } = await captureCli([
        "inspect",
        input,
        "--agent",
        "--pages",
        "",
      ]);
      expect(error).toBeTruthy();
      expect(String((error as { code?: string }).code ?? "")).toBe("ERR_USAGE");
    });
  });

  test("omitting --pages still selects every page", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "book.pdf");
      await makePdf(input, ["alpha", "bravo", "charlie"]);

      const { stdout, error } = await captureCli(["text", input, "--agent"]);
      expect(error).toBeNull();
      expect(stdout).toContain("alpha");
      expect(stdout).toContain("charlie");
    });
  });
});

describe("deeply nested HTML", () => {
  test(
    "fails with a documented code instead of a stack overflow",
    async () => {
      await withTempDir(async (dir) => {
        const input = join(dir, "deep.html");
        // Well under the 10 MB byte limit, but far past what recursion survived.
        const depth = 60_000;
        await writeFile(
          input,
          `<html><body>${"<div>".repeat(depth)}deep${"</div>".repeat(depth)}</body></html>`,
        );

        const { error } = await captureCli(["text", input, "--agent"]);
        expect(error).toBeTruthy();
        const code = String((error as { code?: string }).code ?? "");
        // The point is that it is a typed, documented failure — never
        // ERR_UNKNOWN carrying "Maximum call stack size exceeded".
        expect(code).toBe("ERR_TEXT_UNAVAILABLE");
      });
    },
    10_000,
  );

  test("ordinary nesting still extracts text in document order", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "page.html");
      await writeFile(
        input,
        "<html><body><h1>Title</h1><p>First <b>bold</b> tail</p>" +
          "<script>ignored()</script><p>Second</p></body></html>",
      );

      const { stdout, error } = await captureCli(["text", input, "--agent"]);
      expect(error).toBeNull();
      const titleAt = stdout.indexOf("Title");
      const firstAt = stdout.indexOf("First");
      const boldAt = stdout.indexOf("bold");
      const secondAt = stdout.indexOf("Second");
      expect(titleAt).toBeGreaterThanOrEqual(0);
      expect(titleAt).toBeLessThan(firstAt);
      expect(firstAt).toBeLessThan(boldAt);
      expect(boldAt).toBeLessThan(secondAt);
      expect(stdout).not.toContain("ignored");
    });
  });
});

describe("search truncation", () => {
  test("human output says how many matches were withheld", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "many.pdf");
      // "the" appears three times per page across three pages.
      await makePdf(input, [
        "the the the",
        "the the the",
        "the the the",
      ]);

      const { stdout, error } = await captureCli([
        "search",
        input,
        "the",
        "--limit",
        "2",
      ]);
      expect(error).toBeNull();
      // Two match lines, then an explicit notice — previously the output just
      // stopped and the last line read as the last match in the document.
      expect(stdout).toContain("more");
      expect(stdout).toContain("--limit");
    });
  });

  test("a complete result set prints no notice", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "few.pdf");
      await makePdf(input, ["unique word here"]);

      const { stdout, error } = await captureCli(["search", input, "unique"]);
      expect(error).toBeNull();
      expect(stdout).not.toContain("--limit)");
    });
  });
});
