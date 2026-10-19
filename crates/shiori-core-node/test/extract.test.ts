// Run by `bun run test:core` after the addon is built; `bun run test` skips
// crates/ because a fresh checkout has no addon.
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { main } from "../../../cli/src/main";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const logs: string[] = [];
  const log = console.log;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  try {
    await main(args);
  } finally {
    console.log = log;
  }
  return logs.join("\n");
}

async function extract(file: string) {
  const output = await cli(["extract", file, "--pages", "1", "--agent"]);
  const parsed = JSON.parse(output) as {
    ok: boolean;
    data: { annotations: Array<Record<string, unknown>> };
  };
  expect(parsed.ok).toBe(true);
  return parsed.data.annotations;
}

/** shiori-core's text fixture (crates/shiori-core/tests/fixtures/make-fixtures.ts). */
const FIXTURE = join(import.meta.dir, "../../shiori-core/tests/fixtures/text.pdf");
/**
 * "Shi" of the fixture's page 1, as make-fixtures.ts draws it: "Shiori" in
 * 12 pt Helvetica from (72, 700). Helvetica's advances (S 667, h 556,
 * i 222 per 1000 em) end "Shi" 17.34 pt along, where "o" begins; the band
 * runs from below the descent to above the ascent.
 */
const SHI = { x: 72, y: 697, w: 17.34, h: 12 };

describe("extract through shiori-core", () => {
  test("quotes exactly the highlighted letters and reads back what annotate wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shiori-core-extract-"));
    dirs.push(dir);
    const input = join(dir, "text.pdf");
    const spec = join(dir, "spec.json");
    const annotated = join(dir, "annotated.pdf");
    await copyFile(FIXTURE, input);
    await writeFile(
      spec,
      JSON.stringify({
        annotations: [
          { type: "highlight", page: 1, rects: [SHI], color: "#f6c744", opacity: 0.35 },
          { type: "note", page: 1, at: { x: 300, y: 600 }, text: "n", color: "#f6c744" },
        ],
      }),
    );
    await cli(["annotate", input, "--spec", spec, "-o", annotated, "--agent"]);

    const [extracted, note, ...rest] = await extract(annotated);
    expect(rest).toEqual([]);
    // The quote follows from where the fixture drew its glyphs: a reader
    // placing them anywhere else quotes more or fewer letters.
    expect(extracted).toMatchObject({ type: "highlight", page: 1, color: "#f6c744", opacity: 0.35, quote: "Shi" });
    // The rect as the spec gave it; the CLI prints it rounded to 0.001 pt.
    const [rect, ...otherRects] = extracted!.rects as Array<typeof SHI>;
    expect(otherRects).toEqual([]);
    for (const key of ["x", "y", "w", "h"] as const) expect(rect![key]).toBeCloseTo(SHI[key], 2);
    expect(note).toEqual({ type: "note", page: 1, at: { x: 300, y: 600 }, text: "n", color: "#f6c744" });
  });
});
