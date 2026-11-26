import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { openPdfium } from "../../../scripts/pdf-inplace/nativePdfium";
import type { PageModel, SourceImageEditOverlay } from "../model/types";
import { exportPdf } from "./exportPdf";
import { listSourceImages } from "./sourceImages";

const library = "vendor/pdfium/linux-x64/lib/libpdfium.so";
const native = existsSync(library) ? openPdfium(library) : undefined;
afterAll(() => native?.close());

const page: PageModel = { id: "p", sourceIndex: 0, widthPt: 240, heightPt: 160, rotation: 0 };
const colors = [[224, 32, 48], [24, 208, 72], [16, 64, 208], [240, 200, 32]];
const white = [255, 255, 255];
const clip = "20 20 40 30 re W n";
const photo = "q 40 0 0 30 20 20 cm /Photo Do Q";
const inline = "BI /W 2 /H 2 /BPC 8 /CS /RGB /F /AHx ID e0203018d0481040d0f0c820> EI";
const move = { x: 85, y: 62, w: 40, h: 30 };

async function fixture(build: (form: (program: string, box?: number[]) => string) => string | string[]) {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([page.widthPt, page.heightPt]);
  const ctx = pdf.context;
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const image = ctx.register(ctx.flateStream(Uint8Array.from(colors.flat()), {
    Type: "XObject", Subtype: "Image", Width: 2, Height: 2, ColorSpace: "DeviceRGB", BitsPerComponent: 8,
  }));
  const xObjects = ctx.obj({ Photo: image });
  let nextForm = 0;
  const form = (program: string, box = [0, 0, 240, 160]) => {
    const name = `F${++nextForm}`;
    xObjects.set(PDFName.of(name), ctx.register(ctx.flateStream(program, { Type: "XObject", Subtype: "Form", BBox: box })));
    return `/${name} Do`;
  };
  const program = build(form);
  const other = "0 0 1 rg 8 100 16 8 re f 0 g BT /F1 12 Tf 10 130 Td (Following text) Tj ET";
  p.node.set(PDFName.of("Resources"), ctx.obj({ XObject: xObjects, Font: { F1: font.ref } }));
  p.node.set(PDFName.of("Contents"), ctx.obj([...[program].flat(), other].map(part => ctx.register(ctx.flateStream(part)))));
  const bytes = await pdf.save();
  const [target] = await listSourceImages(bytes, 0);
  expect(target).toBeDefined();
  const run = (patch: Partial<SourceImageEditOverlay>, acceptance: "review" | "strict" = "review") =>
    exportPdf(bytes, { pages: [page], overlays: [{ type: "sourceImageEdit", id: "photo", pageId: page.id, target: target!, ...patch }] },
      { acceptance });
  return { bytes, run, target: target! };
}

function raster(bytes: Uint8Array) {
  const result = native!.inspectPage(bytes, 0, true);
  return {
    text: result.text.trim(),
    at(x: number, y: number) {
      const i = 4 * ((result.height * 2 - 1 - Math.round(y * 2)) * result.width * 2 + Math.round(x * 2));
      return Array.from(result.pixels!.subarray(i, i + 3)).reverse();
    },
  };
}

test.skipIf(!native).each([
  { label: "full page escape across stream parts", program: ["q 20 20 40", "30 re W n", photo + " Q"], rect: move, angle: 0 },
  { label: "partial escape", program: `q ${clip} ${photo} Q`, rect: { x: 37, y: 25, w: 40, h: 30 }, angle: 0 },
  { label: "resize beyond even-odd clip", program: `q ${clip.replace(" W ", " W* ")} ${photo} Q`, rect: { x: 20, y: 20, w: 76, h: 56 }, angle: 0 },
  { label: "rotate outside the clip", program: `q ${clip} ${photo} Q`, rect: { x: 20, y: 20, w: 40, h: 30 }, angle: 90 },
  { label: "inline paint inside two clips", program: `q ${clip} q 10 15 60 41 re W n ${photo.replace("/Photo Do", inline)} Q Q`, rect: move, angle: 0 },
])("preserves the requested quadrants for $label", async ({ program, rect, angle }) => {
  const { bytes, run, target } = await fixture(() => program);
  const result = await run({ rect, angle });
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "photo", mode: "applied" }]);
  const { at, text } = raster(result.bytes);
  const rad = -angle * Math.PI / 180;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const samples = [[.25, .75], [.75, .75], [.25, .25], [.75, .25]];
  for (const [i, [u, v]] of samples.entries()) {
    const dx = (u! - .5) * rect.w, dy = (v! - .5) * rect.h;
    expect(at(cx + Math.cos(rad) * dx - Math.sin(rad) * dy, cy + Math.sin(rad) * dx + Math.cos(rad) * dy)).toEqual(colors[i]!);
  }
  if (rect.x > 20) expect(at(25, 25)).toEqual(white);
  if (angle === 90) {
    expect(at(30, 52)).toEqual(colors[2]!);
    expect(at(49, 17)).toEqual(colors[1]!);
  }
  expect(at(14, 104)).toEqual(raster(bytes).at(14, 104));
  expect(text).toBe("Following text");
  expect((await listSourceImages(result.bytes, 0))[0]?.fingerprint).toBe(target.fingerprint);
});

