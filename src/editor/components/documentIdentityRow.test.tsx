import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { DocumentShell } from "../../App/render/DocumentShell";
import { documentIdentityRow } from "./documentIdentityRow";

function installViewport(phone: boolean): () => void {
  const previousMatchMedia = window.matchMedia;
  const previousResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: phone && query.includes("max-width"),
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
        [{ target, contentRect: { width: 360, height: 40 } } as ResizeObserverEntry],
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

function renderShell(options: {
  phone: boolean;
  tabCount: number;
  readerMode?: boolean;
  title?: string;
  onOpen?: () => void;
}) {
  const restore = installViewport(options.phone);
  const view = render(
    <DocumentShell
      documentKind="pdf"
      title={options.title ?? "annual-report.pdf"}
      meta="PDF · 11 PP · 2.4 MB"
      readerMode={options.readerMode ?? false}
      navigatorOpen={false}
      onHome={() => {}}
      onOpen={options.onOpen}
      onOpenSettings={() => {}}
      onOpenShortcuts={() => {}}
      workspaceSwitcher={null}
      navigator={null}
      tabStrip={<div data-testid="tab-strip" />}
      tabCount={options.tabCount}
      viewport={<div data-testid="viewport">page</div>}
      railDoc={null}
      showRail={false}
      onCloseRail={() => {}}
    />,
  );
  return { view, restore };
}

/** The two rows that can name the document, as actually rendered. */
function rowsPresent(container: HTMLElement): string[] {
  const present: string[] = [];
  if (container.querySelector("[data-shiori-file-name-row]")) {
    present.push("fileName");
  }
  if (container.querySelector('[data-testid="tab-strip"]')) {
    present.push("tabStrip");
  }
  return present;
}

let restoreViewport: () => void = () => undefined;

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  restoreViewport();
  restoreViewport = () => undefined;
});

describe("the document identity row", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  // The invariant, at the DOM. A phone has nowhere else to put the file
  // name — the top bar's inline title only fits from tablet width up — so
  // rendering neither row would leave the reader unable to tell which of
  // their open documents is on screen. Rendering both is the ~72px of
  // duplicated chrome this change exists to remove.
  test.each([0, 1, 2, 3, 7])(
    "shows exactly one identity row on a phone with %i tabs",
    (tabCount) => {
      const { view, restore } = renderShell({ phone: true, tabCount });
      restoreViewport = restore;
      expect(rowsPresent(view.container)).toHaveLength(1);
    },
  );

  test("a single document on a phone is named by the filename row", () => {
    const { view, restore } = renderShell({ phone: true, tabCount: 1 });
    restoreViewport = restore;
    expect(rowsPresent(view.container)).toEqual(["fileName"]);
    // …and the name is really in it, not merely the row's box.
    const row = view.container.querySelector("[data-shiori-file-name-row]");
    expect(row?.textContent).toContain("annual-report.pdf");
  });

  test("two documents on a phone are named by the tab strip", () => {
    const { view, restore } = renderShell({ phone: true, tabCount: 2 });
    restoreViewport = restore;
    expect(rowsPresent(view.container)).toEqual(["tabStrip"]);
  });

  // Desktop and tablets are untouched: the strip always shows, and the name
  // is inline in the bar rather than on a second line.
  test.each([1, 2])(
    "a wide viewport keeps the tab strip with %i tabs",
    (tabCount) => {
      const { view, restore } = renderShell({ phone: false, tabCount });
      restoreViewport = restore;
      expect(rowsPresent(view.container)).toEqual(["tabStrip"]);
    },
  );

  // The documented exception, and the one this change must not disturb:
  // reader mode drops the whole chrome, top bar included.
  test("reader mode still shows neither row", () => {
    const { view, restore } = renderShell({
      phone: true,
      tabCount: 1,
      readerMode: true,
    });
    restoreViewport = restore;
    expect(rowsPresent(view.container)).toEqual([]);
  });

  // The tab strip carries the "+" that opens another document, so a phone
  // that hides the strip has to be able to show that opener somewhere else.
  // App hands the PDF branch's top bar one exactly in this case; this is the
  // half of that claim a component test can hold — the top bar really does
  // render an opener in the single-document phone layout.
  test("the top bar can carry the opener when the strip is hidden", async () => {
    const { view, restore } = renderShell({
      phone: true,
      tabCount: 1,
      onOpen: () => {},
    });
    restoreViewport = restore;
    expect(rowsPresent(view.container)).toEqual(["fileName"]);
    expect(view.getByTitle(i18n.t("tabs.new"))).toBeTruthy();
  });

  // The pure decision, including the branch App cannot reach: a shell with
  // no title falls back to the strip rather than answering "neither".
  test("never answers with neither row", () => {
    for (const isPhone of [true, false]) {
      for (const tabCount of [0, 1, 2, 5]) {
        for (const hasFileName of [true, false]) {
          const row = documentIdentityRow({ isPhone, tabCount, hasFileName });
          expect(["fileName", "tabStrip"]).toContain(row);
          if (row === "fileName") expect(hasFileName).toBe(true);
        }
      }
    }
  });
});
