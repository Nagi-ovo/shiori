import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  main,
} from "../../src/main";
import { handMadePdf } from "./handMadePdf";

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

  test("refuses a page over the core's character bound instead of reading it", async () => {
    await withTempDir(async (dir) => {
      // 101 strings of 20,000 characters: past shiori-core's MAX_PAGE_CHARS
      // (2,000,000). PDFium reads at most 32,767 from one string.
      const input = join(dir, "dense.pdf");
      const run = `(${"a".repeat(20_000)}) Tj `.repeat(101);
      await writeFile(input, handMadePdf(`BT /F1 1 Tf 0 0 Td ${run}ET`));
      for (const command of [["text"], ["search", "aaa"]]) {
        await expect(main([command[0]!, input, ...command.slice(1)])).rejects.toMatchObject({
          code: "ERR_TEXT_UNAVAILABLE",
        });
      }
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
});