test.skipIf(!native)("escapes inherited and local Form clips without widening a sibling invocation", async () => {
  const { bytes, run } = await fixture(form => {
    const inner = form(`q ${clip} ${photo} Q 0 1 0 rg 4 5 20 8 re f`, [0, 0, 65, 62]);
    const outer = form(inner, [0, 0, 70, 65]);
    // The outer page clip is popped before the sibling invocation and later marks.
    return `q 16 12 48 44 re W n ${form(`q ${clip} ${outer} Q`)} Q q 1 0 0 1 135 0 cm ${outer} Q`;
  });
  // The green paint lies outside the inherited clip but still shares it,
  // so an escape across that clip must be refused.
  const refused = await run({ rect: move });
  expect(refused.sourceImageOutcomes?.[0]).toMatchObject({ mode: "unsupported", reason: "unsupported-context" });
  expect(refused.bytes).toEqual(bytes);

  const exclusive = await fixture(form => {
    const inner = form(`q ${clip} ${photo} Q`, [0, 0, 65, 62]);
    const outer = form(inner, [0, 0, 70, 65]);
    return `q 16 12 48 44 re W n ${outer} Q q 1 0 0 1 135 0 cm ${outer} Q`;
  });
  const result = await exclusive.run({ rect: move });
  expect(result.sourceImageOutcomes?.[0]).toMatchObject({ mode: "applied" });
  const { at, text } = raster(result.bytes);
  expect(at(96, 83)).toEqual(colors[0]!);
  expect(at(115, 70)).toEqual(colors[3]!);
  expect(at(28, 27)).toEqual(white);
  const before = raster(exclusive.bytes);
  for (const [x, y] of [[164, 27], [185, 42], [163, 42], [185, 27], [14, 104]]) {
    expect(at(x!, y!)).toEqual(before.at(x!, y!));
  }
  expect(text).toBe(before.text);
});

test.skipIf(!native)("fits a rotated image and a requested crop inside transformed shared clips", async () => {
  const inside = await fixture(() =>
    `q 2 0 0 2 0 0 cm 7 7 25 20 re W n .5 0 0 .5 0 0 cm q 14 14 52 44 re W* n ${photo} 1 0 1 rg 14 14 5 5 re f Q Q`);
  const turned = await inside.run({ rect: { x: 30, y: 24, w: 20, h: 16 }, angle: 90 });
  expect(turned.sourceImageOutcomes?.[0]).toMatchObject({ mode: "applied" });
  expect(raster(turned.bytes).at(44, 37)).toEqual(colors[0]!);
  expect(raster(turned.bytes).at(16, 16)).toEqual([255, 0, 255]);

  const cropped = await fixture(() => `q 20 20 20 30 re W n ${photo} 1 0 1 rg 18 27 6 5 re f Q`);
  const result = await cropped.run({ rect: { x: 24, y: 20, w: 28, h: 30 }, crop: { x: 0, y: 0, w: .5, h: 1 } });
  expect(result.sourceImageOutcomes?.[0]).toMatchObject({ mode: "applied" });
  expect(raster(result.bytes).at(31, 43)).toEqual(colors[0]!);
  expect(raster(result.bytes).at(44, 43)).toEqual(white);

  // This crop intentionally retains only samples already visible in the source.
  const escaped = await fixture(() => `q 20 20 20 30 re W n ${photo} Q`);
  const resultOutside = await escaped.run({ rect: move, crop: { x: 0, y: 0, w: .5, h: 1 } });
  expect(resultOutside.sourceImageOutcomes?.[0]).toMatchObject({ mode: "applied" });
  expect(raster(resultOutside.bytes).at(95, 83)).toEqual(colors[0]!);
  expect(raster(resultOutside.bytes).at(115, 83)).toEqual(white);
});

test.each([
  { label: "shared rectangle", program: `q ${clip} ${photo} 1 0 1 rg 55 27 24 8 re f Q` },
  { label: "rectangle that also paints", program: `q 20 20 40 30 re W S ${photo} Q` },
  { label: "compound even-odd path", program: `q 20 20 40 30 re 30 30 5 5 re W* n ${photo} Q` },
  { label: "triangle", program: `q 20 20 m 60 20 l 40 50 l h W n ${photo} Q` },
  { label: "text clip then rectangle", program: `q BT /F1 36 Tf 20 20 Td 7 Tr (HI) Tj ET ${clip} ${photo} Q` },
  { label: "intentional crop", program: `q 20 20 20 30 re W n ${photo} Q` },
])("counts an intact refusal for $label", async ({ program }) => {
  const { bytes, run } = await fixture(() => program);
  for (const policy of ["review", "strict"] as const) {
    const result = await run({ rect: move }, policy);
    expect(result.sourceImageOutcomes).toEqual([
      expect.objectContaining({ overlayId: "photo", mode: "unsupported", reason: "unsupported-context" }),
    ]);
    expect(result.unexcisedEdits).toBe(1);
    expect(result.acceptance.status).toBe(policy === "strict" ? "refused" : "needs-review");
    expect(result.bytes).toEqual(bytes);
  }
});

