import {
  link,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { PdfPageTextContent as TextContent } from "../../src/pdf/engine/text";
import { buildAnchorPageText } from "../../src/pdf/annotations/resolveAnchors";
import {
  consumePdfSearchRetentionBudget,
  entryPathsMatch,
  main,
  pdfSearchPlacement,
  stripHtmlToText,
  type PdfSearchRetentionBudget,
} from "../src/main";

async function captureCli(args: string[]): Promise<{
  stdout: string;
  warnings: string[];
  errors: string[];
}> {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  console.warn = (message?: unknown) => {
    warnings.push(String(message ?? ""));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message ?? ""));
  };
  try {
    await main(args);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  return { stdout: logs.join("\n"), warnings, errors };
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-main-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function expectUsage(args: string[], message: string): Promise<void> {
  return expect(main(args)).rejects.toMatchObject({
    code: "ERR_USAGE",
    message: expect.stringContaining(message),
  });
}

describe("shiori cli", () => {
  test("agent help is compact and machine-readable", async () => {
    const { stdout, warnings, errors } = await captureCli(["help", "search", "--agent"]);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
    expect(stdout).not.toContain("\n");
    const parsed = JSON.parse(stdout) as {
      schema?: string;
      command?: string;
      tokenTip?: string;
    };
    expect(parsed.schema).toBe("shiori.cli/help/v1");
    expect(parsed.command).toBe("search");
    expect(parsed.tokenTip).toContain("20");
  });

  test("html text extraction is static and does not expose scripts", () => {
    expect(
      stripHtmlToText(
        "<h1>Title</h1><script>alert('nope')</script><p>A&nbsp;&amp;&nbsp;B</p>",
      ),
    ).toBe("Title A & B");
  });

  test("html parsing does not leak malformed or unclosed script/style bodies", () => {
    expect(stripHtmlToText("<p>Visible</p><script>secret <b>still secret"))
      .toBe("Visible");
    expect(stripHtmlToText("<p>Visible</p><style>.secret { color: red }"))
      .toBe("Visible");
    expect(stripHtmlToText("<script>bad()</script><p>&#x4F60;&#22909;</p>"))
      .toBe("你好");
  });

  test("rejects unknown options and extra positional arguments", async () => {
    await expectUsage(
      ["inspect", "site/public/welcome.pdf", "--bogus"],
      "Unknown option",
    );
    await expectUsage(
      ["inspect", "site/public/welcome.pdf", "extra"],
      "Unexpected positional argument",
    );
    await expectUsage(
      ["search", "site/public/welcome.pdf", "Welcome", "extra"],
      "Unexpected positional argument",
    );
    await expectUsage(
      ["search", "site/public/welcome.pdf", "Welcome", "--max-chars", "20"],
      "Unknown option",
    );
    await expectUsage(
      ["extract", "site/public/welcome.pdf", "--as-specc"],
      "Unknown option",
    );
    await expectUsage(
      ["inspect", "site/public/welcome.pdf", "--as-spec"],
      "Unknown option",
    );
    await expectUsage(
      ["search", "site/public/welcome.pdf", "Welcome", "--limit", "10001"],
      "must not exceed 10000",
    );
    await expectUsage(
      ["text", "site/public/welcome.pdf", "--max-chars", "10000001"],
      "must not exceed 10000000",
    );
    await expectUsage(
      [
        "app",
        "annotate",
        "--spec",
        "/tmp/annotations.json",
        "--highlight",
        "quote",
      ],
      "mutually exclusive",
    );
  });

  test("a value beginning with '-' points at the inline --name=value form", async () => {
    const pdf = "site/public/welcome.pdf";
    await expect(
      main(["annotate", pdf, "--highlight", "-3 dB roll-off", "-o", "out.pdf"]),
    ).rejects.toMatchObject({
      code: "ERR_USAGE",
      message: "--highlight requires a value",
      detail: "A value beginning with '-' must be written inline: --highlight=<value>",
    });
    // -o has no inline form; the hint names the long option. The value
    // itself (it may be a password) is never echoed.
    await expect(main(["render", pdf, "--page", "1", "-o", "-p1.png"])).rejects.toMatchObject({
      detail: "A value beginning with '-' must be written inline: --output=<value>",
    });
    await expect(main(["inspect", pdf, "--password", "-s3cret"])).rejects.toMatchObject({
      detail: expect.not.stringContaining("s3cret"),
    });
    const help = await captureCli(["--help"]);
    expect(help.stdout).toContain("must be written inline: --option=value");
    const agentHelp = JSON.parse((await captureCli(["--help", "--agent"])).stdout) as {
      rules: string[];
    };
    expect(agentHelp.rules).toContain(
      "an option value beginning with '-' must be written inline: --option=value",
    );
  });

  test("direct-entry matching canonicalizes path aliases and symlinks", async () => {
    const base = process.platform === "darwin" ? "/tmp" : tmpdir();
    const dir = await mkdtemp(join(base, "shiori-cli-entry-"));
    try {
      const executable = join(dir, "shiori-real");
      await writeFile(executable, "fixture");
      const canonical = await realpath(executable);
      expect(await entryPathsMatch(executable, canonical)).toBe(true);
      if (process.platform !== "win32") {
        const linked = join(dir, "shiori");
        await symlink(executable, linked);
        expect(await entryPathsMatch(linked, executable)).toBe(true);
        const hardlinked = join(dir, "shiori-hardlink");
        await link(executable, hardlinked);
        expect(await entryPathsMatch(hardlinked, executable)).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("streams repetitive search results and reports bounded output honestly", async () => {
    await withTempDir(async (dir) => {
      const markdown = join(dir, "repetitive.md");
      await writeFile(markdown, "a".repeat(20_000));
      const { stdout } = await captureCli([
        "search",
        markdown,
        "a",
        "--agent",
      ]);
      const parsed = JSON.parse(stdout) as {
        data: {
          matchCount: number;
          matchCountExact: boolean;
          returnedMatchCount: number;
          truncated: boolean;
          limit: number;
        };
      };
      expect(parsed.data).toMatchObject({
        matchCount: 20_000,
        matchCountExact: true,
        returnedMatchCount: 20,
        truncated: true,
        limit: 20,
      });
    });
  });

  test("keeps text matches when PDF geometry budgets are exhausted", () => {
    const textContent = {
      items: [
        {
          str: "safe",
          dir: "ltr",
          width: 24,
          height: 12,
          transform: [12, 0, 0, 12, 72, 700],
          fontName: "f1",
          hasEOL: false,
        },
      ],
      styles: { f1: { ascent: 0.8, descent: -0.2 } },
      lang: null,
    } as unknown as TextContent;
    const page = buildAnchorPageText(1, textContent, {
      id: "page-1",
      sourceIndex: 0,
      rotation: 0,
      widthPt: 612,
      heightPt: 792,
    });
    expect(
      pdfSearchPlacement(page, { index: 0, end: 4 }, { work: 0, outputRects: 1 }),
    ).toEqual({
      geometryUnavailable:
        "search geometry safety limit reached; use a shorter query or narrower --pages/--limit",
    });
    expect(
      pdfSearchPlacement(page, { index: 0, end: 4 }, { work: 100, outputRects: 0 }),
    ).toEqual({
      geometryUnavailable:
        "search geometry output limit reached; narrow --pages or --limit",
    });
  });

  test("bounds retained PDF search objects across pages", () => {
    const textContent = {
      items: [
        {
          str: "safe",
          dir: "ltr",
          width: 24,
          height: 12,
          transform: [12, 0, 0, 12, 72, 700],
          fontName: "f1",
          hasEOL: false,
        },
      ],
      styles: { f1: { ascent: 0.8, descent: -0.2 } },
      lang: null,
    } as unknown as TextContent;
    const page = buildAnchorPageText(1, textContent, {
      id: "page-1",
      sourceIndex: 0,
      rotation: 0,
      widthPt: 612,
      heightPt: 792,
    });
    const mappingExceptions = [
      page.searchIndex,
      ...page.alternateSearchIndexes,
    ].reduce((total, index) => total + index.mappingExceptions.length, 0);
    const budget: PdfSearchRetentionBudget = {
      units: page.units.length,
      spans: page.index.spans.length,
      mappingExceptions,
      sourceItems: page.sourceItemCount,
      sourceCharacters: page.sourceCharacterCount,
      runs: page.runCount,
    };

    consumePdfSearchRetentionBudget(page, budget);
    expect(budget).toEqual({
      units: 0,
      spans: 0,
      mappingExceptions: 0,
      sourceItems: 0,
      sourceCharacters: 0,
      runs: 0,
    });
    let failure: unknown;
    try {
      consumePdfSearchRetentionBudget(page, budget);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "CliError",
      code: "ERR_TEXT_UNAVAILABLE",
      message: "Search text index exceeds the safe retained-geometry budget",
      detail: "Narrow the search with --pages",
    });
  });

  test("maps pathological search normalization to a stable CLI error", async () => {
    await withTempDir(async (dir) => {
      const markdown = join(dir, "folding.md");
      await writeFile(markdown, "İ".repeat(50_001));
      await expect(main(["search", markdown, "i", "--agent"])).rejects.toMatchObject({
        code: "ERR_TEXT_UNAVAILABLE",
      });
    });
  });

  test("rejects Word files as unsupported before reading them", async () => {
    await withTempDir(async (dir) => {
      const docx = join(dir, "report.docx");
      await writeFile(docx, "PK\u0003\u0004 not text");
      for (const args of [["inspect", docx], ["text", docx], ["search", docx, "x"]]) {
        await expect(main(args)).rejects.toMatchObject({
          code: "ERR_UNSUPPORTED_DOCUMENT",
          message: "Supported files are PDF, Markdown, and HTML",
        });
      }
      // Past the Markdown read limit: the kind decides, not a size error.
      await truncate(docx, 20 * 1024 * 1024 + 1);
      await expect(main(["text", docx])).rejects.toMatchObject({
        code: "ERR_UNSUPPORTED_DOCUMENT",
      });
    });
  });

  test("reports version and documents strict CLI behavior", async () => {
    const human = await captureCli(["--version"]);
    expect(human.stdout).toMatch(/^shiori \d+\.\d+\.\d+$/);
    const agent = await captureCli(["--agent", "version"]);
    expect(JSON.parse(agent.stdout)).toMatchObject({
      schema: "shiori.cli/version/v1",
      name: "shiori",
    });
    const help = await captureCli(["--help"]);
    expect(help.stdout).toContain("--version");
    expect(help.stdout).toContain("Stop option parsing");
    expect(help.stdout).toContain("unknown options and extra arguments are errors");
    const annotateHelp = await captureCli(["help", "annotate"]);
    expect(annotateHelp.stdout).toContain("Supported round-trippable types");
  });

  test("rejects oversized text, spec, and PDF inputs before parsing", async () => {
    await withTempDir(async (dir) => {
      const markdown = join(dir, "large.md");
      await writeFile(markdown, "");
      await truncate(markdown, 20 * 1024 * 1024 + 1);
      await expect(main(["text", markdown])).rejects.toMatchObject({
        code: "ERR_FILE_TOO_LARGE",
      });

      const spec = join(dir, "large.json");
      await writeFile(spec, "");
      await truncate(spec, 5 * 1024 * 1024 + 1);
      await expect(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          spec,
          "-o",
          join(dir, "out.pdf"),
        ]),
      ).rejects.toMatchObject({ code: "ERR_FILE_TOO_LARGE" });

      const pdf = join(dir, "large.pdf");
      await writeFile(pdf, "");
      await truncate(pdf, 200 * 1024 * 1024 + 1);
      await expect(main(["inspect", pdf])).rejects.toMatchObject({
        code: "ERR_PDF_TOO_LARGE",
      });
    });
  });
});
