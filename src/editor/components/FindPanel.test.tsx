import "../../test/setupDom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { PdfDocument, PdfEngine } from "../../pdf/engine/types";
import { fakePdfDocument, withFakePdfEngine } from "../../test/fakePdfEngine";
import type { PageModel } from "../../pdf/model/types";
import { useEditorStore } from "../store/store";
import type { FindPanel as FindPanelComponent } from "./FindPanel";

const initialSnapshot = useEditorStore.getState();
let FindPanel: typeof FindPanelComponent;

const pages: PageModel[] = [
  { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 100, heightPt: 200 },
  { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 100, heightPt: 200 },
  { id: "p3", sourceIndex: 2, rotation: 0, widthPt: 100, heightPt: 200 },
];

// Each fake document's page texts, as the engine reads them: one item per
// page, or the page's items with their geometry. The calls count how often
// the engine was asked.
type FakeItem = { str: string; x: number; y: number; width: number; hasEOL: boolean };
const texts = new WeakMap<PdfDocument, Array<string | FakeItem[]>>();
let pageTextCalls = 0;
const textOf = (doc: PdfDocument, sourceIndex: number) => {
  const page = texts.get(doc)?.[sourceIndex] ?? "";
  const items = typeof page === "string"
    ? [{ str: page, dir: "ltr", transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0, fontName: "f", hasEOL: false }]
    : page.map(({ str, x, y, width, hasEOL }) => ({
        str, dir: "ltr", transform: [10, 0, 0, 10, x, y], width, height: 10, fontName: "f", hasEOL,
      }));
  return {
    content: { items, styles: {}, lang: null },
    glyphs: null,
    fontNames: new Map(),
    faceFamilies: new Map(),
  };
};
const readPageText: PdfEngine["pageText"] = async (doc, sourceIndex) => {
  pageTextCalls += 1;
  return textOf(doc, sourceIndex);
};
let pageText = readPageText;
withFakePdfEngine({ pageText: (...args) => pageText(...args) });

