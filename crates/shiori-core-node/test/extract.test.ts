// Run by `bun run test:core` after the addon is built; `bun run test` skips
// crates/ because a fresh checkout has no addon.
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { openCoreDocument } from "../../../cli/src/coreEngine";
import { main } from "../../../cli/src/main";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function cli(args: string[], engine: "pdfjs" | "pdfium" = "pdfjs") {
  const previous = process.env.SHIORI_PDF_ENGINE;
  process.env.SHIORI_PDF_ENGINE = engine;
  const logs: string[] = [];
  const log = console.log;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  try {
    await main(args);
  } finally {
    console.log = log;
    if (previous === undefined) delete process.env.SHIORI_PDF_ENGINE;
    else process.env.SHIORI_PDF_ENGINE = previous;
  }
  return logs.join("\n");
}

async function extract(file: string, engine: "pdfjs" | "pdfium") {
  const output = await cli(["extract", file, "--agent"], engine);
  const parsed = JSON.parse(output) as {
    ok: boolean;
    data: { annotations: Array<Record<string, unknown>> };
  };
  expect(parsed.ok).toBe(true);
  return parsed.data.annotations;
}

describe("extract through shiori-core", () => {
  test("quotes exactly the highlighted words, and agrees with pdf.js on everything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-core-extract-"));
    dirs.push(dir);
    const input = join(dir, "welcome.pdf");
    const spec = join(dir, "spec.json");
    const annotated = join(dir, "annotated.pdf");
    await copyFile("site/public/welcome.pdf", input);

    // The box of "Local-First" on page 1, from the core's own glyphs.
    const core = openCoreDocument(new Uint8Array(await readFile(input)));
    const geometry = core.pageGeometry(0);
    const glyphs = core.glyphs(0);
    core.close();
    const text = glyphs.map((glyph) => glyph.text).join("");
    const start = text.indexOf("Local-First");
    expect(start).toBeGreaterThanOrEqual(0);
    const word = glyphs.slice(start, start + "Local-First".length);
    const left = Math.min(...word.map((g) => g.origin[0]));
    const right = Math.max(...word.map((g) => g.end[0]));
    const bottom = Math.min(...word.map((g) => g.loose[1]));
    const top = Math.max(...word.map((g) => g.loose[3]));
    await writeFile(
      spec,
      JSON.stringify({
        annotations: [
          {
            type: "highlight",
            page: 1,
            rects: [
              {
                x: left - geometry.originX,
                y: bottom - geometry.originY,
                w: right - left,
                h: top - bottom,
              },
            ],
            color: "#f6c744",
            opacity: 0.35,
          },
          { type: "note", page: 1, at: { x: 300, y: 600 }, text: "n", color: "#f6c744" },
        ],
      }),
    );
    await cli(["annotate", input, "--spec", spec, "-o", annotated, "--agent"]);

    const viaPdfjs = await extract(annotated, "pdfjs");
    const viaCore = await extract(annotated, "pdfium");
    const quote = (list: Array<Record<string, unknown>>) =>
      list.find((annotation) => annotation.type === "highlight")?.quote;
    expect(quote(viaCore)).toBe("Local-First");
    // pdf.js can only hand back the whole text item around the words.
    expect(String(quote(viaPdfjs))).toContain("Local-First");
    const withoutQuotes = (list: Array<Record<string, unknown>>) =>
      list.map((annotation) => {
        const rest = { ...annotation };
        delete rest.quote;
        return rest;
      });
    expect(withoutQuotes(viaCore)).toEqual(withoutQuotes(viaPdfjs));
  });

});
