import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AFRelationship,
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import { main } from "../src/main";
import {
  annotateDocument,
  type AnnotateCliErrorCode,
} from "../src/annotate";

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

async function annotationNames(path: string): Promise<string[]> {
  const loaded = await PDFDocument.load(await readFile(path));
  const annots = loaded.getPage(0).node.Annots();
  if (!annots) return [];
  const names: string[] = [];
  for (let index = 0; index < annots.size(); index += 1) {
    const dict = annots.lookupMaybe(index, PDFDict);
    const name = dict?.lookupMaybe(PDFName.of("NM"), PDFString)?.decodeText();
    if (name) names.push(name);
  }
  return names;
}

async function addThirdPartyHighlight(path: string): Promise<void> {
  const loaded = await PDFDocument.load(await readFile(path));
  const page = loaded.getPage(0);
  const context = loaded.context;
  const annotation = context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Highlight"),
    Rect: context.obj([72, 640, 180, 654]),
    QuadPoints: context.obj([72, 654, 180, 654, 72, 640, 180, 640]),
    C: context.obj([1, 0.8, 0]),
    NM: PDFString.of("third-party-highlight"),
  });
  page.node.addAnnot(context.register(annotation));
  await writeFile(path, await loaded.save());
}

async function makeEncryptionMarkedPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const encryption = doc.context.obj({ Filter: PDFName.of("Standard"), V: 1 });
  doc.context.trailerInfo.Encrypt = doc.context.register(encryption);
  await writeFile(path, await doc.save({ useObjectStreams: false }));
}

async function writeSpec(path: string, annotations: unknown[]): Promise<void> {
  await writeFile(path, JSON.stringify({ annotations }));
}

async function tempOutputArtifacts(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes(".shiori-tmp-"));
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

async function makeRotatedOffsetCropPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.setCropBox(50, 100, 300, 400);
  page.setRotation(degrees(90));
  await writeFile(path, await doc.save());
}

function testAnnotateError(
  code: AnnotateCliErrorCode,
  message: string,
  detail?: string,
): Error {
  return Object.assign(new Error(message), { name: "CliError", code, detail });
}