describe("FindPanel navigation", () => {
  beforeAll(async () => {
    installDomMatrix();
    FindPanel = (await import("./FindPanel")).FindPanel;
  });

  beforeEach(async () => {
    cleanup();
    document.body.replaceChildren();
    useEditorStore.setState(initialSnapshot, true);
    pageTextCalls = 0;
    pageText = readPageText;
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    useEditorStore.setState(initialSnapshot, true);
  });

  test("requests Canvas page jumps as the active match changes", async () => {
    const view = render(
      <FindPanel
        doc={fakeDoc(["alpha", "needle first", "needle second"])}
        pages={pages}
        open
        onClose={() => undefined}
      />,
    );
    const input = await view.findByPlaceholderText("Find in document");
    const user = userEvent.setup();

    await user.type(input, "needle");

    await waitFor(() => {
      expect(useEditorStore.getState().pageJump).toEqual({
        pageId: "p2",
        index: 1,
        offsetY: null,
      });
    });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useEditorStore.getState().pageJump).toEqual({
        pageId: "p3",
        index: 2,
        offsetY: null,
      });
    });
  });

  test("keeps query and index across close/reopen without re-extracting", async () => {
    const doc = fakeDoc(["alpha", "needle first", "needle second"]);

    const view = render(
      <FindPanel doc={doc} pages={pages} open onClose={() => undefined} />,
    );
    const input = await view.findByPlaceholderText("Find in document");
    const user = userEvent.setup();
    await user.type(input, "needle");

    await waitFor(() => {
      expect(useEditorStore.getState().pageJump).toMatchObject({ pageId: "p2" });
    });
    const callsAfterFirstIndex = pageTextCalls;
    expect(callsAfterFirstIndex).toBeGreaterThan(0);

    await act(async () => {
      view.rerender(
        <FindPanel doc={doc} pages={pages} open={false} onClose={() => undefined} />,
      );
    });
    await act(async () => {
      view.rerender(
        <FindPanel doc={doc} pages={pages} open onClose={() => undefined} />,
      );
    });

    const reopened = await view.findByPlaceholderText("Find in document");
    expect((reopened as HTMLInputElement).value).toBe("needle");
    await waitFor(() => {
      expect(useEditorStore.getState().searchMatchHighlight).toMatchObject({
        pageId: "p2",
      });
    });
    expect(pageTextCalls).toBe(callsAfterFirstIndex);
  });

  test("does not jump when the active match page is already visible", async () => {
    const view = render(
      <FindPanel
        doc={fakeDoc(["alpha", "needle visible", "omega"])}
        pages={pages}
        open
        onClose={() => undefined}
      />,
    );
    document.body.append(visiblePageNode("p2"));
    const input = await view.findByPlaceholderText("Find in document");
    const user = userEvent.setup();

    await user.type(input, "needle");

    await waitFor(() => {
      expect(useEditorStore.getState().searchMatchHighlight).toMatchObject({
        pageId: "p2",
      });
    });
    expect(useEditorStore.getState().pageJump).toBeNull();
  });

  test("highlights the original source range after Unicode case folding", async () => {
    const view = render(
      <FindPanel
        doc={fakeDoc(["İABC", "", ""])}
        pages={pages}
        open
        onClose={() => undefined}
      />,
    );
    const input = await view.findByPlaceholderText("Find in document");
    await userEvent.setup().type(input, "ABC");

    await waitFor(() => {
      expect(useEditorStore.getState().searchMatchHighlight).toEqual({
        pageId: "p1",
        charStart: 1,
        charEnd: 4,
      });
    });
  });

  test("does not match across a column jump", async () => {
    // Column one ends "until the end."; column two starts on the same
    // baseline, so the line end is a hard break, not a wrap.
    const view = render(
      <FindPanel
        doc={fakeDoc([
          [
            { str: "until the end.", x: 72, y: 700, width: 70, hasEOL: true },
            { str: "Column two starts", x: 300, y: 700, width: 85, hasEOL: false },
          ],
          "",
          "",
        ])}
        pages={pages}
        open
        onClose={() => undefined}
      />,
    );
    const input = await view.findByPlaceholderText("Find in document");
    const user = userEvent.setup();
    await user.type(input, "Column two");
    await waitFor(() => {
      expect(useEditorStore.getState().searchMatchHighlight).toEqual({
        pageId: "p1",
        charStart: 15,
        charEnd: 25,
      });
    });
    await user.clear(input);
    await user.type(input, "the end. Column two");
    await waitFor(() => {
      expect(useEditorStore.getState().searchMatchHighlight).toBeNull();
    });
  });

  test("fails closed instead of crashing on a pathological search map", async () => {
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const view = render(
        <FindPanel
          doc={fakeDoc(["İ".repeat(50_001), "", ""])}
          pages={pages}
          open
          onClose={() => undefined}
        />,
      );
      const input = await view.findByPlaceholderText("Find in document");
      await userEvent.setup().type(input, "i");
      await view.findByText(
        "Couldn't index this document. Close and reopen the file to search it.",
      );
      expect(useEditorStore.getState().searchMatchHighlight).toBeNull();
    } finally {
      console.error = originalError;
    }
  });

  test("stops reading pages when the panel closes mid-read", async () => {
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    pageText = async (doc, sourceIndex) => {
      pageTextCalls += 1;
      await stalled;
      return textOf(doc, sourceIndex);
    };
    const doc = fakeDoc(["needle", "needle", "needle"]);
    const view = render(<FindPanel doc={doc} pages={pages} open onClose={() => undefined} />);
    await waitFor(() => expect(pageTextCalls).toBe(1));
    await act(async () => {
      view.rerender(<FindPanel doc={doc} pages={pages} open={false} onClose={() => undefined} />);
    });
    await act(async () => {
      release();
      await stalled;
    });
    // The first page's read finishes into a closed panel; no second one starts.
    expect(pageTextCalls).toBe(1);
  });

});

function fakeDoc(pageTexts: Array<string | FakeItem[]>): PdfDocument {
  const doc = fakePdfDocument();
  texts.set(doc, pageTexts);
  return doc;
}

function installDomMatrix(): void {
  if (typeof globalThis.DOMMatrix !== "undefined") return;
  class TestDOMMatrix {}
  Object.defineProperty(globalThis, "DOMMatrix", {
    configurable: true,
    value: TestDOMMatrix,
  });
}

function visiblePageNode(pageId: string): HTMLElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: 500,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  scroller.getBoundingClientRect = () =>
    rect({ top: 0, bottom: 500, left: 0, right: 600 });

  const page = document.createElement("div");
  page.dataset.shioriPageId = pageId;
  page.getBoundingClientRect = () =>
    rect({ top: 100, bottom: 300, left: 80, right: 480 });
  scroller.append(page);
  return scroller;
}

function rect({
  top,
  bottom,
  left,
  right,
}: {
  top: number;
  bottom: number;
  left: number;
  right: number;
}): DOMRect {
  return {
    top,
    bottom,
    left,
    right,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}
