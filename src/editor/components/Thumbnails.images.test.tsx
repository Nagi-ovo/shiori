import "../../test/setupDom";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VirtuosoMockContext } from "react-virtuoso";
import type { Overlay } from "../../pdf/model/types";
import { useAppStore, useEditorStore } from "../store/store";
import { Thumbnails } from "./Thumbnails";

const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Every 2D call any thumbnail canvas made, in order. */
let drawCalls: Array<{ name: string; args: unknown[] }> = [];
const canvasPrototype = Object.getPrototypeOf(document.createElement("canvas"));
const originalGetContext = canvasPrototype.getContext;

// A signature is an image overlay. The page rail is where a user checks
// that a signed page is the one they meant, so the tile has to show it.
describe("thumbnail tiles paint image overlays", () => {
  const editorSnapshot = useEditorStore.getState();
  const appSnapshot = useAppStore.getState();

  beforeEach(() => {
    drawCalls = [];
    canvasPrototype.getContext = function getContext(this: HTMLCanvasElement) {
      return recordingContext(this);
    };
    useAppStore.setState({
      prefs: { ...appSnapshot.prefs, preRenderThumbs: true },
    });
  });

  afterEach(() => {
    cleanup();
    canvasPrototype.getContext = originalGetContext;
    useEditorStore.setState(editorSnapshot, true);
    useAppStore.setState(appSnapshot, true);
  });

  test("draws a placed signature into its page's tile", async () => {
    seedBlankPage([signature()]);
    renderRail();

    await waitFor(() => {
      const drawn = drawCalls.filter((call) => call.name === "drawImage");
      expect(drawn.map((call) => (call.args[0] as HTMLImageElement).src)).toEqual([SIGNATURE]);
    });
  });

  // Compact export rejects on a bad image so the dialog keeps the vector
  // copy; a tile has no fallback, so it paints everything else instead.
  test("still paints the rest of the page when an image will not decode", async () => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = () => Promise.reject(new Error("bad image"));
    try {
      seedBlankPage([
        signature(),
        {
          type: "rect",
          id: "box",
          pageId: "p1",
          rect: { x: 100, y: 100, w: 80, h: 40 },
          color: "#d22",
          strokeWidth: 2,
          fill: null,
        },
      ]);
      renderRail();

      await waitFor(() => {
        expect(drawCalls.some((call) => call.name === "stroke")).toBe(true);
      });
      expect(drawCalls.some((call) => call.name === "drawImage")).toBe(false);
    } finally {
      HTMLImageElement.prototype.decode = decode;
    }
  });
});

function signature(): Overlay {
  return {
    type: "image",
    id: "signature-1",
    pageId: "p1",
    rect: { x: 40, y: 60, w: 120, h: 50 },
    dataUrl: SIGNATURE,
    mimeType: "image/png",
    source: "signature",
  };
}

function seedBlankPage(overlays: Overlay[]) {
  useEditorStore.setState({
    model: {
      pages: [
        { id: "p1", sourceIndex: -1, rotation: 0, widthPt: 612, heightPt: 792, blank: true },
      ],
      overlays,
    },
    // null: with an active page the rail asks Virtuoso to scroll to it, and
    // nothing renders in the mock viewport (menuEscape.test.tsx).
    activePageId: null,
  } as never);
}

function renderRail() {
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 260 }}>
      <Thumbnails doc={null as never} onInsertPdfPages={() => undefined} embedded />
    </VirtuosoMockContext.Provider>,
  );
}

function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { canvas };
  return new Proxy(state, {
    get: (target, key) =>
      key in target
        ? target[key]
        : key === "measureText"
          ? (text: string) => ({ width: text.length * 6 })
          : (...args: unknown[]) => {
              drawCalls.push({ name: String(key), args });
            },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}
