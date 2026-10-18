// Run by `bun run test:core` after the addon is built.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { main } from "../../../cli/src/main";

const FIXTURE = join(import.meta.dir, "../../shiori-core/tests/fixtures/text.pdf");
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Renders page 2 of the fixture through the CLI and decodes the PNG. */
async function render(engine: "pdfjs" | "pdfium") {
  const dir = await mkdtemp(join(tmpdir(), "shiori-core-render-"));
  dirs.push(dir);
  const output = join(dir, `${engine}.png`);
  const previous = process.env.SHIORI_PDF_ENGINE;
  process.env.SHIORI_PDF_ENGINE = engine;
  const log = console.log;
  console.log = () => {};
  try {
    await main(["render", FIXTURE, "--page", "2", "-o", output, "--scale", "1"]);
  } finally {
    console.log = log;
    if (previous === undefined) delete process.env.SHIORI_PDF_ENGINE;
    else process.env.SHIORI_PDF_ENGINE = previous;
  }
  const image = await loadImage(await readFile(output));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  const luminance = (x: number, y: number) => data[(y * image.width + x) * 4]!;
  return { width: image.width, height: image.height, data, luminance };
}

describe("shiori render through the core", () => {
  test("draws the page PDFium's way, where pdf.js draws it", async () => {
    // Page 2: a 540 × 700 crop box turned 90°, with a 20 pt black square
    // in the crop box's lower-left corner, which the turn puts top-left.
    const core = await render("pdfium");
    const pdfjs = await render("pdfjs");
    expect([core.width, core.height]).toEqual([700, 540]);
    expect([pdfjs.width, pdfjs.height]).toEqual([700, 540]);
    for (const page of [core, pdfjs]) {
      expect(page.luminance(10, 10)).toBeLessThan(40);
      expect(page.luminance(30, 30)).toBeGreaterThan(215);
      expect(page.luminance(690, 530)).toBeGreaterThan(215);
    }
    // Anti-aliasing differs at the square's edges; nothing else does.
    let different = 0;
    for (let i = 0; i < core.data.length; i += 4) {
      if (Math.abs(core.data[i]! - pdfjs.data[i]!) > 64) different += 1;
    }
    expect(different).toBeLessThan(100);
  });
});
