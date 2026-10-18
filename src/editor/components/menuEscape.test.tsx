import "../../test/setupDom";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { VirtuosoMockContext } from "react-virtuoso";
import i18n from "../../i18n";
import { useEditorStore } from "../store/store";
import { TabStrip } from "./TabStrip";
import { Thumbnails } from "./Thumbnails";

/**
 * These two menus dismiss on Escape. So does Canvas's drawing tool — it
 * listens on window and disarms whatever is armed. Each menu used to roll its
 * own listener that called preventDefault and nothing else, which Canvas does
 * not check, so dismissing a menu also disarmed the highlighter: press `h`,
 * open the menu, press Escape, and the next drag selected text instead.
 *
 * The fix routes both through useEscapeClose, which listens in capture phase
 * and stops the event outright. Testing the hook alone did not guard that —
 * reverting either component to a local listener left the hook's own tests
 * green, so these render the real components.
 *
 * Both call sites are covered, and each needs a different accommodation for
 * happy-dom's zero-sized boxes. They are mutually exclusive: see
 * withStubbedResizeObserver.
 */
describe("menus do not leak Escape to the app", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  // Snapshotted, because the thumbnail test seeds pages into the shared
  // store. Leaving them there makes any later test that reads the model
  // order-dependent — a false red or a false green depending on what it
  // expects.
  const storeSnapshot = useEditorStore.getState();

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useEditorStore.setState(storeSnapshot, true);
  });

  function pressEscape() {
    fireEvent.keyDown(window, { key: "Escape" });
  }

  /**
   * TabStrip decides what overflows from its own measured width, and
   * happy-dom has no ResizeObserver at all — without this, no overflow
   * control renders and the test passes without opening anything.
   *
   * Scoped to the one test that needs it rather than installed globally.
   * Installing it globally breaks the thumbnail test below: react-virtuoso
   * prefers a real ResizeObserver over VirtuosoMockContext, measures zero,
   * and renders no rows. Two components, two opposite requirements.
   */
  function withStubbedResizeObserver<T>(run: () => T): T {
    const real = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: { width: 240, height: 600 },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    };
    try {
      return run();
    } finally {
      if (real === undefined) {
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      } else {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = real;
      }
    }
  }

  test("the tab overflow menu swallows Escape", () => {
    withStubbedResizeObserver(() => {
      const tabs = Array.from({ length: 12 }, (_, index) => ({
        id: `t${index}`,
        title: `document-${index}.pdf`,
        kind: "pdf" as const,
      }));
      const view = render(
        <TabStrip
          tabs={tabs}
          activeTabId="t0"
          onSelect={() => undefined}
          onClose={() => undefined}
          onReorder={() => undefined}
          onNew={() => undefined}
        />,
      );

      const trigger = view.container.querySelector<HTMLButtonElement>(
        'button[aria-haspopup="menu"]',
      );
      // Asserted, not skipped: an earlier version returned early when the
      // trigger was absent and passed without opening anything.
      expect(trigger).not.toBeNull();
      if (!trigger) return;

      const appLevel = mock(() => undefined);
      window.addEventListener("keydown", appLevel);
      try {
        fireEvent.click(trigger);
        expect(view.queryByRole("menu")).not.toBeNull();

        pressEscape();

        expect(view.queryByRole("menu")).toBeNull();
        expect(appLevel).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("keydown", appLevel);
      }
    });
  });

  test("the thumbnail context menu swallows Escape", async () => {
    // The rail renders through react-virtuoso, which produces no rows
    // against happy-dom's zero-height boxes. VirtuosoMockContext is the
    // library's own way to supply a viewport without DOM measurement.
    useEditorStore.setState({
      model: {
        pages: [
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
          { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      // null, not "p1": with an active page the rail asks Virtuoso to scroll
      // to it, and nothing renders in the mock viewport.
      activePageId: null,
    } as never);

    const view = render(
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 600, itemHeight: 260 }}
      >
        <Thumbnails doc={null} onInsertPdfPages={() => undefined} />
      </VirtuosoMockContext.Provider>,
    );

    // Rows mount from an effect. Waited for, not slept on: a fixed delay
    // fails under load, which is the worst kind of flake to debug.
    const thumb = await waitFor(() => {
      const found = view.container.querySelector("[data-thumb-page-id]");
      expect(found).not.toBeNull();
      return found!;
    });

    const appLevel = mock(() => undefined);
    window.addEventListener("keydown", appLevel);
    try {
      fireEvent.contextMenu(thumb, { clientX: 20, clientY: 20 });
      expect(view.queryByRole("menu")).not.toBeNull();

      pressEscape();

      expect(view.queryByRole("menu")).toBeNull();
      expect(appLevel).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", appLevel);
    }
  });

  test("the thumbnail context menu is one keyboard tab stop", async () => {
    useEditorStore.setState({
      model: {
        pages: [
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
          { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      activePageId: null,
    } as never);

    const view = render(
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 600, itemHeight: 260 }}
      >
        <Thumbnails doc={null} onInsertPdfPages={() => undefined} />
      </VirtuosoMockContext.Provider>,
    );
    const thumb = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        "[data-thumb-page-id]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    const rail = view.container.querySelector<HTMLElement>(".shioriThumbsRail");
    expect(rail).not.toBeNull();
    fireEvent.pointerDown(thumb, { button: 2 });
    expect(document.activeElement).toBe(rail);
    fireEvent.contextMenu(thumb, { clientX: 20, clientY: 20 });

    const menu = view.getByRole("menu", { name: "Page actions" });
    const items = view.getAllByRole<HTMLButtonElement>("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    expect(items.map((item) => item.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1, -1]);

    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items.at(-1));

    const nextControl = document.createElement("button");
    nextControl.textContent = "Next control";
    document.body.append(nextControl);
    fireEvent.keyDown(menu, { key: "Tab" });
    expect(view.queryByRole("menu")).not.toBeNull();
    fireEvent.blur(items.at(-1)!, { relatedTarget: nextControl });
    nextControl.focus();
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(nextControl);
  });

  test("viewport movement closes the context menu back to its real opener", async () => {
    useEditorStore.setState({
      model: {
        pages: [
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      activePageId: null,
    } as never);

    const view = render(
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 600, itemHeight: 260 }}
      >
        <Thumbnails doc={null} onInsertPdfPages={() => undefined} />
      </VirtuosoMockContext.Provider>,
    );
    const thumb = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        "[data-thumb-page-id]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    const opener = thumb.querySelector<HTMLElement>('[role="button"]');
    const rail = view.container.querySelector<HTMLElement>(".shioriThumbsRail");
    expect(opener).not.toBeNull();
    expect(rail).not.toBeNull();

    opener!.focus();
    fireEvent.contextMenu(opener!, { clientX: 20, clientY: 20 });
    const firstMenu = view.getByRole("menu", { name: "Page actions" });
    await waitFor(() => expect(firstMenu.contains(document.activeElement)).toBe(true));
    fireEvent.scroll(firstMenu);
    expect(view.queryByRole("menu", { name: "Page actions" })).not.toBeNull();
    fireEvent.scroll(rail!);
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(opener);

    fireEvent.contextMenu(opener!, { clientX: 20, clientY: 20 });
    const secondMenu = view.getByRole("menu", { name: "Page actions" });
    await waitFor(() => expect(secondMenu.contains(document.activeElement)).toBe(true));
    fireEvent.resize(window);
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  test("the thumbnail context menu restores focus on Escape and skips busy work", async () => {
    useEditorStore.setState({
      model: {
        pages: [
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      activePageId: null,
    } as never);

    const view = render(
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 600, itemHeight: 260 }}
      >
        <Thumbnails
          doc={null}
          pdfInsertionBusy
          onInsertPdfPages={() => undefined}
        />
      </VirtuosoMockContext.Provider>,
    );
    const thumb = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        "[data-thumb-page-id]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    const rail = view.container.querySelector<HTMLElement>(".shioriThumbsRail");
    expect(rail).not.toBeNull();
    fireEvent.pointerDown(thumb, { button: 2 });
    fireEvent.contextMenu(thumb, { clientX: 20, clientY: 20 });

    const menu = view.getByRole("menu", { name: "Page actions" });
    const items = view.getAllByRole<HTMLButtonElement>("menuitem", {
      hidden: true,
    });
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    expect(items[1]?.disabled).toBe(true);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);

    pressEscape();
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(rail);
  });

  test("an outside pointer close never steals focus back", async () => {
    useEditorStore.setState({
      model: {
        pages: [
          { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        ],
        overlays: [],
      },
      activePageId: null,
    } as never);

    const view = render(
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 600, itemHeight: 260 }}
      >
        <Thumbnails doc={null} onInsertPdfPages={() => undefined} />
      </VirtuosoMockContext.Provider>,
    );
    const thumb = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        "[data-thumb-page-id]",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.pointerDown(thumb, { button: 2 });
    fireEvent.contextMenu(thumb, { clientX: 20, clientY: 20 });
    await waitFor(() => expect(view.queryByRole("menu")).not.toBeNull());

    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    fireEvent.pointerDown(outside);
    outside.focus();

    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});