const hiddenHalf = { x: .5, y: 0, w: .5, h: 1 };
const visibleHalf = { x: 0, y: 0, w: .5, h: 1 };
const halfClip = `q 20 20 20 30 re W n ${photo} Q`;

test.each([
  { label: "hidden half under an ancestor path clip", build: () => halfClip, crop: hiddenHalf },
  {
    label: "hidden half under an outer Form BBox",
    build: (form: (program: string, box?: number[]) => string) => form(form(photo), [0, 0, 40, 50]),
    crop: hiddenHalf,
  },
  { label: "explicit full crop under an ancestor path clip", build: () => halfClip, crop: { x: 0, y: 0, w: 1, h: 1 } },
  {
    label: "crop under an opaque even-odd path",
    build: () => `q 20 20 40 30 re 30 30 5 5 re W* n ${photo} Q`,
    crop: visibleHalf,
  },
])("counts an intact stationary crop refusal for $label", async ({ build, crop }) => {
  const { bytes, run } = await fixture(build);
  for (const policy of ["review", "strict"] as const) {
    const result = await run({ crop }, policy);
    expect(result.sourceImageOutcomes).toMatchObject([
      { overlayId: "photo", mode: "unsupported", reason: "unsupported-context" },
    ]);
    expect(result.unexcisedEdits).toBe(1);
    expect(result.acceptance.status).toBe(policy === "strict" ? "refused" : "needs-review");
    expect(result.bytes).toEqual(bytes);
  }
});

test.skipIf(!native)("paints a stationary visible-half crop inside both authored clips", async () => {
  const { bytes, run } = await fixture(form => {
    const shared = form(photo, [0, 0, 46, 50]);
    return `q 16 20 28 30 re W n ${shared} Q q 1 0 0 1 130 0 cm ${shared} Q`;
  });
  const result = await run({ crop: visibleHalf });
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "photo", mode: "applied" }]);
  expect(result.acceptance.status).toBe("accepted");
  const before = raster(bytes), after = raster(result.bytes);
  expect(before.at(42, 42)).toEqual(colors[1]!);
  expect(after.at(42, 42)).toEqual(white);
  expect(after.at(30, 42)).toEqual(colors[0]!);
  expect(after.at(30, 28)).toEqual(colors[2]!);
  expect(after.at(160, 42)).toEqual(colors[0]!);
  expect(after.at(173, 42)).toEqual(colors[1]!);
  expect(after.at(177, 42)).toEqual(white);
  expect(after.text).toBe(before.text);
});

test.skipIf(!native)("keeps a rotated placement that fits within a single convex path", async () => {
  const { run } = await fixture(() =>
    "q 20 20 m 80 20 l 50 65 l h W n q 20 0 0 12 32 25 cm /Photo Do Q Q");
  const result = await run({ rect: { x: 44, y: 26, w: 16, h: 12 }, angle: 90 });
  expect(result.sourceImageOutcomes).toEqual([{ overlayId: "photo", mode: "applied" }]);
  expect(raster(result.bytes).at(55, 37)).toEqual(colors[0]!);
  expect(raster(result.bytes).at(49, 28)).toEqual(colors[3]!);
});

test.skipIf(!native)("removes only a Form-local image clip and preserves nearby paints in both invocations", async () => {
  const { bytes, run } = await fixture(form => {
    const shared = form(`q ${clip} ${photo} Q 0 1 0 rg 88 63 25 10 re f`, [0, 0, 110, 92]);
    return `${shared} q 1 0 0 1 135 0 cm ${shared} Q`;
  });
  const result = await run({ rect: move });
  expect(result.sourceImageOutcomes?.[0]).toMatchObject({ mode: "applied" });
  const before = raster(bytes), after = raster(result.bytes);
  expect(after.at(96, 83)).toEqual(colors[0]!);
  expect(after.at(115, 70)).toEqual(colors[3]!);
  expect(after.at(28, 27)).toEqual(white);
  expect(after.at(100, 69)).toEqual([0, 255, 0]); // Later vector stays above the moved image.
  expect(after.at(111, 69)).toEqual(colors[3]!); // Expanding the Form did not expose more of the vector.
  for (const [x, y] of [[234, 69], [169, 28], [187, 44], [14, 104]]) {
    expect(after.at(x!, y!)).toEqual(before.at(x!, y!));
  }
  expect(after.text).toBe(before.text);
});
