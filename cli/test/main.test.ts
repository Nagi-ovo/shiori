import {
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
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

async function makeSearchLayoutPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("first visual line", { x: 72, y: 700, size: 12, font });
  page.drawText("second phrase", { x: 72, y: 686, size: 12, font });
  page.drawText("inter-", { x: 72, y: 650, size: 12, font });
  page.drawText("national", { x: 72, y: 636, size: 12, font });
  page.drawText("paragraph one", { x: 72, y: 590, size: 12, font });
  page.drawText("paragraph two", { x: 72, y: 550, size: 12, font });
  doc.registerFontkit(fontkit);
  const cjk = await doc.embedFont(
    await readFile("src/assets/fonts/NotoSansSC-Regular.otf"),
    { subset: true },
  );
  page.drawText("Token ⾃由 同时⾼强度使⽤", {
    x: 72,
    y: 510,
    size: 12,
    font: cjk,
  });
  page.drawText("翻天覆地的", { x: 72, y: 480, size: 12, font: cjk });
  page.drawText("变化", { x: 72, y: 466, size: 12, font: cjk });
  page.drawText("极好。其对", { x: 72, y: 440, size: 12, font: cjk });
  page.drawText("整体架构", { x: 72, y: 426, size: 12, font: cjk });
  page.drawText("short end", { x: 72, y: 390, size: 12, font });
  page.drawText("next paragraph", { x: 72, y: 376, size: 12, font });
  await writeFile(path, await doc.save());
}

