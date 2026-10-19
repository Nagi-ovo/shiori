// Run by `bun run test:core` after the addon is built.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, test } from "bun:test";
import { main } from "../../../cli/src/main";

const FIXTURE = join(import.meta.dir, "../../shiori-core/tests/fixtures/text.pdf");
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what `shiori render` writes) to RGBA. */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, color, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error("unsupported PNG");
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= channels ? rows[y * stride + x - channels]! : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      if (predictor === undefined) throw new Error(`bad PNG filter ${filter}`);
      rows[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: rows };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba.set(rows.subarray(i * 3, i * 3 + 3), i * 4);
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Renders page 2 of the fixture at scale 1 through the CLI and decodes the PNG. */
async function renderPage2() {
  const dir = await mkdtemp(join(tmpdir(), "shiori-core-render-"));
  dirs.push(dir);
  const output = join(dir, "page2.png");
  // Source runs read through pdf.js by default until the CLI reads only
  // through the core; ask for the core explicitly.
  const previous = process.env.SHIORI_PDF_ENGINE;
  process.env.SHIORI_PDF_ENGINE = "pdfium";
  const log = console.log;
  console.log = () => {};
  try {
    await main(["render", FIXTURE, "--page", "2", "-o", output, "--scale", "1"]);
  } finally {
    console.log = log;
    if (previous === undefined) delete process.env.SHIORI_PDF_ENGINE;
    else process.env.SHIORI_PDF_ENGINE = previous;
  }
  return decodePng(new Uint8Array(await readFile(output)));
}

describe("shiori render through the core", () => {
  test("draws the cropped, turned page with its square where the turn puts it", async () => {
    // Page 2 (make-fixtures.ts): a 540 × 700 crop box turned 90°, with a
    // 20 pt black square in the crop box's lower-left corner, which the
    // turn puts top-left. At scale 1 that is a 700 × 540 image, black in
    // [0, 20) × [0, 20) and white everywhere else.
    const page = await renderPage2();
    expect([page.width, page.height]).toEqual([700, 540]);
    const luminance = (x: number, y: number) => page.rgba[(y * page.width + x) * 4]!;
    expect(luminance(10, 10)).toBeLessThan(40);
    expect(luminance(30, 30)).toBeGreaterThan(215);
    expect(luminance(690, 530)).toBeGreaterThan(215);
    // Only anti-aliasing along the square's edges may differ from the ideal.
    let different = 0;
    for (let y = 0; y < page.height; y += 1) {
      for (let x = 0; x < page.width; x += 1) {
        const ideal = x < 20 && y < 20 ? 0 : 255;
        if (Math.abs(luminance(x, y) - ideal) > 64) different += 1;
      }
    }
    expect(different).toBeLessThan(100);
  });
});
