import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { DocxViewer } from "./DocxViewer";

/*
 * Ways a phone pinch on a Word page loses the reader's place (one test each):
 * - the fingers' midpoint wanders while they spread, as it always does on a
 *   phone: the release must keep under the fingers what the last preview
 *   frame showed there, not jump by drift × ratio;
 * - the first finger began a scroll before the second landed, so Android
 *   keeps panning the scroller under the pinch (those touchmoves are not
 *   cancelable): the preview must not pan the page twice — including when
 *   that scroll lands after the last touchmove and the fingers then pause;
 * - the fingers end at their starting spread (or pinch outward at the
 *   ceiling), so no zoom commits: the pan the preview showed must still land;
 * - the pinch overshoots the Word engine's 5× ceiling, which the engine
 *   refuses rather than clamps: the committed zoom must be one it paints.
 */

type Surface = {
  scroller: HTMLElement;
  pages: HTMLElement;
  page: HTMLElement;
  scroll: { left: number; top: number };
};

/** A fake engine surface whose page box follows layout zoom and scroll. */
function mountSurface(host: HTMLElement, layoutZoom: () => number): Surface {
  const scroll = { left: 0, top: 0 };
  const scroller = document.createElement("div");
  scroller.className = "shioriDocxViewer__surface";
  Object.defineProperties(scroller, {
    getBoundingClientRect: {
      configurable: true,
      value: () => new window.DOMRect(0, 0, 412, 800),
    },
    scrollLeft: {
      configurable: true,
      get: () => scroll.left,
      set: (value: number) => {
        scroll.left = value;
      },
    },
    scrollTop: {
      configurable: true,
      get: () => scroll.top,
      set: (value: number) => {
        scroll.top = value;
      },
    },
  });
  // Untransformed layout box: 792 × height CSS px at 100%, origin (8, 16).
  const box = (height: number) => () =>
    new window.DOMRect(
      8 - scroll.left,
      16 - scroll.top,
      792 * layoutZoom(),
      height * layoutZoom(),
    );
  const pages = document.createElement("div");
  pages.className = "docx-pages";
  Object.defineProperty(pages, "getBoundingClientRect", {
    configurable: true,
    value: box(5_000),
  });
  const page = document.createElement("div");
  page.className = "docx-page";
  page.dataset.pageIndex = "0";
  Object.defineProperty(page, "getBoundingClientRect", {
    configurable: true,
    value: box(1_120),
  });
  pages.append(page);
  scroller.append(pages);
  // The lazy renderer may have resolved in an earlier test; go first.
  host.prepend(scroller);
  return { scroller, pages, page, scroll };
}

/**
 * The document point (CSS px at 100%) painted at client (x, y): the layout
 * box, then the preview transform on top of it when one is showing.
 */
function contentAt(surface: Surface, layoutZoom: number, x: number, y: number) {
  const rect = surface.page.getBoundingClientRect();
  const transform = surface.pages.style.transform;
  let tx = 0;
  let ty = 0;
  let scale = 1;
  if (transform) {
    const match =
      /translate3d\((\S+)px, (\S+)px, 0\) scale\((\S+)\)/.exec(transform);
    if (!match) throw new Error(`unexpected preview transform: ${transform}`);
    tx = Number(match[1]);
    ty = Number(match[2]);
    scale = Number(match[3]);
  }
  return {
    x: (x - rect.left - tx) / scale / layoutZoom,
    y: (y - rect.top - ty) / scale / layoutZoom,
  };
}

function touches(
  target: HTMLElement,
  type: string,
  fingers: Array<[number, number, number]>,
) {
  target.dispatchEvent(
    new window.TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: fingers.map(
        ([identifier, clientX, clientY]) =>
          new window.Touch({ identifier, target, clientX, clientY }),
      ),
    }),
  );
}

const frame = () =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

/**
 * A reader pinches a document that is already on screen. Once the lazy
 * renderer is ready, the viewer restores the saved scroll a frame later
 * (`onReady`); a fake surface attached before that would have its scroll
 * reset mid-pinch, which no reader can do.
 */
async function rendererReady(container: HTMLElement) {
  for (
    let attempt = 0;
    attempt < 200 && !container.querySelector(".shioriDocxViewer__surface");
    attempt += 1
  ) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  }
  await act(async () => {
    await frame();
    await frame();
  });
}

async function renderViewer(documentId: string, zoom: number) {
  const changes: number[] = [];
  let layoutZoom = zoom;
  const view = render(
    <DocxViewer
      bytes={new Uint8Array([1])}
      documentId={documentId}
      zoom={zoom}
      onZoomChange={(next) => {
        changes.push(next);
        layoutZoom = next;
      }}
    />,
  );
  await rendererReady(view.container);
  const host = view.container.querySelector(".shioriDocxViewer") as HTMLElement;
  const surface = mountSurface(host, () => layoutZoom);
  return { view, changes, surface, layoutZoom: () => layoutZoom };
}

async function release(page: HTMLElement, last: [number, number, number]) {
  await act(async () => {
    touches(page, "touchend", [last]);
    touches(page, "touchend", []);
    await frame();
    await frame();
  });
}

