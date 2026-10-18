import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { DocxViewer } from "./DocxViewer";
import { fitDocxZoomForWidth, measureDocxFitGeometry } from "./docxFit";
import { getLiveZoomIndicator } from "./liveZoomIndicator";

describe("DocxViewer viewport layout", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  test("bounds both host and renderer scroller to the document column", () => {
    const view = render(
      <DocxViewer bytes={new Uint8Array([1])} documentId="docx-layout" />,
    );
    const host = view.container.querySelector(
      ".shioriDocxViewer",
    ) as HTMLDivElement;
    const hostCss = host.querySelector("style")?.textContent ?? "";

    expect(host.style.flex).toBe("1 1 0px");
    expect(host.style.width).toBe("100%");
    expect(host.style.minWidth).toBe("0");
    expect(host.style.overflow).toBe("hidden");
    expect(hostCss).toContain("flex: 1 1 0");
    expect(hostCss).toContain("width: 100%");
    expect(hostCss).toContain("min-width: 0");
    expect(hostCss).toContain("overflow: auto");
  });

  test("fits the widest Word page inside a phone viewport", () => {
    const host = document.createElement("div");
    const scroller = document.createElement("div");
    scroller.className = "shioriDocxViewer__surface";
    Object.defineProperty(scroller, "clientWidth", {
      configurable: true,
      value: 320,
    });
    const portrait = document.createElement("div");
    portrait.className = "docx-page";
    const landscape = document.createElement("div");
    landscape.className = "docx-page";
    Object.defineProperty(portrait, "getBoundingClientRect", {
      configurable: true,
      value: () => new window.DOMRect(0, 0, 816, 1_056),
    });
    Object.defineProperty(landscape, "getBoundingClientRect", {
      configurable: true,
      value: () => new window.DOMRect(0, 0, 1_056, 816),
    });
    scroller.append(portrait, landscape);
    host.append(scroller);

    const measured = measureDocxFitGeometry(host, 1);

    expect(measured).toEqual({
      viewportWidth: 320,
      naturalPageWidth: 1_056,
    });
    expect(
      fitDocxZoomForWidth(
        measured!.viewportWidth,
        measured!.naturalPageWidth,
      ),
    ).toBeCloseTo(304 / 1_056);
  });

  test("fits an OOXML maximum-width page below the manual zoom floor", () => {
    // Word permits a 22-inch page (31,680 twips). At 96 CSS px/in this is
    // 2,112 px wide, so a 320 px phone needs roughly 14.4% to contain it.
    // Auto-fit must not inherit the 20% floor of the manual zoom control.
    expect(fitDocxZoomForWidth(320, 2_112)).toBeCloseTo(304 / 2_112);
  });

  test("clips painted tables and text to the white paper edge", () => {
    const view = render(
      <DocxViewer bytes={new Uint8Array([1])} documentId="docx-paper-edge" />,
    );
    const host = view.container.querySelector(
      ".shioriDocxViewer",
    ) as HTMLDivElement;
    const hostCss = host.querySelector("style")?.textContent ?? "";

    expect(hostCss).toMatch(
      /\.shioriDocxViewer \.docx-page \{ overflow: hidden; \}/,
    );
    expect(hostCss).toContain("-webkit-text-size-adjust: none");
    expect(hostCss).toContain("text-size-adjust: none");
  });

  test("offers Shiori zoom controls and reports the next zoom step", () => {
    const changes: number[] = [];
    const view = render(
      <DocxViewer
        bytes={new Uint8Array([1])}
        documentId="docx-zoom"
        zoom={1}
        onZoomChange={(zoom) => changes.push(zoom)}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
    expect(changes).toEqual([1.1]);
  });

  test("keeps zoom-out usable below the shared 35% document floor", () => {
    const changes: number[] = [];
    const view = render(
      <DocxViewer
        bytes={new Uint8Array([1])}
        documentId="docx-mobile-zoom"
        zoom={0.288}
        onZoomChange={(zoom) => changes.push(zoom)}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Zoom out" }));
    expect(changes).toEqual([0.25]);
  });

  test("previews a pinch in the compositor and commits one DOCX layout", async () => {
    const changes: number[] = [];
    let layoutZoom = 1;
    let deferLayout = true;
    const view = render(
      <DocxViewer
        bytes={new Uint8Array([1])}
        documentId="docx-trackpad-zoom"
        zoom={1}
        onZoomChange={(zoom) => {
          changes.push(zoom);
          if (!deferLayout) layoutZoom = zoom;
        }}
      />,
    );
    const host = view.container.querySelector(
      ".shioriDocxViewer",
    ) as HTMLDivElement;
    const scroller = document.createElement("div");
    scroller.className = "shioriDocxViewer__surface";
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () => new window.DOMRect(0, 0, 800, 600),
    });
    const pages = document.createElement("div");
    pages.className = "docx-pages";
    Object.defineProperty(pages, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        new window.DOMRect(100, 40, 600 * layoutZoom, 1_200 * layoutZoom),
    });
    const page = document.createElement("div");
    page.className = "docx-page";
    page.dataset.pageIndex = "0";
    Object.defineProperty(page, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        new window.DOMRect(100, 40, 600 * layoutZoom, 800 * layoutZoom),
    });
    pages.append(page);
    scroller.append(pages);
    // The lazy renderer may already have resolved in an earlier test. Put the
    // deterministic test scroller first so the host resolves this one.
    host.prepend(scroller);
    expect(host.querySelector(".shioriDocxViewer__surface")).toBe(scroller);

    const gestureStart = new window.Event("gesturestart", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(gestureStart, {
      clientX: { value: 400 },
      clientY: { value: 300 },
    });
    fireEvent(scroller, gestureStart);
    for (let frame = 1; frame <= 8; frame += 1) {
      const gestureChange = new window.Event("gesturechange", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperties(gestureChange, {
        clientX: { value: 400 },
        clientY: { value: 300 },
        scale: { value: 1 + frame * 0.025 },
      });
      await act(async () => {
        fireEvent(scroller, gestureChange);
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve()),
        );
      });
    }

    expect(changes).toHaveLength(0);
    expect(pages.style.transform).toContain("scale(1.2)");

    const gestureEnd = new window.Event("gestureend", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(scroller, gestureEnd);
    // Release commits after a short settle that folds in any momentum tail.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
    expect(changes).toEqual([1.2]);
    // The Word engine applies its relayout after the prop commit. Tearing down
    // the compositor preview here exposed one stale-layout frame, followed by
    // the engine's new layout — the end-of-gesture snap reported by readers.
    expect(pages.style.transform).not.toBe("");

    layoutZoom = 1.2;
    await act(async () => {
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(pages.style.transform).toBe("");
    deferLayout = false;

    const zoomWheel = new window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(zoomWheel, {
      clientX: { value: 400 },
      clientY: { value: 300 },
      ctrlKey: { value: true },
      deltaY: { value: -20 },
    });
    await act(async () => {
      fireEvent(scroller, zoomWheel);
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(changes).toHaveLength(1);
    expect(pages.style.transform).not.toBe("");

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
    expect(changes).toHaveLength(2);
    expect(changes[1]).toBeGreaterThan(changes[0]!);
    expect(pages.style.transform).toBe("");

    fireEvent.wheel(scroller, { deltaY: -20 });
    expect(changes).toHaveLength(2);

    // Two quick pinches: the second one starts while the first is still
    // settling (committed, engine relayout pending). The stale session must be
    // finished and re-snapshotted — reusing it computed preview transforms
    // against the old layout and made the document jump around.
    deferLayout = true;
    const overlapStart = new window.Event("gesturestart", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(overlapStart, {
      clientX: { value: 400 },
      clientY: { value: 300 },
    });
    fireEvent(scroller, overlapStart);
    const overlapChange = new window.Event("gesturechange", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(overlapChange, {
      clientX: { value: 400 },
      clientY: { value: 300 },
      scale: { value: 1.1 },
    });
    await act(async () => {
      fireEvent(scroller, overlapChange);
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    fireEvent(
      scroller,
      new window.Event("gestureend", { bubbles: true, cancelable: true }),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
    expect(changes).toHaveLength(3);
    expect(pages.style.transform).not.toBe("");

    const secondStart = new window.Event("gesturestart", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(secondStart, {
      clientX: { value: 400 },
      clientY: { value: 300 },
    });
    fireEvent(scroller, secondStart);
    expect(pages.style.transform).toBe("");
    const secondChange = new window.Event("gesturechange", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(secondChange, {
      clientX: { value: 400 },
      clientY: { value: 300 },
      scale: { value: 1.05 },
    });
    await act(async () => {
      fireEvent(scroller, secondChange);
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    // Fresh base zoom: the preview ratio is the new gesture's own scale, not
    // a value computed against the previous pinch's baseZoom.
    expect(pages.style.transform).toContain("scale(1.05");
    fireEvent(
      scroller,
      new window.Event("gestureend", { bubbles: true, cancelable: true }),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
    expect(changes).toHaveLength(4);

    // macOS WKWebView topology: gesturestart/gestureend arrive only as a
    // bracket and the actual pinch deltas come in as ctrl+wheel. The open
    // bracket must not block the wheel stream, and each wheel event must
    // paint its preview frame synchronously — WebKit can pause rAF for the
    // whole native gesture, which left an rAF-deferred preview frozen until
    // the fingers lifted.
    const bracketStart = new window.Event("gesturestart", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(bracketStart, {
      clientX: { value: 400 },
      clientY: { value: 300 },
    });
    fireEvent(scroller, bracketStart);
    const bracketWheel = new window.WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(bracketWheel, {
      clientX: { value: 400 },
      clientY: { value: 300 },
      ctrlKey: { value: true },
      deltaY: { value: -20 },
    });
    fireEvent(scroller, bracketWheel);
    expect(pages.style.transform).not.toBe("");
    expect(changes).toHaveLength(4);
    fireEvent(
      scroller,
      new window.Event("gestureend", { bubbles: true, cancelable: true }),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
    expect(changes).toHaveLength(5);
  });

  // Should a trackpad pinch's gestureend never arrive (focus leaves the
  // window mid-pinch, the webview drops it), the preview must still land as
  // a zoom instead of sitting transformed until the next gesture.
  test("a trackpad pinch whose gesture end never arrives still commits", async () => {
    const changes: number[] = [];
    const view = render(
      <DocxViewer
        bytes={new Uint8Array([1])}
        documentId="docx-lost-gesture-end"
        zoom={1}
        onZoomChange={(zoom) => changes.push(zoom)}
      />,
    );
    const host = view.container.querySelector(".shioriDocxViewer") as HTMLDivElement;
    const scroller = document.createElement("div");
    scroller.className = "shioriDocxViewer__surface";
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () => new window.DOMRect(0, 0, 800, 600),
    });
    const pages = document.createElement("div");
    pages.className = "docx-pages";
    Object.defineProperty(pages, "getBoundingClientRect", {
      configurable: true,
      value: () => new window.DOMRect(100, 40, 600, 1_200),
    });
    scroller.append(pages);
    host.prepend(scroller);
    const gesture = (type: string, scale?: number) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientX: { value: 400 },
        clientY: { value: 300 },
        ...(scale === undefined ? {} : { scale: { value: scale } }),
      });
      fireEvent(scroller, event);
    };

    await act(async () => {
      gesture("gesturestart");
      gesture("gesturechange", 1.2);
    });
    expect(pages.style.transform).toContain("scale(1.2)");
    expect(changes).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
    });
    expect(changes).toEqual([1.2]);
  });

  test("commits the pinch at the preview's final anchor, not the start anchor", async () => {
    const changes: number[] = [];
    let layoutZoom = 1;
    const view = render(
      <DocxViewer
        bytes={new Uint8Array([1])}
        documentId="docx-anchor-drift"
        zoom={1}
        onZoomChange={(zoom) => {
          changes.push(zoom);
          layoutZoom = zoom;
        }}
      />,
    );
    const host = view.container.querySelector(
      ".shioriDocxViewer",
    ) as HTMLDivElement;
    const scroller = document.createElement("div");
    scroller.className = "shioriDocxViewer__surface";
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () => new window.DOMRect(0, 0, 800, 600),
    });
    let scrollLeftValue = 0;
    let scrollTopValue = 0;
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => scrollLeftValue,
      set: (value: number) => {
        scrollLeftValue = value;
      },
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    const pages = document.createElement("div");
    pages.className = "docx-pages";
    Object.defineProperty(pages, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        new window.DOMRect(100, 40, 600 * layoutZoom, 1_200 * layoutZoom),
    });
    const page = document.createElement("div");
    page.className = "docx-page";
    page.dataset.pageIndex = "0";
    Object.defineProperty(page, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        new window.DOMRect(100, 40, 600 * layoutZoom, 800 * layoutZoom),
    });
    pages.append(page);
    scroller.append(pages);
    host.prepend(scroller);

    const gestureEvent = (
      type: string,
      clientX: number,
      clientY: number,
      scale?: number,
    ) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      const props: PropertyDescriptorMap = {
        clientX: { value: clientX },
        clientY: { value: clientY },
      };
      if (scale !== undefined) props.scale = { value: scale };
      Object.defineProperties(event, props);
      return event;
    };

    // Fingers land at (400,300) and drift to (460,300) while zooming to 1.2×.
    fireEvent(scroller, gestureEvent("gesturestart", 400, 300));
    await act(async () => {
      fireEvent(scroller, gestureEvent("gesturechange", 460, 300, 1.2));
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(getLiveZoomIndicator()).toBeCloseTo(1.2);
    fireEvent(scroller, gestureEvent("gestureend", 460, 300));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
    expect(changes).toEqual([1.2]);
    expect(getLiveZoomIndicator()).toBe(null);
    await act(async () => {
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );
    });
    expect(pages.style.transform).toBe("");

    // The preview's fixed point is the content under the FINAL anchor
    // (460,300): page-local (360,260) at base zoom. Pinning it back there at
    // ratio 1.2 needs scrollLeft = 100 + 360×1.2 − 460 = 72 and scrollTop =
    // 40 + 260×1.2 − 300 = 52. The stale start anchor (300,260) would leave
    // scrollLeft at 0 — the view visibly shifted by drift × ratio on release.
    expect(Math.round(scrollLeftValue)).toBe(72);
    expect(Math.round(scrollTopValue)).toBe(52);
  });

  // Android WebView fires Pointer Events and Touch Events for the same
  // fingers. The engine captures pointers on text and re-renders the captured
  // node, so a finger's pointerup can be delivered to a node that no longer
  // hangs under the host — a tracker that keeps its own finger list then
  // never forgets it.
  function androidFinger(
    target: HTMLElement,
    id: number,
    x: number,
    y: number,
  ) {
    const pointer = (type: string) =>
      new window.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: "touch",
        clientX: x,
        clientY: y,
      });
    const touches = (list: Array<[number, number, number]>) =>
      list.map(
        ([identifier, clientX, clientY]) =>
          new window.Touch({ identifier, target, clientX, clientY }),
      );
    return {
      down: (others: Array<[number, number, number]> = []) => {
        target.dispatchEvent(pointer("pointerdown"));
        target.dispatchEvent(
          new window.TouchEvent("touchstart", {
            bubbles: true,
            cancelable: true,
            touches: touches([...others, [id, x, y]]),
          }),
        );
      },
      move: (nx: number, ny: number, others: Array<[number, number, number]> = []) => {
        x = nx;
        y = ny;
        target.dispatchEvent(pointer("pointermove"));
        target.dispatchEvent(
          new window.TouchEvent("touchmove", {
            bubbles: true,
            cancelable: true,
            touches: touches([...others, [id, x, y]]),
          }),
        );
      },
      up: (others: Array<[number, number, number]> = []) => {
        target.dispatchEvent(pointer("pointerup"));
        target.dispatchEvent(
          new window.TouchEvent("touchend", {
            bubbles: true,
            cancelable: true,
            touches: touches(others),
          }),
        );
      },
    };
  }

  function mountAndroidSurface(host: HTMLDivElement, layoutZoom: () => number) {
    const scroller = document.createElement("div");
    scroller.className = "shioriDocxViewer__surface";
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () => new window.DOMRect(0, 0, 412, 800),
    });
    const pages = document.createElement("div");
    pages.className = "docx-pages";
    Object.defineProperty(pages, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        new window.DOMRect(8, 0, 396 * layoutZoom(), 4_000 * layoutZoom()),
    });
    const page = document.createElement("div");
    page.className = "docx-page";
    page.dataset.pageIndex = "0";
    Object.defineProperty(page, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        new window.DOMRect(8, 0, 396 * layoutZoom(), 560 * layoutZoom()),
    });
    const text = document.createElement("span");
    text.textContent = "Paragraph 1.";
    page.append(text);
    pages.append(page);
    scroller.append(pages);
    host.prepend(scroller);
    return { scroller, pages, page, text };
  }

  test("a finger whose release never arrived does not turn the next swipe into a pinch", async () => {
    const changes: number[] = [];
    const view = render(
      <DocxViewer
        bytes={new Uint8Array([1])}
        documentId="docx-android-stranded-finger"
        zoom={0.5}
        onZoomChange={(zoom) => changes.push(zoom)}
      />,
    );
    const host = view.container.querySelector(
      ".shioriDocxViewer",
    ) as HTMLDivElement;
    const { pages, text } = mountAndroidSurface(host, () => 0.5);

    // Finger 1 lands on text; the engine captures it and the release is lost.
    androidFinger(text, 7, 200, 850).down();

    // Later: an ordinary one-finger swipe up to read further down the page.
    const swipe = androidFinger(pages, 8, 200, 700);
    swipe.down();
    for (let y = 650; y >= 300; y -= 50) swipe.move(200, y);
    swipe.up();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });

    // Before the fix every such swipe zoomed the document a little further
    // (the distance to the phantom finger grew): 0.5 → 2.75× here, and the
    // next swipe again, until the text was unreadable.
    expect(changes).toEqual([]);
    expect(pages.style.transform).toBe("");
    expect(getLiveZoomIndicator()).toBe(null);
  });

  test("a two-finger pinch on Android previews on the compositor and commits once", async () => {
    const changes: number[] = [];
    let layoutZoom = 0.5;
    const view = render(
      <DocxViewer
        bytes={new Uint8Array([1])}
        documentId="docx-android-pinch"
        zoom={0.5}
        onZoomChange={(zoom) => {
          changes.push(zoom);
          layoutZoom = zoom;
        }}
      />,
    );
    const host = view.container.querySelector(
      ".shioriDocxViewer",
    ) as HTMLDivElement;
    const { pages, page } = mountAndroidSurface(host, () => layoutZoom);

    const first = androidFinger(page, 11, 150, 400);
    const second = androidFinger(page, 12, 250, 400);
    first.down();
    second.down([[11, 150, 400]]);
    // Spread from 100px apart to 200px apart: ratio 2 → 0.5 × 2 = 1.0.
    second.move(300, 400, [[11, 150, 400]]);
    first.move(100, 400, [[12, 300, 400]]);
    expect(pages.style.transform).toContain("scale(2)");
    expect(getLiveZoomIndicator()).toBeCloseTo(1);
    expect(changes).toEqual([]);

    await act(async () => {
      first.up([[12, 300, 400]]);
      second.up();
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(changes).toEqual([1]);
  });
});