describe("shiori cli", () => {
  test("agent inspect writes a clean JSON envelope", async () => {
    const { stdout, warnings, errors } = await captureCli([
      "inspect",
      "site/public/welcome.pdf",
      "--agent",
    ]);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
    const parsed = JSON.parse(stdout) as {
      schema?: string;
      ok?: boolean;
      command?: string;
      data?: { pdf?: { pageCount?: number; pages?: unknown[]; metadata?: unknown } };
    };
    expect(stdout).not.toContain("\n");
    expect(parsed.schema).toBe("shiori.cli/v1");
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("inspect");
    expect(parsed.data?.pdf?.pageCount).toBe(3);
    expect(parsed.data?.pdf?.pages).toBeUndefined();
    expect(parsed.data?.pdf?.metadata).toBeUndefined();
  });

  test("agent inspect includes page boxes only when requested", async () => {
    const { stdout } = await captureCli([
      "inspect",
      "site/public/welcome.pdf",
      "--agent",
      "--pages",
      "1",
    ]);
    const parsed = JSON.parse(stdout) as {
      data?: { pdf?: { pages?: Array<{ page?: number }> } };
    };
    expect(parsed.data?.pdf?.pages).toEqual([
      expect.objectContaining({ page: 1 }),
    ]);
  });

  test("agent inspect includes metadata only when requested", async () => {
    const { stdout } = await captureCli([
      "inspect",
      "site/public/welcome.pdf",
      "--agent",
      "--metadata",
    ]);
    const parsed = JSON.parse(stdout) as {
      data?: { pdf?: { metadata?: Record<string, string> } };
    };
    expect(parsed.data?.pdf?.metadata?.Title).toContain("Welcome");
  });

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

  test("supports -- for positional values beginning with a dash", async () => {
    const { stdout } = await captureCli([
      "search",
      "site/public/welcome.pdf",
      "--",
      "--agent",
    ]);
    expect(stdout).toBe("No matches.");
  });

  test("strict page ranges reject zero, overflow, and garbage", async () => {
    await expectUsage(
      ["inspect", "site/public/welcome.pdf", "--pages", "0"],
      "between 1 and 3",
    );
    await expectUsage(
      ["inspect", "site/public/welcome.pdf", "--pages", "4"],
      "between 1 and 3",
    );
    await expectUsage(
      ["inspect", "site/public/welcome.pdf", "--pages", "1,nope"],
      "only page numbers",
    );
    await expectUsage(
      ["inspect", "site/public/welcome.pdf", "--pages", "1,"],
      "only page numbers",
    );
    await expectUsage(
      ["inspect", "site/public/welcome.pdf", "--pages", "3-1"],
      "range start must not exceed",
    );
  });

  test("max-chars is one total PDF text budget and stops later pages", async () => {
    const { stdout } = await captureCli([
      "text",
      "site/public/welcome.pdf",
      "--pages",
      "1-3",
      "--max-chars",
      "12",
      "--agent",
    ]);
    const parsed = JSON.parse(stdout) as {
      data: {
        pages: Array<{ text: string; truncated: boolean }>;
        returnedCharacters: number;
        truncated: boolean;
      };
    };
    expect(parsed.data.returnedCharacters).toBeLessThanOrEqual(12);
    expect(parsed.data.pages.reduce((sum, page) => sum + page.text.length, 0)).toBe(12);
    expect(parsed.data.pages).toHaveLength(1);
    expect(parsed.data.pages[0]?.truncated).toBe(true);
    expect(parsed.data.truncated).toBe(true);
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

  test("PDF search returns reusable geometry across wraps and hyphenation", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "layout.pdf");
      await makeSearchLayoutPdf(input);
      const wrapped = await captureCli([
        "search",
        input,
        "visual linesecond phrase",
        "--agent",
      ]);
      const payload = JSON.parse(wrapped.stdout) as {
        data: {
          coordinateSpace: {
            name: string;
            origin: string;
            rects: string;
            recommendedUse: string;
          };
          matches: Array<{
            page: number;
            pageOccurrence: number;
            anchor: { quote: string; page: number; occurrence: number };
            rects: Array<{ x: number; y: number; w: number; h: number }>;
            rect: { x: number; y: number; w: number; h: number };
          }>;
        };
      };
      expect(payload.data.coordinateSpace).toMatchObject({
        name: "pdf-user-space",
        origin: "bottom-left",
        rects: expect.stringContaining("estimated"),
        recommendedUse: expect.stringContaining("free-text placement reference"),
      });
      expect(payload.data.matches[0]).toMatchObject({
        page: 1,
        pageOccurrence: 1,
        anchor: {
          quote: "visual linesecond phrase",
          page: 1,
          occurrence: 1,
        },
      });
      expect(payload.data.matches[0]!.rects).toHaveLength(2);
      expect(payload.data.matches[0]!.rect.w).toBeGreaterThan(0);
      expect(payload.data.matches[0]!.rect.h).toBeGreaterThan(12);

      const hyphenated = await captureCli([
        "search",
        input,
        "international",
        "--agent",
      ]);
      expect(JSON.parse(hyphenated.stdout)).toMatchObject({
        data: { returnedMatchCount: 1, matches: [{ page: 1 }] },
      });
      const paragraph = await captureCli([
        "search",
        input,
        "one paragraph",
        "--agent",
      ]);
      expect(JSON.parse(paragraph.stdout)).toMatchObject({
        data: { returnedMatchCount: 0 },
      });
      const sameLeadingParagraph = await captureCli([
        "search",
        input,
        "end next",
        "--agent",
      ]);
      expect(JSON.parse(sameLeadingParagraph.stdout)).toMatchObject({
        data: { returnedMatchCount: 0 },
      });
      const compatibleCjk = await captureCli([
        "search",
        input,
        "Token 自由 同时高强度",
        "--agent",
      ]);
      expect(JSON.parse(compatibleCjk.stdout)).toMatchObject({
        data: { returnedMatchCount: 1, matches: [{ page: 1 }] },
      });
      for (const query of ["翻天覆地的变化", "极好。其对整体架构"]) {
        const result = await captureCli(["search", input, query, "--agent"]);
        expect(JSON.parse(result.stdout)).toMatchObject({
          data: {
            returnedMatchCount: 1,
            matches: [{ page: 1, rects: expect.any(Array) }],
          },
        });
      }

      const human = await captureCli([
        "search",
        input,
        "international",
      ]);
      expect(human.stdout).toMatch(/^\[p\.1 x=\d/);

      const reference = payload.data.matches[0]!.rect;
      const textRect = {
        x: reference.x,
        y: Math.max(0, reference.y - 30),
        w: Math.max(120, reference.w),
        h: 24,
      };
      const spec = join(dir, "free-text.json");
      const output = join(dir, "free-text.pdf");
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "text",
              page: payload.data.matches[0]!.page,
              rect: textRect,
              text: "Direct page text",
            },
          ],
        }),
      );
      await main(["annotate", input, "--spec", spec, "-o", output]);
      const extracted = await captureCli(["extract", output, "--as-spec"]);
      expect(JSON.parse(extracted.stdout)).toMatchObject({
        annotations: [
          {
            type: "text",
            page: 1,
            text: "Direct page text",
            rect: textRect,
          },
        ],
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

  test("human inspect prints requested metadata", async () => {
    const { stdout } = await captureCli([
      "inspect",
      "site/public/welcome.pdf",
      "--metadata",
    ]);
    expect(stdout).toContain("Metadata:");
    expect(stdout).toContain("Title: Shiori — Welcome");
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
