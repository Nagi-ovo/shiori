import "../../test/setupDom";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import i18n from "../../i18n";
import type { PageModel } from "../../pdf/model/types";
import { semanticClipboardTextForUnits } from "../textSelection/semanticText";
import { useEditorStore } from "../store/store";
import type { TextHighlightLayer as TextHighlightLayerComponent } from "./TextHighlightLayer";
import { ShioriTextLayer } from "../../pdf/render/textLayer";
import type { PdfEngine } from "../../pdf/engine/types";
import { fakePdfDocument, withFakePdfEngine } from "../../test/fakePdfEngine";

let TextHighlightLayer: typeof TextHighlightLayerComponent;
const initialStore = useEditorStore.getState();
// What the engine answers for page text; each test sets it.
let pageText: PdfEngine["pageText"] = async () => {
  throw new Error("pageText not set");
};
withFakePdfEngine({ pageText: (...args) => pageText(...args) });

beforeAll(async () => {
  const module = await import("./TextHighlightLayer");
  TextHighlightLayer = module.TextHighlightLayer;
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  useEditorStore.setState(initialStore, true);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("TextHighlightLayer cancellation", () => {
  test("does not fall back to raw glyphs for an empty semantic replacement", () => {
    expect(
      semanticClipboardTextForUnits([
        {
          kind: "text",
          divIndex: 0,
          text: "",
          rawText: "secret raw glyphs",
          hasEOL: false,
        },
      ]),
    ).toBe("");
  });

  test("a page text read still running at unmount ends without an error", async () => {
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readStarted = false;
    pageText = async (_doc, _index, options) => {
      readStarted = true;
      await stalled;
      options?.checkAbort?.();
      return { content: { items: [], styles: {}, lang: null }, glyphs: null, fontNames: new Map(), faceFamilies: new Map() };
    };
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const page: PageModel = { id: "page-1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 };
    try {
      const view = render(
        <TextHighlightLayer doc={fakePdfDocument()} page={page} pageIndex={0} scale={1} layerScale={1} />,
      );
      await waitFor(() => expect(readStarted).toBe(true));
      view.unmount();
      release();
      await stalled;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

});

describe("TextHighlightLayer zoom", () => {
  // pdf.js lays text out against a 2D canvas context; happy-dom has none.
  function fakeContext(canvas: HTMLCanvasElement) {
    return {
      canvas,
      font: "",
      measureText: (text: string) => ({
        width: text.length * 6,
        fontBoundingBoxAscent: 8,
        fontBoundingBoxDescent: 2,
      }),
    };
  }

  const textChunk = {
    lang: "en",
    styles: {
      f1: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false },
    },
    items: ["alpha", "beta", "gamma"].map((str, index) => ({
      str,
      dir: "ltr",
      transform: [12, 0, 0, 12, 72, 700 - index * 16],
      width: str.length * 6,
      height: 12,
      fontName: "f1",
      hasEOL: true,
    })),
  };

  test("a zoom commit re-lays the existing spans instead of rebuilding the page", async () => {
    let reads = 0;
    pageText = async () => {
      reads += 1;
      return { content: textChunk, glyphs: null, fontNames: new Map(), faceFamilies: new Map() };
    };
    const updates: number[] = [];
    const originalUpdate = ShioriTextLayer.prototype.update;
    const canvasProto = window.HTMLCanvasElement.prototype as unknown as Record<
      string,
      unknown
    >;
    const originalGetContext = Object.getOwnPropertyDescriptor(
      canvasProto,
      "getContext",
    );
    ShioriTextLayer.prototype.update = function (params) {
      updates.push(params.viewport.scale);
      return originalUpdate.call(this, params);
    };
    Object.defineProperty(canvasProto, "getContext", {
      configurable: true,
      value: function (this: HTMLCanvasElement) {
        return fakeContext(this);
      },
    });
    const page: PageModel = {
      id: "page-1",
      sourceIndex: 0,
      rotation: 0,
      widthPt: 612,
      heightPt: 792,
    };
    const doc = fakePdfDocument();
    try {
      const view = render(
        <TextHighlightLayer
          doc={doc}
          page={page}
          pageIndex={0}
          scale={1}
          layerScale={1}
        />,
      );
      const layer = () =>
        view.container.querySelector<HTMLElement>(".shioriTextLayer")!;
      await waitFor(() =>
        expect(layer().querySelectorAll("span").length).toBe(3),
      );
      expect(reads).toBe(1);
      const spansBefore = Array.from(layer().querySelectorAll("span"));

      // A pinch release commits 1.5×. The page did not change: its text and
      // glyph map are the same, only the spans' positions differ. Rebuilding all of it here — the old behaviour —
      // took several hundred ms per visible page, with no selectable text
      // and no links in the meantime.
      view.rerender(
        <TextHighlightLayer
          doc={doc}
          page={page}
          pageIndex={0}
          scale={1.5}
          layerScale={1.5}
        />,
      );
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      expect(updates).toEqual([1.5]);
      expect(reads).toBe(1);
      const spansAfter = Array.from(layer().querySelectorAll("span"));
      expect(spansAfter).toEqual(spansBefore);
      expect(layer().style.getPropertyValue("--total-scale-factor")).toBe("1.5");
    } finally {
      ShioriTextLayer.prototype.update = originalUpdate;
      if (originalGetContext) {
        Object.defineProperty(canvasProto, "getContext", originalGetContext);
      } else {
        delete canvasProto.getContext;
      }
    }
  });
});
