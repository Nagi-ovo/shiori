import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  StandardFonts,
} from "pdf-lib";
import { main } from "../../src/main";
import {
} from "../../src/annotate";

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
  const dir = await mkdtemp(join(tmpdir(), "shiori-cli-annotate-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function annotationCount(path: string, pageIndex = 0): Promise<number> {
  const loaded = await PDFDocument.load(await readFile(path));
  return loaded.getPage(pageIndex).node.Annots()?.size() ?? 0;
}

async function firstAnnotationRect(path: string): Promise<number[]> {
  const loaded = await PDFDocument.load(await readFile(path));
  const annot = loaded.getPage(0).node.Annots()?.lookupMaybe(0, PDFDict);
  const rect = annot?.lookupMaybe(PDFName.of("Rect"), PDFArray);
  if (!rect) return [];
  const out: number[] = [];
  for (let i = 0; i < rect.size(); i += 1) {
    out.push(rect.lookup(i, PDFNumber).asNumber());
  }
  return out;
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

async function makeOutOfBoundsCropTextPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.setCropBox(-50, -100, 700, 900);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Crop anchor", { x: 150, y: 300, size: 12, font });
  await writeFile(path, await doc.save());
}

describe("shiori annotate", () => {
  test(
    "anchors against the effective CropBox, clipped to the MediaBox",
    async () => {
      await withTempDir(async (dir) => {
        const input = join(dir, "out-of-bounds-crop.pdf");
        const output = join(dir, "anchored.pdf");
        await makeOutOfBoundsCropTextPdf(input);
        await main([
          "annotate",
          input,
          "--highlight",
          "Crop anchor",
          "-o",
          output,
        ]);
        const rect = await firstAnnotationRect(output);
        expect(rect).toHaveLength(4);
        expect(rect[0]).toBeGreaterThan(140);
        expect(rect[0]).toBeLessThan(160);
      });
    },
    { timeout: 30_000 },
  );

  test("resolves quote anchors end-to-end and reports them in dry runs", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "welcome.pdf");
      const spec = join(dir, "spec.json");
      const output = join(dir, "anchored.pdf");
      await copyFile("site/public/welcome.pdf", input);
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            { type: "highlight", anchor: { quote: "Shiori", occurrence: 1 } },
          ],
        }),
      );

      const dryRun = await captureCli([
        "annotate",
        input,
        "--spec",
        spec,
        "-o",
        output,
        "--dry-run",
        "--agent",
      ]);
      const dryPayload = JSON.parse(dryRun.stdout) as {
        data: {
          anchors?: Array<{ index: number; page: number; rects: unknown[]; quote: string }>;
          placements?: Array<{ index: number; page: number; rects: unknown[] }>;
        };
      };
      const anchors = dryPayload.data.anchors ?? [];
      expect(anchors).toHaveLength(1);
      expect(anchors[0]!.page).toBe(1);
      expect(anchors[0]!.quote).toBe("Shiori");
      expect(anchors[0]!.rects.length).toBeGreaterThan(0);
      expect(dryPayload.data.placements?.[0]).toMatchObject({
        index: 0,
        page: 1,
      });

      const humanDryRun = await captureCli([
        "annotate",
        input,
        "--spec",
        spec,
        "-o",
        output,
        "--dry-run",
      ]);
      expect(humanDryRun.stdout).toContain("#1 highlight p.1 rects=[x=");

      await main(["annotate", input, "--spec", spec, "-o", output]);
      const extracted = await captureCli([
        "extract",
        output,
        "--as-spec",
      ]);
      const roundTrip = JSON.parse(extracted.stdout) as {
        annotations: Array<{ type: string; page: number; rects: unknown[]; quote?: string }>;
      };
      const highlight = roundTrip.annotations.find((a) => a.type === "highlight");
      expect(highlight).toBeDefined();
      expect(highlight!.page).toBe(1);
      expect(highlight!.rects.length).toBeGreaterThan(0);
    });
  });

  test("reports unresolved and ambiguous anchors with actionable errors", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "welcome.pdf");
      const spec = join(dir, "spec.json");
      await copyFile("site/public/welcome.pdf", input);

      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            { type: "highlight", anchor: { quote: "text that is nowhere" } },
          ],
        }),
      );
      await expectCliError(
        main(["annotate", input, "--spec", spec, "-o", join(dir, "o1.pdf")]),
        "ERR_ANCHOR_UNRESOLVED",
        "was not found",
      );

      await writeFile(
        spec,
        JSON.stringify({
          annotations: [{ type: "highlight", anchor: { quote: "Shiori" } }],
        }),
      );
      await expectCliError(
        main(["annotate", input, "--spec", spec, "-o", join(dir, "o2.pdf")]),
        "ERR_ANCHOR_UNRESOLVED",
        "anchor.page and/or anchor.occurrence",
      );

      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            { type: "highlight", page: 1, anchor: { quote: "Shiori" } },
          ],
        }),
      );
      await expectCliError(
        main(["annotate", input, "--spec", spec, "-o", join(dir, "o3.pdf")]),
        "ERR_SPEC_INVALID",
        "page must be omitted",
      );
    });
  });

  test("--highlight annotates without a spec file", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "welcome.pdf");
      const output = join(dir, "sugar.pdf");
      await copyFile("site/public/welcome.pdf", input);

      const before = await annotationCount(input);
      const { stdout } = await captureCli([
        "annotate",
        input,
        "--highlight",
        "A Local-First PDF Reader and Editor",
        "-o",
        output,
      ]);
      expect(stdout).toContain("1 annotations written");
      await expect(annotationCount(output)).resolves.toBe(before + 1);
    });
  });
});
