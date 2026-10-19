import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { main } from "../../src/main";
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
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-extract-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type ExtractEnvelope = {
  ok: boolean;
  command: "extract";
  data: {
    command: "extract";
    input: string;
    pages: number[];
    annotations: Array<Record<string, unknown>>;
  };
};

type PdfRect = { x: number; y: number; w: number; h: number };

/** shiori-core's text fixture (crates/shiori-core/tests/fixtures/make-fixtures.ts). */
const TEXT_FIXTURE = "crates/shiori-core/tests/fixtures/text.pdf";
/**
 * "Shiori" on that fixture's page 1, as make-fixtures.ts draws it: 12 pt
 * Helvetica from (72, 700). Helvetica's advances (S 667, h 556, i 222,
 * o 556, r 333, i 222 per 1000 em) make it 30.672 pt wide; the band runs
 * from below the descent (-2.5 pt) to above the ascent (8.6 pt).
 */
const SHIORI_RECT: PdfRect = { x: 72, y: 697, w: 30.672, h: 12 };

type AnnotationSpec = {
  schema: "shiori.annotations/v1";
  annotations: Array<Record<string, unknown>>;
};

describe("shiori extract", () => {
  test("round-trips annotate output with a text quote", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "text.pdf");
      const spec = join(dir, "spec.json");
      const annotated = join(dir, "annotated.pdf");
      await copyFile(TEXT_FIXTURE, input);
      const rect = SHIORI_RECT;
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "highlight",
              page: 1,
              rects: [rect],
              color: "#f6c744",
              opacity: 0.35,
            },
            {
              type: "note",
              page: 1,
              at: { x: 300, y: 600 },
              text: "Review this line",
              color: "#f6c744",
            },
          ],
        }),
      );

      await captureCli(["annotate", input, "--spec", spec, "-o", annotated, "--agent"]);
      const { stdout, warnings, errors } = await captureCli([
        "extract",
        annotated,
        "--pages",
        "1",
        "--agent",
      ]);

      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      const parsed = JSON.parse(stdout) as ExtractEnvelope;
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe("extract");
      expect(parsed.data.input).toBe(resolve(annotated));
      expect(parsed.data.annotations).toHaveLength(2);
      const highlight = parsed.data.annotations.find(
        (annotation) => annotation.type === "highlight",
      );
      const note = parsed.data.annotations.find(
        (annotation) => annotation.type === "note",
      );
      expect(highlight).toMatchObject({ type: "highlight", page: 1 });
      expect(String(highlight?.quote)).toContain("Shiori");
      expect(note).toMatchObject({
        type: "note",
        page: 1,
        text: "Review this line",
      });
    });
  });

  test("filters extracted annotations by page", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "welcome.pdf");
      const spec = join(dir, "spec.json");
      const annotated = join(dir, "annotated.pdf");
      await copyFile("site/public/welcome.pdf", input);
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "note",
              page: 1,
              at: { x: 300, y: 600 },
              text: "page one",
            },
            {
              type: "note",
              page: 2,
              at: { x: 200, y: 500 },
              text: "page two",
            },
          ],
        }),
      );

      await captureCli(["annotate", input, "--spec", spec, "-o", annotated, "--agent"]);
      const { stdout } = await captureCli([
        "extract",
        annotated,
        "--agent",
        "--pages",
        "2",
      ]);

      const parsed = JSON.parse(stdout) as ExtractEnvelope;
      expect(parsed.data.pages).toEqual([2]);
      expect(parsed.data.annotations).toEqual([
        expect.objectContaining({ type: "note", page: 2, text: "page two" }),
      ]);
    });
  });

  test("returns an empty list for PDFs without annotations", async () => {
    const { stdout, warnings, errors } = await captureCli([
      "extract",
      "site/public/welcome.pdf",
      "--agent",
    ]);

    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
    const parsed = JSON.parse(stdout) as ExtractEnvelope;
    expect(parsed.data.pages).toEqual([1, 2, 3]);
    expect(parsed.data.annotations).toEqual([]);
  });

  test("reports annotations it cannot read as unavailable, not as none", async () => {
    await withTempDir(async (dir) => {
      // PDFium follows the cross-reference to the catalog; pdf-lib reads
      // objects in file order, so a later object 1 outside the table
      // replaces the catalog for it and its annotation pass fails.
      const input = join(dir, "two-catalogs.pdf");
      await writeFile(
        input,
        handMadePdf(
          "BT /F1 12 Tf 72 700 Td (Hello) Tj ET",
          "1 0 obj\n(not a catalog)\nendobj\n",
        ),
      );
      const text = await captureCli(["text", input, "--agent"]);
      expect(JSON.parse(text.stdout)).toMatchObject({ ok: true });
      await expect(main(["extract", input, "--agent"])).rejects.toMatchObject({
        code: "ERR_ANNOTATIONS_UNAVAILABLE",
      });
    });
  });

  test("--as-spec emits pure annotate input without an envelope", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "text.pdf");
      const seedSpec = join(dir, "seed.json");
      const annotated = join(dir, "annotated.pdf");
      await copyFile(TEXT_FIXTURE, input);
      const rect = SHIORI_RECT;
      await writeFile(
        seedSpec,
        JSON.stringify({
          annotations: [
            {
              type: "highlight",
              page: 1,
              rects: [rect],
              color: "#f6c744",
              opacity: 0.35,
            },
          ],
        }),
      );
      await captureCli(["annotate", input, "--spec", seedSpec, "-o", annotated]);

      const { stdout } = await captureCli([
        "extract",
        annotated,
        "--pages",
        "1",
        "--as-spec",
        "--agent",
      ]);
      const parsed = JSON.parse(stdout) as AnnotationSpec & Record<string, unknown>;
      expect(parsed.schema).toBe("shiori.annotations/v1");
      expect(parsed.annotations).toHaveLength(1);
      expect(parsed.annotations[0]?.quote).toContain("Shiori");
      expect(parsed.ok).toBeUndefined();
      expect(parsed.command).toBeUndefined();
      expect(parsed.input).toBeUndefined();
      expect(stdout).not.toContain("\n");

      const human = await captureCli(["extract", annotated, "--pages", "1", "--as-spec"]);
      expect(human.stdout).toBe(stdout);
      expect(human.stdout).not.toContain("\n");
    });
  });

  test("round-trips all extractable annotation types through a pure spec", async () => {
    await withTempDir(async (dir) => {
      const original = join(dir, "original.pdf");
      const seedSpecPath = join(dir, "seed.json");
      const extractedSpecPath = join(dir, "extracted.json");
      const seedPdf = join(dir, "seed.pdf");
      const replayPdf = join(dir, "replay.pdf");
      await copyFile(TEXT_FIXTURE, original);
      const quoteRect = SHIORI_RECT;
      const seed: AnnotationSpec = {
        schema: "shiori.annotations/v1",
        annotations: [
          {
            type: "highlight",
            page: 1,
            rects: [quoteRect],
            color: "#f6c744",
            opacity: 0.35,
            quote: "Shiori",
          },
          {
            type: "underline",
            page: 1,
            rects: [{ x: 80, y: 520, w: 80, h: 12 }],
            color: "#2c6eaa",
            opacity: 0.7,
          },
          {
            type: "strikethrough",
            page: 1,
            rects: [{ x: 180, y: 520, w: 80, h: 12 }],
            color: "#b13a2e",
            opacity: 0.8,
          },
          {
            type: "note",
            page: 1,
            at: { x: 300, y: 500 },
            text: "Review",
            color: "#f6c744",
          },
          {
            type: "callout",
            page: 1,
            targetRects: [quoteRect],
            rect: { x: 310, y: 380, w: 144, h: 54 },
            leader: [
              { x: quoteRect.x + quoteRect.w, y: quoteRect.y + quoteRect.h / 2 },
              { x: 285, y: 407 },
              { x: 310, y: 407 },
            ],
            leaderKind: "polyline",
            text: "Key claim",
            fontSize: 12,
            color: "#b13a2e",
            align: "left",
          },
          {
            type: "ink",
            page: 1,
            paths: [[{ x: 80, y: 450 }, { x: 120, y: 470 }]],
            color: "#1a1815",
            width: 2,
          },
          {
            type: "rect",
            page: 1,
            rect: { x: 150, y: 430, w: 80, h: 40 },
            color: "#2c6eaa",
            strokeWidth: 2,
            fill: null,
          },
          {
            type: "stamp",
            page: 1,
            kind: "check",
            rect: { x: 250, y: 430, w: 32, h: 32 },
            color: "#2e7d32",
            strokeWidth: 2,
          },
          {
            type: "text",
            page: 1,
            rect: { x: 80, y: 360, w: 160, h: 30 },
            text: "Round trip",
            fontSize: 12,
            color: "#123456",
            bold: true,
            italic: true,
            align: "right",
            fontFamily: "serif",
          },
        ],
      };
      await writeFile(seedSpecPath, JSON.stringify(seed));
      await captureCli([
        "annotate",
        original,
        "--spec",
        seedSpecPath,
        "-o",
        seedPdf,
      ]);

      const first = await captureCli([
        "extract",
        seedPdf,
        "--pages",
        "1",
        "--as-spec",
        "--agent",
      ]);
      const extracted = JSON.parse(first.stdout) as AnnotationSpec;
      await writeFile(extractedSpecPath, first.stdout);
      await captureCli([
        "annotate",
        original,
        "--spec",
        extractedSpecPath,
        "-o",
        replayPdf,
      ]);
      const second = await captureCli([
        "extract",
        replayPdf,
        "--pages",
        "1",
        "--as-spec",
        "--agent",
      ]);
      const replayed = JSON.parse(second.stdout) as AnnotationSpec;
      const expectedTypes = [
        "callout",
        "highlight",
        "ink",
        "note",
        "rect",
        "stamp",
        "strikethrough",
        "text",
        "underline",
      ];
      expect(extracted.annotations.map(({ type }) => type).sort()).toEqual(expectedTypes);
      expect(replayed.annotations.map(({ type }) => type).sort()).toEqual(expectedTypes);
      expect(replayed.annotations).toEqual(extracted.annotations);
      expect(
        replayed.annotations.find(({ type }) => type === "highlight")?.quote,
      ).toContain("Shiori");
    });
  });
});
