import "../../test/setupDom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { useEditorStore } from "../store/store";
import { PageIndicatorPill, PAGE_PILL_LINGER_MS } from "./PageIndicatorPill";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function installMobileViewport(): () => void {
  const previous = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: previous,
    });
  };
}

function setPages(count: number, activeIndex: number): void {
  const pages = Array.from({ length: count }, (_, index) => ({
    id: `page-${index}`,
  }));
  useEditorStore.setState({
    model: { pages, overlays: [] },
    activePageId: pages[activeIndex]?.id ?? null,
  } as never);
}

/** The document's own scroller, the only one the pill listens to. */
function mountScroller(attribute: string): HTMLElement {
  const scroller = document.createElement("div");
  scroller.setAttribute(attribute, "");
  document.body.appendChild(scroller);
  return scroller;
}

function pill(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-shiori-page-pill]");
}

let restoreViewport: () => void = () => undefined;

beforeEach(() => {
  restoreViewport = installMobileViewport();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  restoreViewport();
});

describe("PageIndicatorPill", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  test("stays out of the way until the document is scrolled", async () => {
    setPages(11, 3);
    const scroller = mountScroller("data-shiori-pdf-scroller");
    const { container } = render(<PageIndicatorPill />);

    expect(pill(container)).not.toBeNull();
    expect(pill(container)!.style.opacity).toBe("0");

    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(pill(container)!.style.opacity).toBe("1");
    expect(pill(container)!.textContent).toBe("Page 04 / 11");
  });

  // The whole point of the pill over a permanent row: it gives the space
  // back once the reader stops moving.
  test("fades out after the scroll settles", async () => {
    setPages(11, 3);
    const scroller = mountScroller("data-shiori-pdf-scroller");
    const { container } = render(<PageIndicatorPill />);

    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(pill(container)!.style.opacity).toBe("1");

    // Still up shortly before the linger elapses…
    await act(async () => {
      await wait(PAGE_PILL_LINGER_MS - 400);
    });
    expect(pill(container)!.style.opacity).toBe("1");

    // …and gone after it.
    await act(async () => {
      await wait(600);
    });
    expect(pill(container)!.style.opacity).toBe("0");
  });

  test("keeps the linger alive while the scroll continues", async () => {
    setPages(11, 3);
    const scroller = mountScroller("data-shiori-pdf-scroller");
    const { container } = render(<PageIndicatorPill />);

    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await act(async () => {
      await wait(PAGE_PILL_LINGER_MS - 400);
      scroller.dispatchEvent(new Event("scroll"));
      await wait(PAGE_PILL_LINGER_MS - 400);
    });
    expect(pill(container)!.style.opacity).toBe("1");
  });

  // Scroll events do not bubble but they do capture, so a window-level
  // listener hears the thumbnail rail, the outline panel and every open
  // dialog too. None of those turn a page.
  test("ignores scrolls that are not the document's own scroller", async () => {
    setPages(11, 3);
    const other = mountScroller("data-some-other-scroller");
    const { container } = render(<PageIndicatorPill />);

    await act(async () => {
      other.dispatchEvent(new Event("scroll"));
    });
    expect(pill(container)!.style.opacity).toBe("0");
  });

  test("renders nothing on a desktop viewport", () => {
    restoreViewport();
    setPages(11, 3);
    const { container } = render(<PageIndicatorPill />);
    expect(pill(container)).toBeNull();
  });

  test("renders nothing with no pages", () => {
    setPages(0, 0);
    const { container } = render(<PageIndicatorPill />);
    expect(pill(container)).toBeNull();
  });

  test("localises the readout", async () => {
    setPages(11, 3);
    const scroller = mountScroller("data-shiori-pdf-scroller");
    await i18n.changeLanguage("zh");
    try {
      const { container } = render(<PageIndicatorPill />);
      await act(async () => {
        scroller.dispatchEvent(new Event("scroll"));
      });
      expect(pill(container)!.textContent).toBe("第 04 / 11 页");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
