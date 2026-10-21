import { describe, expect, test } from "bun:test";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { exportPdf } from "./exportPdf";
import { importFileAnnotations } from "../import/annotations";
import type { Overlay, PageModel, PdfRect } from "../model/types";

// A box turned in the editor (angle, degrees clockwise about its centre)
// stays turned in the editable export, which has no rotation of its own for
// a Square or FreeText: the appearance carries the turn in its /Matrix and
// /Rect covers the turned box. A quarter turn also writes the FreeText
// /Rotate Acrobat uses for text. Reopening the file gives the turn back.

const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 };
const RECT: PdfRect = { x: 100, y: 100, w: 200, h: 50 };

const shapes: Record<string, Overlay> = {
  rect: { type: "rect", id: "o", pageId: "p1", rect: RECT, color: "#d11a2a", strokeWidth: 2, fill: "#ffff00" },
  text: {
    type: "text", id: "o", pageId: "p1", rect: RECT, text: "Turned", fontSize: 14,
    color: "#1a1815", bold: false, align: "left", fontFamily: "sans",
  },
  stamp: { type: "stamp", id: "o", pageId: "p1", kind: "check", rect: RECT, color: "#1a1815", strokeWidth: 2 },
  note: { type: "note", id: "o", pageId: "p1", rect: RECT, text: "Turned", color: "#f4d674" },
};

async function exported(overlay: Overlay): Promise<{ dict: PDFDict; bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const { bytes } = await exportPdf(await doc.save(), { pages: [page], overlays: [overlay] });
  const loaded = await PDFDocument.load(bytes);
  const annots = loaded.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
  return { dict: loaded.context.lookup(annots.get(0), PDFDict), bytes };
}

const numbers = (array: PDFArray | undefined) =>
  array ? Array.from({ length: array.size() }, (_, i) => array.lookup(i, PDFNumber).asNumber()) : undefined;

function appearanceMatrix(dict: PDFDict): number[] | undefined {
  const normal = dict.lookupMaybe(PDFName.of("AP"), PDFDict)?.lookup(PDFName.of("N"));
  return normal instanceof PDFRawStream ? numbers(normal.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray)) : undefined;
}

function close(actual: number[] | undefined, expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual!.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 4));
}

const rad = (deg: number) => (deg * Math.PI) / 180;

describe("a turned box in the editable export", () => {
  test.each(["rect", "text", "stamp"])("a %s at 30° carries the turn in its appearance", async (kind) => {
    const { dict } = await exported({ ...shapes[kind]!, angle: 30 } as Overlay);
    const [cos, sin] = [Math.cos(rad(30)), Math.sin(rad(30))];
    // Clockwise on screen is the negative angle in PDF's y-up space.
    close(appearanceMatrix(dict)?.slice(0, 4), [cos, -sin, sin, cos]);
    const w = RECT.w * cos + RECT.h * sin;
    const h = RECT.w * sin + RECT.h * cos;
    close(numbers(dict.lookupMaybe(PDFName.of("Rect"), PDFArray)), [200 - w / 2, 125 - h / 2, 200 + w / 2, 125 + h / 2]);
    expect(dict.get(PDFName.of("Rotate"))).toBeUndefined();
  });

  // Its appearance replaces the one a viewer would draw from /IC and /CA.
  test("a turned rectangle's appearance paints its fill at its opacity", async () => {
    const { dict } = await exported({ ...shapes.rect!, angle: 30, opacity: 0.3 } as Overlay);
    const normal = dict.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"), PDFRawStream);
    const ops = new TextDecoder().decode(decodePDFRawStream(normal).decode());
    expect(ops).toContain("1 1 0 rg");
    expect(ops).toContain("/GS0 gs");
    const gs = normal.dict.lookup(PDFName.of("Resources"), PDFDict).lookup(PDFName.of("ExtGState"), PDFDict).lookup(PDFName.of("GS0"), PDFDict);
    expect(gs.get(PDFName.of("ca"))?.toString()).toBe("0.3");
  });

  test("a text box at a quarter turn also writes /Rotate", async () => {
    const { dict } = await exported({ ...shapes.text!, angle: 90 } as Overlay);
    expect(dict.get(PDFName.of("Rotate"))?.toString()).toBe("270");
    close(numbers(dict.lookupMaybe(PDFName.of("Rect"), PDFArray)), [175, 25, 225, 225]);
  });

  test.each(["rect", "text", "stamp"])("an unturned %s is written as before", async (kind) => {
    const { dict } = await exported(shapes[kind]!);
    expect(numbers(dict.lookupMaybe(PDFName.of("Rect"), PDFArray))).toEqual([100, 100, 300, 150]);
    expect(dict.get(PDFName.of("Rotate"))).toBeUndefined();
    if (kind === "rect") expect(dict.get(PDFName.of("AP"))).toBeUndefined();
    else expect(appearanceMatrix(dict)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("a turned box reopened", () => {
  test.each([
    ["rect", 30], ["text", 30], ["text", 90], ["stamp", 45], ["rect", 200], ["note", 30],
  ] as const)("a %s at %d° comes back turned", async (kind, angle) => {
    const { bytes } = await exported({ ...shapes[kind]!, angle } as Overlay);
    const [back] = await importFileAnnotations([page], bytes, 1);
    expect(back).toMatchObject({ type: kind });
    const turned = back as Overlay & { rect: PdfRect; angle?: number };
    expect(turned.angle).toBeCloseTo(angle, 4);
    close([turned.rect.x, turned.rect.y, turned.rect.w, turned.rect.h], [RECT.x, RECT.y, RECT.w, RECT.h]);
  });
});

// A sticky note exports as an icon at its box's top-left corner, which no
// viewer turns; its box and angle ride in Shiori's /Shio dictionary.
describe("a turned sticky note", () => {
  test("moved in another reader since, comes back where it was put, unturned", async () => {
    const { bytes } = await exported({ ...shapes.note!, angle: 30 } as Overlay);
    const doc = await PDFDocument.load(bytes);
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    doc.context.lookup(annots.get(0), PDFDict).set(PDFName.of("Rect"), doc.context.obj([400, 600, 420, 620]));
    const [back] = await importFileAnnotations([page], await doc.save(), 1);
    expect(back).toMatchObject({ type: "note" });
    const note = back as Overlay & { rect: PdfRect; angle?: number };
    expect(note.angle).toBeUndefined();
    expect([note.rect.x, note.rect.y + note.rect.h]).toEqual([400, 620]);
  });
});
