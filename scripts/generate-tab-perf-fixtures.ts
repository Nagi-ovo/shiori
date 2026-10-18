import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type Options = {
  count: number;
  pages: number;
  payloadKb: number;
  outDir: string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function options(): Options {
  return {
    count: positiveInteger(argumentValue("--count"), 50),
    pages: positiveInteger(argumentValue("--pages"), 24),
    payloadKb: positiveInteger(argumentValue("--payload-kb"), 512),
    outDir: resolve(
      argumentValue("--out") ?? "/tmp/shiori-tab-perf-fixtures",
    ),
  };
}

function deterministicPayload(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed || 1;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

async function generateFixture(
  fixtureIndex: number,
  pageCount: number,
  payloadKb: number,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fixtureLabel = String(fixtureIndex).padStart(2, "0");
  pdf.setTitle(`Shiori tab performance fixture ${fixtureLabel}`);
  pdf.setSubject("Generated locally for repeatable tab performance profiling");
  pdf.setProducer("Shiori tab performance fixture generator");

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Shiori tab performance fixture ${fixtureLabel}`, {
      x: 42,
      y: 744,
      size: 18,
      font,
      color: rgb(0.12, 0.12, 0.12),
    });
    for (let line = 0; line < 36; line += 1) {
      page.drawText(
        `fixture=${fixtureLabel} page=${pageIndex + 1} line=${line + 1} ` +
          `token=${fixtureIndex * 10_000 + pageIndex * 100 + line}`,
        {
          x: 42,
          y: 708 - line * 17,
          size: 9,
          font,
          color: rgb(0.25, 0.25, 0.25),
        },
      );
    }
  }

  await pdf.attach(
    deterministicPayload(payloadKb * 1024, fixtureIndex),
    `payload-${fixtureLabel}.bin`,
    {
      mimeType: "application/octet-stream",
      description: "Deterministic byte pressure for tab residency profiling",
      creationDate: new Date(0),
      modificationDate: new Date(0),
    },
  );
  return pdf.save({ useObjectStreams: true });
}

const settings = options();
await mkdir(settings.outDir, { recursive: true });

for (let fixtureIndex = 1; fixtureIndex <= settings.count; fixtureIndex += 1) {
  const bytes = await generateFixture(
    fixtureIndex,
    settings.pages,
    settings.payloadKb,
  );
  const outputPath = resolve(
    settings.outDir,
    `tab-perf-${String(fixtureIndex).padStart(2, "0")}.pdf`,
  );
  await writeFile(outputPath, bytes);
}

console.log(
  JSON.stringify({
    count: settings.count,
    pages: settings.pages,
    payloadKb: settings.payloadKb,
    outDir: settings.outDir,
  }),
);
