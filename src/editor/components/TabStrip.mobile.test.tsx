import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import i18n from "../../i18n";
import { TabStrip, type TabStripItem } from "./TabStrip";

const TABS: TabStripItem[] = Array.from({ length: 8 }, (_, index) => ({
  id: `mobile-${index}`,
  title: `document-${index}.pdf`,
  kind: "pdf",
  updatedAt: index,
}));

function installMobileViewport(): () => void {
  const previousMatchMedia = window.matchMedia;
  const previousResizeObserver = globalThis.ResizeObserver;

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
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [
          {
            target,
            contentRect: { width: 240, height: 40 },
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  };

  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: previousMatchMedia,
    });
    if (previousResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = previousResizeObserver;
    }
  };
}

describe("TabStrip mobile scrolling", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  let restoreViewport = () => undefined;
  beforeEach(() => {
    restoreViewport = installMobileViewport();
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    restoreViewport();
  });

  test("keeps every tab in one native horizontal scroll strip", () => {
    const view = render(
      <TabStrip
        tabs={TABS}
        activeTabId="mobile-0"
        onSelect={() => undefined}
        onClose={() => undefined}
        onReorder={() => undefined}
        onNew={() => undefined}
      />,
    );

    const tablist = view.getByRole("tablist");
    const renderedTabs = view.getAllByRole("tab");
    const newTabButton = view.getByRole("button", { name: "Open document" });

    expect(renderedTabs).toHaveLength(TABS.length);
    expect(view.queryByRole("button", { name: /more tabs/i })).toBeNull();
    expect(tablist.style.overflowX).toBe("auto");
    expect(tablist.style.touchAction).toBe("pan-x");
    expect(newTabButton.parentElement).not.toBe(tablist);
    expect(newTabButton.style.flex).toBe("0 0 auto");
    for (const tab of renderedTabs) {
      expect(tab.style.flex).toBe("0 0 auto");
    }
  });
});
