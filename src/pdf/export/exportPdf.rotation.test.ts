import { describe, expect, test } from "bun:test";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
} from "pdf-lib";
import { exportPdf, type ExportMode } from "./exportPdf";
import { tokenizeContentStream } from "./contentStreamEdit/tokenizer";
import type { DocumentModel, Overlay, PdfRect } from "../model/types";

// A rotated box overlay must come out of the export rotated the way the
// editor shows it: the same drawing, turned clockwise by `angle` about the
// box center (OverlayDom boxPlacement). The check replays the page content's
// graphics state and compares every drawn point against the unrotated
// export's points turned by hand.

const RECT: PdfRect = { x: 100, y: 100, w: 200, h: 50 };
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const overlays: Record<string, Overlay> = {
  rect: {
    id: "o",
    pageId: "p1",
    type: "rect",
    rect: RECT,
    color: "#d11a2a",
    strokeWidth: 2,
    fill: null,
  },
  stamp: {
    id: "o",
    pageId: "p1",
    type: "stamp",
    kind: "check",
    rect: RECT,
    color: "#1a1815",
    strokeWidth: 2,
  },
  image: {
    id: "o",
    pageId: "p1",
    type: "image",
    rect: RECT,
    dataUrl: PNG_1PX,
    mimeType: "image/png",
  },
  text: {
    id: "o",
    pageId: "p1",
    type: "text",
    rect: RECT,
    text: "Rotated",
    fontSize: 14,
    color: "#1a1815",
    bold: false,
    align: "left",
    fontFamily: "sans",
  },
  note: {
    id: "o",
    pageId: "p1",
    type: "note",
    rect: RECT,
    text: "Rotated note",
    color: "#ffd84d",
  },
};

const cases: Array<[string, ExportMode]> = [
  ...Object.keys(overlays).map((kind): [string, ExportMode] => [kind, "flatten"]),
  ["image", "annotations"],
];

describe("free rotation in export", () => {
  for (const [kind, mode] of cases) {
    test(`${kind} overlay turned 30° exports turned 30° (${mode})`, async () => {
      const upright = await drawnPoints(overlays[kind]!, 0, mode);
      const turned = await drawnPoints(overlays[kind]!, 30, mode);

      expect(upright.length).toBeGreaterThan(0);
      expect(turned.length).toBe(upright.length);
      const expected = upright.map((p) => rotateClockwise(p, 30, RECT));
      turned.forEach((point, index) => {
        expect(point.x).toBeCloseTo(expected[index]!.x, 3);
        expect(point.y).toBeCloseTo(expected[index]!.y, 3);
      });
    });
  }

});

async function drawnPoints(
  overlay: Overlay,
  angle: number,
  mode: ExportMode,
): Promise<Point[]> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const source = await doc.save();
  const model: DocumentModel = {
    pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }],
    overlays: [{ ...overlay, angle } as Overlay],
  };
  const { bytes } = await exportPdf(source, model, { mode });
  return replayPoints(await pageContent(bytes));
}

type Point = { x: number; y: number };
type Matrix = [number, number, number, number, number, number];

function rotateClockwise(p: Point, degrees: number, rect: PdfRect): Point {
  const rad = (degrees * Math.PI) / 180;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return {
    x: cx + dx * Math.cos(rad) + dy * Math.sin(rad),
    y: cy - dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

// Every point the page content places in user space: path vertices,
// rectangle corners, image unit-square corners, and each text matrix's
// origin and unit x step.
function replayPoints(content: Uint8Array): Point[] {
  const points: Point[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const apply = (m: Matrix, x: number, y: number): Point => ({
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  });
  for (const op of tokenizeContentStream(content)) {
    const n = op.operands.map((operand) =>
      operand.kind === "number" ? operand.value : NaN,
    );
    switch (op.operator) {
      case "q":
        stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case "cm":
        ctm = multiply(n as Matrix, ctm);
        break;
      case "m":
      case "l":
        points.push(apply(ctm, n[0]!, n[1]!));
        break;
      case "c":
        for (let i = 0; i < 6; i += 2) points.push(apply(ctm, n[i]!, n[i + 1]!));
        break;
      case "re": {
        const [x, y, w, h] = n as [number, number, number, number];
        for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
          points.push(apply(ctm, px!, py!));
        }
        break;
      }
      case "Do":
        for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          points.push(apply(ctm, px!, py!));
        }
        break;
      case "Tm": {
        const text = multiply(n as Matrix, ctm);
        points.push(apply(text, 0, 0), apply(text, 1, 0));
        break;
      }
    }
  }
  return points;
}

// m × base, in PDF's row-vector convention (cm premultiplies the CTM).
function multiply(m: Matrix, base: Matrix): Matrix {
  return [
    m[0] * base[0] + m[1] * base[2],
    m[0] * base[1] + m[1] * base[3],
    m[2] * base[0] + m[3] * base[2],
    m[2] * base[1] + m[3] * base[3],
    m[4] * base[0] + m[5] * base[2] + base[4],
    m[4] * base[1] + m[5] * base[3] + base[5],
  ];
}

async function pageContent(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const parts: Uint8Array[] = [];
  for (const ref of refs) {
    const stream = ref instanceof PDFRawStream ? ref : doc.context.lookup(ref!);
    if (!(stream instanceof PDFRawStream)) continue;
    parts.push(
      stream.dict.get(PDFName.of("Filter"))
        ? decodePDFRawStream(stream).decode()
        : stream.getContents(),
    );
    parts.push(new Uint8Array([0x0a]));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}
