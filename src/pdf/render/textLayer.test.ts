import "../../test/setupDom";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PdfPageTextContent } from "../engine/text";
import { ShioriTextLayer, type TextLayerViewport } from "./textLayer";

// happy-dom has no 2D context. The layer only asks it to measure: a string is
// 10 px per character here, and there is no font ascent, so the style's own
// ascent (0.8) is used.
const canvasProto = window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
const originalGetContext = Object.getOwnPropertyDescriptor(canvasProto, "getContext");
beforeAll(() => {
  Object.defineProperty(canvasProto, "getContext", {
    configurable: true,
    value: () => ({ font: "", measureText: (s: string) => ({ width: s.length * 10 }) }),
  });
});
afterAll(() => {
  if (originalGetContext) Object.defineProperty(canvasProto, "getContext", originalGetContext);
  else delete canvasProto.getContext;
});

const item = (str: string, x: number, y: number, hasEOL = false) => ({
  str,
  dir: "ltr",
  transform: [12, 0, 0, 12, x, y],
  width: str.length * 10,
  height: 12,
  fontName: "f",
  hasEOL,
});

const content = (items: PdfPageTextContent["items"]): PdfPageTextContent => ({
  items,
  styles: { f: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } },
  lang: "en",
});

const letter = (rotation: number, scale = 1): TextLayerViewport => ({
  scale,
  rotation,
  pageX: 0,
  pageY: 0,
  pageWidth: 612,
  pageHeight: 792,
});

async function layerFor(items: PdfPageTextContent["items"], viewport: TextLayerViewport) {
  const container = document.createElement("div");
  const layer = new ShioriTextLayer({ content: content(items), container, viewport });
  await layer.render();
  return { container, layer };
}

describe("ShioriTextLayer", () => {
  test("places a span at its text's baseline less the font ascent", async () => {
    const { layer } = await layerFor([item("Hi", 72, 700)], letter(0));
    const span = layer.textDivs[0]!;
    // 12 pt at (72, 700): left 72 / 612, top (792 − 700 − 0.8 × 12) / 792.
    expect([span.style.left, span.style.top]).toEqual(["11.76%", "10.40%"]);
    expect(span.style.getPropertyValue("--font-height")).toBe("12.00px");
    expect(span.style.getPropertyValue("--rotate")).toBe("");
  });

  test("a page turned a quarter turn turns its spans with it", async () => {
    const { layer } = await layerFor([item("Hi", 72, 700)], letter(90));
    const span = layer.textDivs[0]!;
    // Turned clockwise the page is 792 × 612 and (x, y) lands at (y, x):
    // left (700 + 9.6) / 792, top 72 / 612, running downward.
    expect([span.style.left, span.style.top]).toEqual(["89.60%", "11.76%"]);
    expect(span.style.getPropertyValue("--rotate")).toBe("90deg");
  });

  test("keeps one text div per item, empty ones included, and breaks lines", async () => {
    const { container, layer } = await layerFor(
      [item("Hi", 72, 700, true), item("", 72, 686), item("Yo", 72, 672)],
      letter(0),
    );
    // The semantic copy model counts every text item, so the empty one keeps
    // its div even though it never reaches the page.
    expect(layer.textDivs).toHaveLength(3);
    expect([...container.children].map((node) => node.tagName)).toEqual(["SPAN", "BR", "SPAN"]);
  });

  test("marked content becomes nested spans around its text", async () => {
    const { container } = await layerFor(
      [
        { type: "beginMarkedContentProps", id: "mc1", tag: "P" },
        item("In", 72, 700),
        { type: "endMarkedContent" },
        item("Out", 72, 686),
      ],
      letter(0),
    );
    const marked = container.querySelector("span.markedContent")!;
    expect(marked.id).toBe("mc1");
    expect(marked.textContent).toBe("In");
    expect(container.lastElementChild?.textContent).toBe("Out");
  });

  test("a zoom re-measures each span's horizontal scale", async () => {
    const { layer } = await layerFor([item("Hi", 72, 700)], letter(0));
    const span = layer.textDivs[0]!;
    // Advance 20 over a measured 20 at scale 1.
    expect(span.style.getPropertyValue("--scale-x")).toBe("1");
    layer.update({ viewport: { scale: 2 } });
    expect(span.style.getPropertyValue("--scale-x")).toBe("2");
  });
});