describe("DocxViewer pinch anchoring on a phone", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  test("a pinch whose midpoint wanders lands with the same words under the fingers", async () => {
    const { changes, surface, layoutZoom } = await renderViewer("docx-pinch-drift", 0.5);
    const { page } = surface;

    // Fingers 100 px apart around (200, 200), then spread to 200 px apart
    // while their midpoint wanders to (230, 260).
    touches(page, "touchstart", [[1, 150, 200]]);
    touches(page, "touchstart", [[1, 150, 200], [2, 250, 200]]);
    const start = contentAt(surface, layoutZoom(), 200, 200);
    touches(page, "touchmove", [[1, 130, 200], [2, 330, 200]]);
    touches(page, "touchmove", [[1, 130, 260], [2, 330, 260]]);
    const shown = contentAt(surface, layoutZoom(), 230, 260);
    // The preview carries the words first pinched along with the fingers.
    expect(shown.x).toBeCloseTo(start.x, 1);
    expect(shown.y).toBeCloseTo(start.y, 1);

    await release(page, [2, 330, 260]);
    expect(changes).toEqual([1]);
    expect(surface.pages.style.transform).toBe("");
    const landed = contentAt(surface, layoutZoom(), 230, 260);
    expect(landed.x).toBeCloseTo(shown.x, 0);
    expect(landed.y).toBeCloseTo(shown.y, 0);
  });

  test("a scroll the browser keeps panning under the pinch does not move the page twice", async () => {
    const { changes, surface, layoutZoom } = await renderViewer("docx-pinch-pan", 0.5);
    const { page } = surface;

    touches(page, "touchstart", [[1, 150, 200]]);
    touches(page, "touchstart", [[1, 150, 200], [2, 250, 200]]);
    touches(page, "touchmove", [[1, 130, 200], [2, 330, 200]]);
    const shown = contentAt(surface, layoutZoom(), 230, 200);

    // The first finger had started a scroll; Android applies it AFTER the
    // touchmove handler ran, and the fingers then hold still: no further
    // zoom input arrives, only the scroll event.
    surface.scroll.left += 20;
    surface.scroll.top += 60;
    surface.scroller.dispatchEvent(new window.Event("scroll"));
    const paused = contentAt(surface, layoutZoom(), 230, 200);
    expect(paused.x).toBeCloseTo(shown.x, 1);
    expect(paused.y).toBeCloseTo(shown.y, 1);

    // Scroll applied before the next move is compensated as well.
    surface.scroll.top += 30;
    touches(page, "touchmove", [[1, 130, 200], [2, 330, 200]]);
    const afterPan = contentAt(surface, layoutZoom(), 230, 200);
    expect(afterPan.x).toBeCloseTo(shown.x, 1);
    expect(afterPan.y).toBeCloseTo(shown.y, 1);

    await release(page, [2, 330, 200]);
    expect(changes).toEqual([1]);
    const landed = contentAt(surface, layoutZoom(), 230, 200);
    expect(landed.x).toBeCloseTo(shown.x, 0);
    expect(landed.y).toBeCloseTo(shown.y, 0);
  });

  test("a pinch that ends at its starting spread keeps the pan it showed", async () => {
    const { changes, surface, layoutZoom } = await renderViewer("docx-pinch-pan-only", 0.5);
    const { page } = surface;

    // Spread, then come back to the starting 100 px while the midpoint moves
    // from (200, 200) up and left to (170, 150).
    touches(page, "touchstart", [[1, 150, 200]]);
    touches(page, "touchstart", [[1, 150, 200], [2, 250, 200]]);
    const start = contentAt(surface, layoutZoom(), 200, 200);
    touches(page, "touchmove", [[1, 100, 200], [2, 300, 200]]);
    touches(page, "touchmove", [[1, 120, 150], [2, 220, 150]]);
    const shown = contentAt(surface, layoutZoom(), 170, 150);
    expect(shown.x).toBeCloseTo(start.x, 1);
    expect(shown.y).toBeCloseTo(start.y, 1);

    await release(page, [2, 220, 150]);
    expect(changes).toEqual([]);
    expect(surface.pages.style.transform).toBe("");
    const landed = contentAt(surface, layoutZoom(), 170, 150);
    expect(landed.x).toBeCloseTo(shown.x, 0);
    expect(landed.y).toBeCloseTo(shown.y, 0);
  });

  test("pinching outward at the ceiling keeps the pan it showed", async () => {
    const { changes, surface, layoutZoom } = await renderViewer("docx-pinch-ceiling-pan", 5);
    const { page } = surface;

    touches(page, "touchstart", [[1, 150, 200]]);
    touches(page, "touchstart", [[1, 150, 200], [2, 250, 200]]);
    touches(page, "touchmove", [[1, 70, 150], [2, 270, 150]]);
    const shown = contentAt(surface, layoutZoom(), 170, 150);

    await release(page, [2, 270, 150]);
    expect(changes).toEqual([]);
    const landed = contentAt(surface, layoutZoom(), 170, 150);
    expect(landed.x).toBeCloseTo(shown.x, 0);
    expect(landed.y).toBeCloseTo(shown.y, 0);
  });

  test("a pinch past the engine's ceiling commits the largest zoom it paints", async () => {
    const { changes, surface } = await renderViewer("docx-pinch-ceiling", 4);
    const { page } = surface;

    touches(page, "touchstart", [[1, 150, 200]]);
    touches(page, "touchstart", [[1, 150, 200], [2, 250, 200]]);
    touches(page, "touchmove", [[1, 100, 200], [2, 300, 200]]);
    expect(surface.pages.style.transform).toContain("scale(1.25)");

    await release(page, [2, 300, 200]);
    expect(changes).toEqual([5]);
  });

  test("a stored zoom above the ceiling shows and steps from what is painted", () => {
    const changes: number[] = [];
    const view = render(
      <DocxViewer
        bytes={new Uint8Array([1])}
        documentId="docx-stored-8x"
        zoom={8}
        onZoomChange={(zoom) => changes.push(zoom)}
      />,
    );

    expect(view.getByText("500%")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
    expect(changes).toEqual([5]);
  });
});
