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
import { Thumbnails } from "./Thumbnails";

describe("thumbnail Add pages menu", () => {
  const storeSnapshot = useEditorStore.getState();

  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useEditorStore.setState(storeSnapshot, true);
  });

  test("uses one accessible menu and inserts a PDF after the active page", async () => {
    seedPages();
    const insertPdf = mock(() => undefined);
    const view = renderRail(insertPdf);
    const trigger = view.getByRole("button", { name: "Add pages" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);

    const menu = view.getByRole("menu", { name: "Add pages" });
    const blank = view.getByRole("menuitem", { name: "Insert blank page" });
    const fromPdf = view.getByRole("menuitem", {
      name: /Insert pages from PDF/,
    });
    expect(blank.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(fromPdf.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(fromPdf.textContent).toBe("Insert pages from PDF…");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(document.activeElement === blank).toBe(true));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement === fromPdf).toBe(true);
    fireEvent.click(fromPdf);

    expect(insertPdf).toHaveBeenCalledTimes(1);
    expect(insertPdf).toHaveBeenCalledWith("p2");
    expect(view.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement === trigger).toBe(true));
  });

  test("keeps pointer hover transient without changing keyboard focus", async () => {
    seedPages();
    const view = renderRail(() => undefined);
    fireEvent.click(view.getByRole("button", { name: "Add pages" }));

    const blank = view.getByRole<HTMLButtonElement>("menuitem", {
      name: "Insert blank page",
    });
    const fromPdf = view.getByRole<HTMLButtonElement>("menuitem", {
      name: /Insert pages from PDF…/,
    });
    await waitFor(() => expect(document.activeElement).toBe(blank));

    fireEvent.mouseEnter(fromPdf);
    fireEvent.mouseLeave(fromPdf);

    expect(document.activeElement).toBe(blank);
    expect(blank.tabIndex).toBe(0);
    expect(blank.dataset.active).toBe("true");
    expect(fromPdf.tabIndex).toBe(-1);
    expect(fromPdf.dataset.active).toBeUndefined();

    fireEvent.keyDown(view.getByRole("menu", { name: "Add pages" }), {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(fromPdf);
    expect(fromPdf.tabIndex).toBe(0);
  });

  test("keeps the existing blank-page action and restores focus after Escape", async () => {
    seedPages();
    const view = renderRail(() => undefined);
    const trigger = view.getByRole("button", { name: "Add pages" });
    fireEvent.click(trigger);
    const blank = view.getByRole("menuitem", { name: "Insert blank page" });
    fireEvent.click(blank);

    const state = useEditorStore.getState();
    expect(state.model.pages).toHaveLength(3);
    expect(state.model.pages[2]?.blank).toBe(true);
    expect(state.activePageId).toBe(state.model.pages[2]?.id);

    fireEvent.click(trigger);
    await waitFor(() => expect(view.queryByRole("menu")).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement === trigger).toBe(true));
  });

  test("opens at either edge with arrow keys and lets Tab leave the menu", async () => {
    seedPages();
    const view = renderRail(() => undefined);
    const trigger = view.getByRole("button", { name: "Add pages" });

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const fromPdf = view.getByRole("menuitem", {
      name: /Insert pages from PDF/,
    });
    const blank = view.getByRole("menuitem", { name: "Insert blank page" });
    await waitFor(() => expect(document.activeElement === fromPdf).toBe(true));
    expect(fromPdf.tabIndex).toBe(0);
    expect(blank.tabIndex).toBe(-1);

    const nextControl = document.createElement("button");
    nextControl.textContent = "Next control";
    document.body.append(nextControl);
    fireEvent.keyDown(fromPdf, { key: "Tab" });
    expect(view.queryByRole("menu")).not.toBeNull();
    fireEvent.blur(fromPdf, { relatedTarget: nextControl });
    nextControl.focus();
    expect(view.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(nextControl);

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => {
      const first = view.getByRole("menuitem", { name: "Insert blank page" });
      expect(document.activeElement === first).toBe(true);
    });
  });

  test("blocks duplicate PDF insertion while local processing is busy", () => {
    seedPages();
    const view = renderRail(() => undefined, true);
    const trigger = view.getByRole("button", { name: "Add pages" });

    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(
      view.getByText("Inserting PDF pages…", { selector: "span" }).textContent,
    ).toBe("Inserting PDF pages…");
    fireEvent.click(trigger);
    expect(view.queryByRole("menu")).toBeNull();
  });
});

function seedPages() {
  useEditorStore.setState({
    model: {
      pages: [
        { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
        { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
      ],
      overlays: [],
    },
    activePageId: "p2",
  } as never);
}

function renderRail(
  onInsertPdfPages: (pageId: string | null) => void,
  pdfInsertionBusy = false,
) {
  return render(
    <VirtuosoMockContext.Provider
      value={{ viewportHeight: 600, itemHeight: 260 }}
    >
      <Thumbnails
        doc={null}
        pdfInsertionBusy={pdfInsertionBusy}
        onInsertPdfPages={onInsertPdfPages}
        embedded
      />
    </VirtuosoMockContext.Provider>,
  );
}
