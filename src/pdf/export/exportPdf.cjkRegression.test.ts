import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { PDFDocument, rgb } from "pdf-lib";
import { cjkJpExportFontUrl, cjkScExportFontUrl } from "./fontAssets";
import { exportPdf, type ExportMode } from "./exportPdf";
import { cjkRegressionSampleCategories } from "./__fixtures__/cjkRegressionSamples";
import type { DocumentModel, TextOverlay } from "../model/types";

const artifactDir = new URL("../../../test-artifacts/cjk-regression/", import.meta.url);

describe("CJK export regression artifacts", () => {
  test("writes structurally valid flatten and annotations PDFs", async () => {
    const original = await makeVisuallyBlankPdf();
    const model = sampleModel();

    await mkdir(artifactDir, { recursive: true });

    for (const mode of ["flatten", "annotations"] satisfies ExportMode[]) {
      const { bytes } = await exportPdf(original, model, {
        mode,
        quality: "standard",
        unicodeFontUrl: cjkScExportFontUrl,
        unicodeJpFontUrl: cjkJpExportFontUrl,
        requireUnicodeFont: true,
      });

      await writeFile(new URL(`${mode}.pdf`, artifactDir), bytes);

      expect(bytes.byteLength).toBeGreaterThan(original.byteLength);
      expect(bytes.byteLength).toBeLessThan(original.byteLength * 10);
      expectNoNonFinitePdfTokens(bytes, `${mode}.pdf`);

      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1);
    }
  });

  test("rejects non-finite tokens inside compressed PDF streams", () => {
    const stream = deflateSync(Buffer.from("q\n1 0 0 1 NaN 0 cm\nQ\n"));
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n1 0 obj\n<</Length "),
      Buffer.from(String(stream.length)),
      Buffer.from("/Filter/FlateDecode>>\nstream\n"),
      stream,
      Buffer.from("\nendstream\nendobj\n%%EOF\n"),
    ]);

    expect(() => expectNoNonFinitePdfTokens(pdf, "bad.pdf")).toThrow(
      /non-finite PDF tokens/,
    );
  });
});

async function makeVisuallyBlankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let seed = 0x5eed;
  const nextNoise = (): string => {
    let out = "";
    for (let i = 0; i < 128; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out += chars[seed % chars.length];
    }
    return out;
  };

  // White text keeps the fixture visually blank while making the baseline
  // source realistic enough for a meaningful "not 10x larger" assertion.
  for (let row = 0; row < 240; row += 1) {
    page.drawText(nextNoise(), {
      x: 24,
      y: 24 + row * 12,
      size: 8,
      color: rgb(1, 1, 1),
    });
  }

  return doc.save();
}

function sampleModel(): DocumentModel {
  const overlays: TextOverlay[] = cjkRegressionSampleCategories.map((sample, index) => ({
    id: sample.key,
    type: "text",
    pageId: "p1",
    rect: { x: 36, y: 704 - index * 92, w: 540, h: 72 },
    text: sample.text,
    fontSize: sample.key === "kana" || sample.key === "commonHanzi" ? 7 : 12,
    color: "#1a1815",
    bold: false,
    align: "left",
    fontFamily: "sans",
  }));

  return {
    pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
    overlays,
  };
}

const nonFiniteTokenPattern =
  /(?<![A-Za-z0-9_.+-])(?:NaN|[+-]?Infinity)(?![A-Za-z0-9_.+-])/g;

function expectNoNonFinitePdfTokens(bytes: Uint8Array, label: string): void {
  const findings = collectNonFinitePdfTokens(Buffer.from(bytes));
  if (findings.length > 0) {
    throw new Error(
      `${label} contains non-finite PDF tokens:\n${findings.join("\n")}`,
    );
  }
}

function collectNonFinitePdfTokens(bytes: Buffer): string[] {
  const findings = [
    ...scanPdfTokenText(bytes.toString("latin1"), "raw PDF bytes"),
  ];

  for (const stream of pdfStreams(bytes)) {
    const inflated = inflateStream(stream.bytes);
    if (!inflated) continue;
    findings.push(
      ...scanPdfTokenText(
        inflated.toString("latin1"),
        `inflated stream at byte ${stream.offset}`,
      ),
    );
  }

  return findings;
}

function* pdfStreams(bytes: Buffer): Generator<{ offset: number; bytes: Buffer }> {
  const streamMarker = Buffer.from("stream");
  const endStreamMarker = Buffer.from("endstream");
  let searchFrom = 0;

  while (searchFrom < bytes.length) {
    const streamOffset = bytes.indexOf(streamMarker, searchFrom);
    if (streamOffset < 0) return;

    let dataStart = streamOffset + streamMarker.length;
    if (bytes[dataStart] === 0x0d && bytes[dataStart + 1] === 0x0a) {
      dataStart += 2;
    } else if (bytes[dataStart] === 0x0a || bytes[dataStart] === 0x0d) {
      dataStart += 1;
    }

    const dataEnd = bytes.indexOf(endStreamMarker, dataStart);
    if (dataEnd < 0) return;

    yield {
      offset: streamOffset,
      bytes: bytes.subarray(dataStart, dataEnd),
    };
    searchFrom = dataEnd + endStreamMarker.length;
  }
}

function inflateStream(bytes: Buffer): Buffer | null {
  for (const candidate of [bytes, trimTrailingPdfEol(bytes)]) {
    try {
      return inflateSync(candidate);
    } catch {
      // Not every PDF stream is Flate-compressed.
    }
  }
  return null;
}

function trimTrailingPdfEol(bytes: Buffer): Buffer {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) {
    end -= 1;
  }
  return bytes.subarray(0, end);
}

function scanPdfTokenText(text: string, source: string): string[] {
  const findings: string[] = [];
  for (const match of text.matchAll(nonFiniteTokenPattern)) {
    const index = match.index ?? 0;
    const start = Math.max(0, index - 40);
    const end = Math.min(text.length, index + match[0].length + 40);
    const context = text.slice(start, end).replace(/\s+/g, " ").trim();
    findings.push(`${source}: ${match[0]} near "${context}"`);
  }
  return findings;
}
