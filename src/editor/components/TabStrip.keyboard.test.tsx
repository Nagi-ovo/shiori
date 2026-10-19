import "../../test/setupDom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { TabStrip } from "./TabStrip";

const TABS = [
  { id: "a", title: "annual-report.pdf", kind: "pdf" as const },
  { id: "b", title: "contract.pdf", kind: "pdf" as const },
  { id: "c", title: "paper.pdf", kind: "pdf" as const },
];

// TabStrip sizes itself from a ResizeObserver, which happy-dom does not have.
// Same accommodation menuEscape.test.tsx makes for the same component.
function stubResizeObserver(): () => void {
  const real = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width: 900, height: 40 } } as ResizeObserverEntry],
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

// Once a drag activates, dnd-kit swallows every click at the document
// (capture-phase stopPropagation) so the drop's own click selects nothing,
// and on drop it removes that listener only 50 ms later. The document is
// shared by every file in the run, so a file that starts right after the drag
// test loses its clicks too: ToastHost's Close button did nothing in CI.
// Wait until a click reaches the page again before handing the document on.
async function documentTakesClicksAgain(): Promise<void> {
  const probe = document.createElement("button");
  let reached = false;
  probe.addEventListener("click", () => {
    reached = true;
  });
  document.body.append(probe);
  try {
    await waitFor(() => {
      fireEvent.click(probe);
      expect(reached).toBe(true);
    });
  } finally {
    probe.remove();
  }
}

function renderStrip() {
  const selected: string[] = [];
  const view = render(
    <TabStrip
      tabs={TABS}
      activeTabId="a"
      onSelect={(id) => selected.push(id)}
      onClose={() => {}}
      onReorder={() => {}}
      onNew={() => {}}
    />,
  );
  const tabs = Array.from(
    view.container.querySelectorAll<HTMLElement>('[role="tab"]'),
  );
  return { selected, view, tabs };
}

describe("TabStrip keyboard contract", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  let restoreResizeObserver: () => void = () => {};
  beforeEach(() => {
    restoreResizeObserver = stubResizeObserver();
  });

  afterEach(async () => {
    cleanup();
    document.body.replaceChildren();
    restoreResizeObserver();
    await documentTakesClicksAgain();
  });

  test("Enter activates the tab", () => {
    const { selected, tabs } = renderStrip();
    fireEvent.keyDown(tabs[1]!, { key: "Enter" });
    expect(selected).toEqual(["b"]);
  });

  test("mouse dragging keeps the tab level with the strip", async () => {
    const { tabs } = renderStrip();
    fireEvent.mouseDown(tabs[1]!, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 105, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 1000, clientY: 560 });
    await waitFor(() =>
      expect(tabs[1]!.style.transform).toContain(", 0px, 0)"),
    );
    fireEvent.mouseUp(document);
  });

  // The defect: dnd-kit spreads aria-roledescription="draggable" plus an
  // aria-describedby saying "press the space bar to pick up". Space was being
  // consumed as tab activation, so a screen-reader user did as instructed and
  // the strip never moved. Space now belongs to the drag sensor.
  test("Space is left to the drag sensor rather than activating the tab", () => {
    const { selected, tabs } = renderStrip();
    fireEvent.keyDown(tabs[1]!, { key: " " });
    expect(selected).toEqual([]);
  });

  test("arrows still walk the strip, selecting as they go", () => {
    const { selected, tabs } = renderStrip();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    // This strip uses APG's automatic-activation flavour: moving selects,
    // the way browser tabs behave. Handing Space to the drag sensor must not
    // have disturbed that.
    expect(selected).toEqual(["b"]);
  });
});