describe("shiori annotate", () => {
  test("writes coordinate highlights and notes into a PDF", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "welcome.pdf");
      const spec = join(dir, "spec.json");
      const output = join(dir, "annotated.pdf");
      await copyFile("site/public/welcome.pdf", input);
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "highlight",
              page: 1,
              rects: [{ x: 72, y: 640, w: 200, h: 14 }],
            },
            {
              type: "note",
              page: 1,
              at: { x: 300, y: 600 },
              text: "Review this line",
            },
          ],
        }),
      );

      const before = await annotationCount(input);
      const { stdout, warnings, errors } = await captureCli([
        "annotate",
        input,
        "--spec",
        spec,
        "-o",
        output,
      ]);

      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(stdout).toBe(`2 annotations written to ${resolve(output)}`);
      await expect(annotationCount(output)).resolves.toBe(before + 2);
    });
  });

  test("rejects page numbers outside the PDF", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "spec.json");
      const output = join(dir, "annotated.pdf");
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "highlight",
              page: 99,
              rects: [{ x: 72, y: 640, w: 200, h: 14 }],
            },
          ],
        }),
      );

      await expectCliError(
        main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
        "ERR_SPEC_INVALID",
        "page is out of range",
      );
    });
  });

  test("wraps missing spec files as file-unavailable errors", async () => {
    await withTempDir(async (dir) => {
      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          join(dir, "missing.json"),
          "-o",
          join(dir, "annotated.pdf"),
        ]),
        "ERR_FILE_UNAVAILABLE",
        "Could not read file",
      );
    });
  });

  test("writes annotations within a rotated offset CropBox", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "rotated-crop.pdf");
      const spec = join(dir, "spec.json");
      const output = join(dir, "annotated.pdf");
      await makeRotatedOffsetCropPdf(input);
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "highlight",
              page: 1,
              rects: [{ x: 10, y: 20, w: 50, h: 12 }],
            },
          ],
        }),
      );

      const { stdout, warnings, errors } = await captureCli([
        "annotate",
        input,
        "--spec",
        spec,
        "-o",
        output,
        "--agent",
      ]);

      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        command: "annotate",
        data: { written: 1, lostChars: 0 },
      });
      await expect(annotationCount(output)).resolves.toBe(1);
      const rect = await firstAnnotationRect(output);
      expect(rect).toHaveLength(4);
      expect(rect[0]!).toBeGreaterThanOrEqual(50);
      expect(rect[1]!).toBeGreaterThanOrEqual(100);
      expect(rect[2]!).toBeLessThanOrEqual(350);
      expect(rect[3]!).toBeLessThanOrEqual(500);
    });
  });

  test("rejects quote-only anchoring without geometry", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "spec.json");
      const output = join(dir, "annotated.pdf");
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "highlight",
              page: 1,
              quote: "Welcome",
              color: "#8bd17c",
            },
          ],
        }),
      );

      await expectCliError(
        main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
        "ERR_SPEC_INVALID",
        "rects are required; quote-only anchoring is not supported",
      );
    });
  });

  test("rejects malformed specs", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "spec.json");
      const output = join(dir, "annotated.pdf");
      await writeFile(spec, "{ nope");

      await expectCliError(
        main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
        "ERR_SPEC_INVALID",
        "Spec JSON is malformed",
      );
    });
  });

  test("accepts the versioned schema across all nine round-trippable types", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "all-types.json");
      const output = join(dir, "all-types.pdf");
      await writeFile(
        spec,
        JSON.stringify({
          schema: "shiori.annotations/v1",
          annotations: [
            {
              type: "highlight",
              page: 1,
              rects: [{ x: 72, y: 650, w: 80, h: 12 }],
              color: "#f6c744",
              opacity: 0.35,
              quote: "informational only",
            },
            {
              type: "underline",
              page: 1,
              rects: [{ x: 72, y: 620, w: 80, h: 12 }],
              color: "#2c6eaa",
              opacity: 0.7,
            },
            {
              type: "strikethrough",
              page: 1,
              rects: [{ x: 72, y: 590, w: 80, h: 12 }],
              color: "#b13a2e",
              opacity: 0.8,
            },
            {
              type: "note",
              page: 1,
              at: { x: 180, y: 560 },
              text: "note",
              color: "#f6c744",
            },
            {
              type: "callout",
              page: 1,
              targetRects: [{ x: 72, y: 545, w: 80, h: 12 }],
              rect: { x: 180, y: 535, w: 144, h: 54 },
              text: "callout overlay",
              fontSize: 12,
              color: "#b13a2e",
              align: "left",
            },
            {
              type: "ink",
              page: 1,
              paths: [[{ x: 72, y: 520 }, { x: 110, y: 535 }]],
              color: "#1a1815",
              width: 2,
            },
            {
              type: "rect",
              page: 1,
              rect: { x: 140, y: 500, w: 70, h: 35 },
              color: "#2c6eaa",
              strokeWidth: 2,
              fill: null,
            },
            {
              type: "stamp",
              page: 1,
              kind: "check",
              rect: { x: 230, y: 500, w: 32, h: 32 },
              color: "#2e7d32",
              strokeWidth: 2,
            },
            {
              type: "text",
              page: 1,
              rect: { x: 72, y: 450, w: 150, h: 28 },
              text: "text overlay",
              fontSize: 12,
              color: "#1a1815",
              bold: false,
              italic: false,
              align: "left",
              fontFamily: "sans",
            },
          ],
        }),
      );

      const { stdout } = await captureCli([
        "annotate",
        "site/public/welcome.pdf",
        "--spec",
        spec,
        "-o",
        output,
        "--agent",
      ]);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        data: { written: 9 },
      });
      const loaded = await PDFDocument.load(await readFile(output));
      expect(loaded.getPageCount()).toBe(3);
    });
  });

  test("rejects unknown schemas, typos, and non-round-trippable fields", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "invalid.json");
      const output = join(dir, "out.pdf");
      await writeFile(
        spec,
        JSON.stringify({ schema: "shiori.annotations/v2", annotations: [] }),
      );
      await expectCliError(
        main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
        "ERR_SPEC_INVALID",
        "Unsupported annotation schema",
      );

      await writeFile(
        spec,
        JSON.stringify({
          schema: "shiori.annotations/v1",
          annotations: [
            {
              type: "note",
              page: 1,
              at: { x: 10, y: 10 },
              text: "typo",
              color: "#f6c744",
              colour: "#f6c744",
            },
          ],
        }),
      );
      await expectCliError(
        main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
        "ERR_SPEC_INVALID",
        "colour is not supported",
      );

      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "note",
              page: 1,
              at: { x: 10, y: 10 },
              text: "legacy typo",
              colour: "#f6c744",
            },
          ],
          typo: true,
        }),
      );
      await expectCliError(
        main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
        "ERR_SPEC_INVALID",
        "spec.typo is not supported",
      );
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            {
              type: "note",
              page: 1,
              at: { x: 10, y: 10 },
              text: "legacy typo",
              colour: "#f6c744",
            },
          ],
        }),
      );
      await expectCliError(
        main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
        "ERR_SPEC_INVALID",
        "colour is not supported",
      );

      for (const type of ["contentText", "image"] as const) {
        for (const versioned of [false, true]) {
          await writeFile(
            spec,
            JSON.stringify({
              ...(versioned ? { schema: "shiori.annotations/v1" } : {}),
              annotations: [{ type, page: 1 }],
            }),
          );
          await expectCliError(
            main([
              "annotate",
              "site/public/welcome.pdf",
              "--spec",
              spec,
              "-o",
              output,
            ]),
            "ERR_SPEC_INVALID",
            `type is unknown: ${type}`,
          );
        }
      }

      for (const field of ["locked", "angle"] as const) {
        for (const versioned of [false, true]) {
          await writeFile(
            spec,
            JSON.stringify({
              ...(versioned ? { schema: "shiori.annotations/v1" } : {}),
              annotations: [
                {
                  type: "note",
                  page: 1,
                  at: { x: 10, y: 10 },
                  text: "unsupported",
                  color: "#f6c744",
                  [field]: field === "locked" ? true : 5,
                },
              ],
            }),
          );
          await expectCliError(
            main([
              "annotate",
              "site/public/welcome.pdf",
              "--spec",
              spec,
              "-o",
              output,
            ]),
            "ERR_SPEC_INVALID",
            `${field} is not supported`,
          );
        }
      }

      await writeFile(
        spec,
        JSON.stringify({
          schema: "shiori.annotations/v1",
          annotations: [
            {
              type: "rect",
              page: 1,
              rect: { x: 10, y: 10, w: 10, h: 10, width: 10 },
              color: "#2c6eaa",
              strokeWidth: 2,
              fill: null,
            },
          ],
        }),
      );
      await expectCliError(
        main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
        "ERR_SPEC_INVALID",
        "rect.width is not supported",
      );

      const nonPortableCases: Array<{ annotation: unknown; message: string }> = [
        {
          annotation: {
            type: "highlight",
            page: 1,
            rects: [{ x: 10, y: 10, w: 10, h: 10 }],
            color: "#f6c744",
            opacity: 0.5,
          },
          message: "opacity cannot exceed 0.45",
        },
        {
          annotation: {
            type: "rect",
            page: 1,
            rect: { x: 10, y: 10, w: 10, h: 10 },
            color: "#2c6eaa",
            strokeWidth: 2,
            fill: "#ffffff",
          },
          message: "filled rectangles are not portable",
        },
        {
          annotation: {
            type: "ink",
            page: 1,
            paths: [[{ x: 10, y: 10 }, { x: 20, y: 20 }]],
            color: "#1a1815",
            width: 2,
            source: "signature",
          },
          message: "source is not supported",
        },
        {
          annotation: {
            type: "text",
            page: 1,
            rect: { x: 10, y: 10, w: 100, h: 20 },
            text: "text",
            fontSize: 12,
            color: "#1a1815",
            bold: false,
            align: "left",
            fontFamily: "notoSansSc",
          },
          message: "not a supported font family",
        },
        {
          annotation: {
            type: "text",
            page: 1,
            rect: { x: 10, y: 10, w: 100, h: 20 },
            text: "你好",
            fontSize: 12,
            color: "#1a1815",
            bold: true,
            align: "left",
            fontFamily: "sans",
          },
          message: "non-ASCII text supports only regular sans",
        },
      ];
      for (const { annotation, message } of nonPortableCases) {
        await writeFile(
          spec,
          JSON.stringify({
            schema: "shiori.annotations/v1",
            annotations: [annotation],
          }),
        );
        await expectCliError(
          main(["annotate", "site/public/welcome.pdf", "--spec", spec, "-o", output]),
          "ERR_SPEC_INVALID",
          message,
        );
      }
    });
  });

  test("loads packaged CJK fonts for text and callout overlays", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "cjk.json");
      const output = join(dir, "cjk.pdf");
      await writeFile(
        spec,
        JSON.stringify({
          schema: "shiori.annotations/v1",
          annotations: [
            {
              type: "text",
              page: 1,
              rect: { x: 72, y: 420, w: 180, h: 32 },
              text: "你好，栞",
              fontSize: 14,
              color: "#1a1815",
              bold: false,
              align: "left",
              fontFamily: "sans",
            },
            {
              type: "callout",
              page: 1,
              targetRects: [{ x: 72, y: 380, w: 100, h: 14 }],
              rect: { x: 210, y: 360, w: 160, h: 54 },
              text: "日本語の注釈",
              fontSize: 12,
              color: "#b13a2e",
              align: "left",
            },
          ],
        }),
      );
      const { stdout } = await captureCli([
        "annotate",
        "site/public/welcome.pdf",
        "--spec",
        spec,
        "-o",
        output,
        "--agent",
      ]);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        data: { written: 2, lostChars: 0 },
      });
      await expect(PDFDocument.load(await readFile(output))).resolves.toBeDefined();
    });
  });

  test("loads both CJK fallback fonts for one mixed-script callout", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "mixed-callout.json");
      const output = join(dir, "mixed-callout.pdf");
      await writeFile(
        spec,
        JSON.stringify({
          schema: "shiori.annotations/v1",
          annotations: [{
            type: "callout",
            page: 1,
            targetRects: [{ x: 72, y: 380, w: 100, h: 14 }],
            rect: { x: 210, y: 360, w: 160, h: 54 },
            text: "かな简𠮷",
            fontSize: 12,
            color: "#b13a2e",
            align: "left",
          }],
        }),
      );

      const { stdout } = await captureCli([
        "annotate",
        "site/public/welcome.pdf",
        "--spec",
        spec,
        "-o",
        output,
        "--agent",
      ]);

      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        data: { written: 1, lostChars: 0 },
      });
    });
  });

  test("dry-run exposes the final free-text rectangle", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "text.json");
      const output = join(dir, "text.pdf");
      const rect = { x: 72, y: 420, w: 180, h: 32 };
      await writeFile(
        spec,
        JSON.stringify({
          annotations: [
            { type: "text", page: 1, rect, text: "Direct page text" },
          ],
        }),
      );
      const dryRun = await captureCli([
        "annotate",
        "site/public/welcome.pdf",
        "--spec",
        spec,
        "-o",
        output,
        "--dry-run",
        "--agent",
      ]);
      expect(JSON.parse(dryRun.stdout)).toMatchObject({
        data: {
          placements: [{ index: 0, type: "text", page: 1, rect }],
        },
      });
    });
  });

  test("preserves third-party and Shiori annotations while appending", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "input.pdf");
      const firstSpec = join(dir, "first.json");
      const firstOutput = join(dir, "first.pdf");
      const secondSpec = join(dir, "second.json");
      const secondOutput = join(dir, "second.pdf");
      await copyFile("site/public/welcome.pdf", input);
      await addThirdPartyHighlight(input);
      await writeSpec(firstSpec, [
        {
          type: "highlight",
          page: 1,
          rects: [{ x: 200, y: 600, w: 80, h: 12 }],
        },
      ]);
      await writeSpec(secondSpec, [
        {
          type: "highlight",
          page: 1,
          rects: [{ x: 300, y: 500, w: 80, h: 12 }],
        },
      ]);

      await main(["annotate", input, "--spec", firstSpec, "-o", firstOutput]);
      await main([
        "annotate",
        firstOutput,
        "--spec",
        secondSpec,
        "-o",
        secondOutput,
      ]);

      await expect(annotationCount(secondOutput)).resolves.toBe(3);
      const names = await annotationNames(secondOutput);
      expect(names).toContain("third-party-highlight");
      const shioriNames = names.filter((name) => name.startsWith("shiori:cli-"));
      expect(shioriNames).toHaveLength(2);
      expect(new Set(shioriNames).size).toBe(2);
      for (const name of shioriNames) {
        expect(name).toMatch(/^shiori:cli-highlight-[0-9a-f]{16}-1$/);
      }
      expect(await tempOutputArtifacts(dir)).toEqual([]);
    });
  });

  test("preserves embedded source data while appending annotations", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "input.pdf");
      const spec = join(dir, "spec.json");
      const output = join(dir, "output.pdf");
      const source = await PDFDocument.create();
      const page = source.addPage([612, 792]);
      // The CLI intentionally clamps an out-of-bounds CropBox to the MediaBox
      // when it builds PageModels. That makes pagesMatchSource false even
      // though annotate still covers the complete document, so this fixture
      // proves the caller passes its full-document intent explicitly.
      page.setCropBox(-50, -100, 700, 900);
      await source.attach(new TextEncoder().encode("cli-attachment"), "data.txt", {
        mimeType: "text/plain",
        description: "CLI source data",
        afRelationship: AFRelationship.Data,
      });
      await writeFile(input, await source.save({ useObjectStreams: false }));
      await writeSpec(spec, [
        {
          type: "highlight",
          page: 1,
          rects: [{ x: 72, y: 640, w: 120, h: 14 }],
        },
      ]);

      await main(["annotate", input, "--spec", spec, "-o", output]);

      const loaded = await PDFDocument.load(await readFile(output));
      const names = loaded.catalog.lookup(PDFName.of("Names"), PDFDict);
      const embedded = names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
      const entries = embedded.lookup(PDFName.of("Names"), PDFArray);
      expect(entries.lookup(0, PDFHexString).decodeText()).toBe("data.txt");
      const fileSpec = entries.lookup(1, PDFDict);
      expect(fileSpec.lookup(PDFName.of("Desc"), PDFHexString).decodeText()).toBe(
        "CLI source data",
      );
      expect(String(fileSpec.get(PDFName.of("AFRelationship")))).toBe("/Data");
      const ef = fileSpec.lookup(PDFName.of("EF"), PDFDict);
      const stream = ef.lookup(PDFName.of("F"), PDFRawStream);
      expect(new TextDecoder().decode(decodePDFRawStream(stream).decode())).toBe(
        "cli-attachment",
      );
      expect(await tempOutputArtifacts(dir)).toEqual([]);
    });
  });

  test("fails closed for encrypted PDFs and rejects misleading passwords", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "encrypted.pdf");
      const spec = join(dir, "spec.json");
      const output = join(dir, "output.pdf");
      await makeEncryptionMarkedPdf(input);
      await writeSpec(spec, []);

      await expectCliError(
        main([
          "annotate",
          input,
          "--spec",
          spec,
          "-o",
          output,
        ]),
        "ERR_PDF_PASSWORD",
        "Encrypted PDFs cannot be modified safely",
      );
      await expectCliError(
        main([
          "annotate",
          input,
          "--spec",
          spec,
          "-o",
          output,
          "--password",
          "secret",
        ]),
        "ERR_USAGE",
        "encrypted PDFs are read-only",
      );
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await tempOutputArtifacts(dir)).toEqual([]);
    });
  });

  test("fails closed when portable replacement would lose native metadata", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "spec.json");
      const output = join(dir, "output.pdf");
      await writeSpec(spec, []);
      await copyFile("site/public/welcome.pdf", output);
      const before = await readFile(output);

      const dryRun = await captureCli([
        "annotate",
        "site/public/welcome.pdf",
        "--spec",
        spec,
        "-o",
        output,
        "--dry-run",
        "--agent",
      ]);
      expect(JSON.parse(dryRun.stdout)).toMatchObject({
        data: {
          output: {
            exists: true,
            replacementSupported: false,
            requiresNewPath: true,
          },
        },
      });

      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          spec,
          "-o",
          output,
        ]),
        "ERR_OUTPUT_EXISTS",
        "Output already exists",
      );
      expect(await readFile(output)).toEqual(before);

      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          spec,
          "-o",
          output,
          "--force",
        ]),
        "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
        "cannot safely replace",
      );
      expect(await readFile(output)).toEqual(before);
      expect(await tempOutputArtifacts(dir)).toEqual([]);
    });
  });

  test("requires in-place confirmation for aliases of the input", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "input.pdf");
      const hardLink = join(dir, "hard-link.pdf");
      const spec = join(dir, "spec.json");
      await copyFile("site/public/welcome.pdf", input);
      await link(input, hardLink);
      await writeSpec(spec, []);

      await expectCliError(
        main([
          "annotate",
          input,
          "--spec",
          spec,
          "-o",
          hardLink,
          "--force",
        ]),
        "ERR_CONFIRMATION_REQUIRED",
        "without --in-place",
      );

      await expectCliError(
        main([
          "annotate",
          input,
          "--spec",
          spec,
          "-o",
          input,
          "--in-place",
        ]),
        "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
        "cannot safely replace",
      );
      expect(await tempOutputArtifacts(dir)).toEqual([]);
    });
  });

  test("exports the exact source snapshot used to resolve anchors", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "input.pdf");
      const output = join(dir, "output.pdf");
      const first = await PDFDocument.create();
      first.addPage([200, 200]);
      const firstBytes = new Uint8Array(await first.save());
      await writeFile(input, firstBytes);

      // Simulate another process replacing the path after anchor resolution.
      const replacement = await PDFDocument.create();
      replacement.addPage([400, 400]);
      await writeFile(input, await replacement.save());

      const specValue = {
        annotations: [
          {
            type: "highlight",
            page: 1,
            rects: [{ x: 10, y: 10, w: 20, h: 10 }],
          },
        ],
      };
      await annotateDocument(
        { path: input, sizeBytes: firstBytes.byteLength },
        {
          outputPath: output,
          preloadedSourceBytes: firstBytes,
          preloadedSpec: {
            value: specValue,
            bytes: new TextEncoder().encode(JSON.stringify(specValue)),
          },
        },
        testAnnotateError,
      );

      const exported = await PDFDocument.load(await readFile(output));
      expect(exported.getPage(0).getWidth()).toBe(200);
      const currentPath = await PDFDocument.load(await readFile(input));
      expect(currentPath.getPage(0).getWidth()).toBe(400);
    });
  });

  test("--highlight flag contract: repeatable, capped, exclusive with --spec", async () => {
    await withTempDir(async (dir) => {
      const input = join(dir, "welcome.pdf");
      const spec = join(dir, "spec.json");
      await copyFile("site/public/welcome.pdf", input);
      await writeSpec(spec, []);

      await expectCliError(
        main([
          "annotate",
          input,
          "--highlight",
          "a",
          "--spec",
          spec,
          "-o",
          join(dir, "o.pdf"),
        ]),
        "ERR_USAGE",
        "mutually exclusive",
      );

      const tooMany = Array.from({ length: 17 }, (_, i) => [
        "--highlight",
        `quote ${i}`,
      ]).flat();
      await expectCliError(
        main(["annotate", input, ...tooMany, "-o", join(dir, "o.pdf")]),
        "ERR_USAGE",
        "at most 16",
      );

      await expectCliError(
        main(["app", "context", "--highlight", "a"]),
        "ERR_USAGE",
        "Unknown option for app context: --highlight",
      );
    });
  });

  test("applies the umask to new outputs and leaves refused replacements untouched", async () => {
    if (process.platform === "win32") return;
    await withTempDir(async (dir) => {
      const input = join(dir, "input.pdf");
      const output = join(dir, "annotated.pdf");
      const spec = join(dir, "spec.json");
      await copyFile("site/public/welcome.pdf", input);
      await writeSpec(spec, []);
      await chmod(input, 0o644);

      await main(["annotate", input, "--spec", spec, "-o", output]);
      const umask = process.umask();
      expect((await stat(output)).mode & 0o777).toBe(0o666 & ~umask);

      await chmod(output, 0o444);
      const original = await readFile(output);
      await expectCliError(
        main([
          "annotate",
          input,
          "--spec",
          spec,
          "-o",
          output,
          "--force",
        ]),
        "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
        "cannot safely replace",
      );
      expect((await stat(output)).mode & 0o777).toBe(0o444);
      expect(await readFile(output)).toEqual(original);
    });
  });

  test("rejects spec collisions and symlink outputs by default", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "spec.json");
      const victim = join(dir, "victim.pdf");
      const outputLink = join(dir, "output.pdf");
      await writeSpec(spec, []);

      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          spec,
          "-o",
          spec,
          "--force",
        ]),
        "ERR_OUTPUT_CONFLICT",
        "must not replace the annotation spec",
      );

      if (process.platform !== "win32") {
        await copyFile("site/public/welcome.pdf", victim);
        await symlink(victim, outputLink);
        await expectCliError(
          main([
            "annotate",
            "site/public/welcome.pdf",
            "--spec",
            spec,
            "-o",
            outputLink,
          ]),
          "ERR_OUTPUT_EXISTS",
          "Output already exists",
        );
      }
    });
  });

  test("cleans the same-directory temporary file after rename failure", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "spec.json");
      const outputDirectory = join(dir, "cannot-replace");
      await writeSpec(spec, []);
      await mkdir(outputDirectory);

      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          spec,
          "-o",
          outputDirectory,
          "--force",
        ]),
        "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
        "cannot safely replace",
      );
      expect(await tempOutputArtifacts(dir)).toEqual([]);
    });
  });

  test("supports dry-run planning and SHA-256 preconditions", async () => {
    await withTempDir(async (dir) => {
      const spec = join(dir, "spec.json");
      const output = join(dir, "output.pdf");
      await writeSpec(spec, [
        {
          type: "note",
          page: 1,
          at: { x: 100, y: 100 },
          text: "plan only",
        },
      ]);
      const inputBytes = await readFile("site/public/welcome.pdf");
      const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
      const { stdout } = await captureCli([
        "annotate",
        "site/public/welcome.pdf",
        "--spec",
        spec,
        "-o",
        output,
        "--base-sha256",
        inputSha256,
        "--dry-run",
        "--agent",
      ]);
      const parsed = JSON.parse(stdout) as {
        data?: {
          dryRun?: boolean;
          input?: { sha256?: string };
          patch?: { ops?: number };
        };
      };
      expect(parsed.data?.dryRun).toBe(true);
      expect(parsed.data?.input?.sha256).toBe(inputSha256);
      expect(parsed.data?.patch?.ops).toBe(1);
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });

      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          spec,
          "-o",
          output,
          "--base-sha256",
          "0".repeat(64),
        ]),
        "ERR_BASE_HASH_MISMATCH",
        "does not match",
      );
    });
  });

  test("bounds annotation count and note text before building overlays", async () => {
    await withTempDir(async (dir) => {
      const output = join(dir, "output.pdf");
      const tooMany = join(dir, "too-many.json");
      await writeSpec(
        tooMany,
        Array.from({ length: 5_001 }, () => ({
          type: "highlight",
          page: 1,
          rects: [{ x: 1, y: 1, w: 1, h: 1 }],
        })),
      );
      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          tooMany,
          "-o",
          output,
        ]),
        "ERR_SPEC_INVALID",
        "more than 5000 annotations",
      );

      const longNote = join(dir, "long-note.json");
      await writeSpec(longNote, [
        {
          type: "note",
          page: 1,
          at: { x: 1, y: 1 },
          text: "x".repeat(32_769),
        },
      ]);
      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          longNote,
          "-o",
          output,
        ]),
        "ERR_SPEC_INVALID",
        "exceeds 32768 characters",
      );

      const totalText = join(dir, "total-text.json");
      await writeSpec(
        totalText,
        Array.from({ length: 9 }, (_, index) => ({
          type: "note",
          page: 1,
          at: { x: index, y: index },
          text: "x".repeat(32_768),
        })),
      );
      await expectCliError(
        main([
          "annotate",
          "site/public/welcome.pdf",
          "--spec",
          totalText,
          "-o",
          output,
        ]),
        "ERR_SPEC_INVALID",
        "exceeds 262144 total characters",
      );
    });
  });
});
