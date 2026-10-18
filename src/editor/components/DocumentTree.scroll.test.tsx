import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { DocumentList } from "./DocumentTree";

/**
 * The navigator replaces this list with thumbnails or the outline as the
 * active document changes, so the scroll box is unmounted and rebuilt rather
 * than hidden. Rebuilt boxes start at the top, which threw the reader back to
 * the first row every time they opened a file from a long folder.
 */
describe("the documents list keeps its place across remounts", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  const props = {
    items: [],
    activeTabId: null,
    markCount: 0,
    onSelect: () => undefined,
    onClose: () => undefined,
    onTogglePin: () => undefined,
    onShowMarks: () => undefined,
    folderPaths: [],
    onUnmountFolder: () => undefined,
    onOpenFolderFile: () => undefined,
  };

  const scrollBox = (container: HTMLElement) => {
    const box = [...container.querySelectorAll("div")].find(
      (node) => node.style.overflowY === "auto",
    );
    if (!box) throw new Error("documents list has no scroll box");
    return box;
  };

  test("a rebuilt list restores the offset the reader left it at", () => {
    const first = render(<DocumentList {...props} />);
    const box = scrollBox(first.container);
    box.scrollTop = 420;
    fireEvent.scroll(box);
    cleanup();

    const second = render(<DocumentList {...props} />);
    expect(scrollBox(second.container).scrollTop).toBe(420);
  });

  test("updates the hovered file and moves opposite pointer or content motion", () => {
    const view = render(
      <DocumentList
        {...props}
        items={[
          { id: "first", kind: "pdf", title: "First paper.pdf" },
          { id: "second", kind: "docx", title: "Second paper.docx" },
        ]}
      />,
    );
    const box = scrollBox(view.container);
    const first = view.getByText("First paper.pdf").closest("[role=button]");
    const second = view.getByText("Second paper.docx").closest("[role=button]");
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) {
      throw new Error("document rows not found");
    }
    const rowRect = {
      left: 20,
      right: 260,
      top: 280,
      bottom: 304,
      width: 240,
      height: 24,
      x: 20,
      y: 280,
      toJSON: () => ({}),
    } as DOMRect;
    first.getBoundingClientRect = () => rowRect;
    second.getBoundingClientRect = () => rowRect;

    const originalElementFromPoint = document.elementFromPoint;
    let hit: HTMLElement = first;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => hit,
    });
    try {
      fireEvent.mouseMove(first, { clientX: 120, clientY: 300 });
      const initialHover = view.getByRole("tooltip");
      expect(initialHover.textContent).toContain("First paper.pdf");

      hit = second;
      fireEvent.mouseMove(second, { clientX: 120, clientY: 320 });
      const afterPointerMovesDown = view.getByRole("tooltip");
      expect(afterPointerMovesDown.textContent).toContain("Second paper.docx");
      expect(afterPointerMovesDown.style.bottom).not.toBe("");
      expect(afterPointerMovesDown.style.top).toBe("");

      hit = first;
      fireEvent.mouseMove(first, { clientX: 120, clientY: 290 });
      const afterPointerMovesUp = view.getByRole("tooltip");
      expect(afterPointerMovesUp.textContent).toContain("First paper.pdf");
      expect(afterPointerMovesUp.style.top).not.toBe("");
      expect(afterPointerMovesUp.style.bottom).toBe("");

      hit = second;
      box.scrollTop -= 20;
      fireEvent.scroll(box);
      const afterContentMovesDown = view.getByRole("tooltip");
      expect(afterContentMovesDown.textContent).toContain("Second paper.docx");
      expect(afterContentMovesDown.style.bottom).not.toBe("");
      expect(afterContentMovesDown.style.top).toBe("");

      hit = first;
      box.scrollTop += 10;
      fireEvent.scroll(box);
      const afterContentMovesUp = view.getByRole("tooltip");
      expect(afterContentMovesUp.textContent).toContain("First paper.pdf");
      expect(afterContentMovesUp.style.top).not.toBe("");
      expect(afterContentMovesUp.style.bottom).toBe("");
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });
});
