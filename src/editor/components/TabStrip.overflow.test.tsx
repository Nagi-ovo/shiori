import "../../test/setupDom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { useState } from "react";
import i18n from "../../i18n";
import { TabStrip, type TabStripItem } from "./TabStrip";

const TABS: TabStripItem[] = Array.from({ length: 12 }, (_, index) => ({
  id: `t${index}`,
  title: `document-${index}.pdf`,
  kind: "pdf",
  updatedAt: index,
}));

function stubResizeObserver(): () => void {
  const real = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
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
    if (real === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = real;
    }
  };
}

describe("TabStrip overflow actions", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  let restoreResizeObserver: () => void = () => {};
  beforeEach(() => {
    restoreResizeObserver = stubResizeObserver();
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    restoreResizeObserver();
  });

  test("keeps the menu open and hands focus to the next close action", async () => {
    const onSelect = mock(() => undefined);
    const onClose = mock(() => undefined);
    const view = render(
      <TabStrip
        tabs={TABS}
        activeTabId="t0"
        onSelect={onSelect}
        onClose={onClose}
        onReorder={() => undefined}
        onNew={() => undefined}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /more tabs/i }));
    const firstClose = view.getByRole("menuitem", {
      name: "Close “document-1.pdf”",
    });
    firstClose.focus();
    fireEvent.click(firstClose);

    await waitFor(() => expect(onClose).toHaveBeenCalledWith("t1"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(view.getByRole("menu", { name: "Hidden tabs" })).toBeTruthy();
  });

  test("supports consecutive closes without dismissing the menu", async () => {
    function ControlledStrip() {
      const [tabs, setTabs] = useState(TABS);
      return (
        <TabStrip
          tabs={tabs}
          activeTabId="t0"
          onSelect={() => undefined}
          onClose={(id) => setTabs((current) => current.filter((tab) => tab.id !== id))}
          onReorder={() => undefined}
          onNew={() => undefined}
        />
      );
    }
    const view = render(<ControlledStrip />);

    fireEvent.click(view.getByRole("button", { name: /more tabs/i }));
    const firstClose = view.getByRole("menuitem", {
      name: "Close “document-1.pdf”",
    });
    firstClose.focus();
    await act(async () => {
      fireEvent.click(firstClose);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      view.queryByRole("menuitem", { name: "Close “document-1.pdf”" }),
    ).toBeNull();
    const secondClose = view.getByRole("menuitem", {
      name: "Close “document-2.pdf”",
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      secondClose.getAttribute("aria-label"),
    );
    await act(async () => {
      fireEvent.click(secondClose);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      view.queryByRole("menuitem", { name: "Close “document-2.pdf”" }),
    ).toBeNull();
    expect(view.getByRole("menu", { name: "Hidden tabs" })).toBeTruthy();
  });

  test("shows a cached last-position preview without selecting the tab", async () => {
    const onSelect = mock(() => undefined);
    const onPreviewRequest = mock(async () => ({
      imageUrl: "data:image/jpeg;base64,last-position",
      pageNumber: 9,
      scale: 1.25,
    }));
    const view = render(
      <TabStrip
        tabs={TABS}
        activeTabId="t0"
        onSelect={onSelect}
        onClose={() => undefined}
        onPreviewRequest={onPreviewRequest}
        onReorder={() => undefined}
        onNew={() => undefined}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /more tabs/i }));
    await waitFor(() =>
      expect(onPreviewRequest).toHaveBeenCalledWith("t1"),
    );
    const preview = await view.findByRole("tooltip", {
      name: /Preview of document-1\.pdf/,
    });
    expect(preview.textContent).toContain("Page 9 · 125%");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/jpeg;base64,last-position",
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("closes every hidden tab as one explicit batch action", async () => {
    const onClose = mock((id: string) => void id);
    const view = render(
      <TabStrip
        tabs={TABS}
        activeTabId="t0"
        onSelect={() => undefined}
        onClose={onClose}
        onReorder={() => undefined}
        onNew={() => undefined}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /more tabs/i }));
    const batchAction = view.getByRole("menuitem", {
      name: /Close these \d+ hidden tabs/,
    });
    fireEvent.click(batchAction);

    await waitFor(() => expect(onClose.mock.calls.length).toBeGreaterThan(0));
    const closedIds = onClose.mock.calls.map(([id]) => id);
    expect(closedIds.length).toBeGreaterThan(0);
    expect(closedIds).not.toContain("t0");
  });
});
