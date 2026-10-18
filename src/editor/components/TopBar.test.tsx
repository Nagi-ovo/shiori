import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { TopBar } from "./TopBar";

describe("TopBar window dragging", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  test("makes the empty filename gutters direct Tauri drag targets", () => {
    const view = render(
      <TopBar
        fileName="paper.pdf"
        meta="12 pages"
        onOpenShortcuts={() => undefined}
        onOpenSettings={() => undefined}
        onOpenExport={() => undefined}
        onToggleOutline={() => undefined}
        onToggleThumbs={() => undefined}
        navigatorOpen={false}
      />,
    );

    const fileName = view.getByText("paper.pdf");
    const titleGroup = fileName.parentElement;
    const flexibleTitleRegion = titleGroup?.parentElement;

    // Tauri 2.10 checks the exact mouse target, not only its ancestors. Both
    // layout boxes can therefore receive a click when the pointer is in a flex
    // gutter or in the gap between the filename and metadata.
    expect(titleGroup?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(flexibleTitleRegion?.hasAttribute("data-tauri-drag-region")).toBe(true);

    // Keep the filename itself outside the drag region: activating it is
    // the explicit copy gesture and must not also maximize the window.
    expect(fileName.hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  // The filename was a span whose only handler was double-click, so the copy
  // had no keyboard route at all. As a button, Enter/Space and click share one
  // handler and the element is in the tab order.
  test("copies the file name from a focusable button", async () => {
    const written: string[] = [];
    const clipboard = { writeText: (text: string) => { written.push(text); return Promise.resolve(); } };
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    const view = render(
      <TopBar
        fileName="paper.pdf"
        meta="12 pages"
        onOpenShortcuts={() => undefined}
        onOpenSettings={() => undefined}
        onOpenExport={() => undefined}
        onToggleOutline={() => undefined}
        onToggleThumbs={() => undefined}
        navigatorOpen={false}
      />,
    );
    const fileName = view.getByRole("button", { name: "paper.pdf" });
    expect(fileName.tagName).toBe("BUTTON");
    // The tooltip carries the full name for when the ellipsis truncates it.
    expect(fileName.getAttribute("title")).toContain("paper.pdf");
    fireEvent.click(fileName);
    await Promise.resolve();
    expect(written).toEqual(["paper.pdf"]);
  });

  test("shows the action that the navigator toggle will perform", () => {
    const renderTopBar = (navigatorOpen: boolean) =>
      render(
        <TopBar
          fileName="paper.pdf"
          meta="12 pages"
          onOpenShortcuts={() => undefined}
          onOpenSettings={() => undefined}
          onOpenExport={() => undefined}
          onToggleOutline={() => undefined}
          onToggleThumbs={() => undefined}
          navigatorOpen={navigatorOpen}
        />,
      );

    const closed = renderTopBar(false);
    const openButton = closed.getByRole("button", { name: "Show navigator" });
    expect(openButton.getAttribute("aria-expanded")).toBe("false");
    expect(openButton.getAttribute("aria-controls")).toBe(
      "shiori-left-navigator",
    );
    expect(openButton.querySelector(".lucide-panel-left-open")).not.toBeNull();
    closed.unmount();

    const opened = renderTopBar(true);
    const closeButton = opened.getByRole("button", { name: "Hide navigator" });
    expect(closeButton.getAttribute("aria-expanded")).toBe("true");
    expect(closeButton.querySelector(".lucide-panel-left-close")).not.toBeNull();
  });
});
