import "../../test/setupDom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { setAppPdfEngineForTest } from "../../pdf/engine/appEngine";
import { fakePdfDocument, fakePdfEngine } from "../../test/fakePdfEngine";
import { useEditorStore } from "../store/store";
import { OutlinePanel } from "./OutlinePanel";

const initialStore = useEditorStore.getState();
let restoreEngine: (() => void) | null = null;

describe("OutlinePanel navigation targets", () => {
  beforeEach(async () => {
    cleanup();
    document.body.replaceChildren();
    useEditorStore.setState(initialStore, true);
    useEditorStore.setState({
      model: {
        pages: [
          {
            id: "page-1",
            sourceIndex: 0,
            rotation: 0,
            widthPt: 612,
            heightPt: 792,
          },
        ],
        overlays: [],
      },
      activePageId: "page-1",
    });
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    restoreEngine?.();
    restoreEngine = null;
    cleanup();
    document.body.replaceChildren();
    useEditorStore.setState(initialStore, true);
  });

  test("makes outline leaves non-interactive when their page was deleted", async () => {
    // Two entries; "Methods" points at the second page, which the model no
    // longer has.
    const doc = fakePdfDocument();
    restoreEngine = setAppPdfEngineForTest(
      fakePdfEngine({
        pageCount: () => 2,
        outline: async () => [
          { title: "Introduction", destination: { pageIndex: 0, view: "Fit", args: [] }, children: [] },
          { title: "Methods", destination: { pageIndex: 1, view: "Fit", args: [] }, children: [] },
        ],
      }),
    );

    const view = render(<OutlinePanel doc={doc} />);

    expect(await view.findByRole("button", { name: /Introduction/ })).toBeTruthy();
    await waitFor(() => {
      const staleLabel = view.getByText("Methods").parentElement;
      expect(view.getByRole("link", { name: /Methods/ })).toBe(staleLabel);
      expect(staleLabel?.getAttribute("tabindex")).toBe("0");
      expect(staleLabel?.getAttribute("aria-disabled")).toBe("true");
      const descriptionId = staleLabel?.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      const tooltip = descriptionId
        ? document.getElementById(descriptionId)
        : null;
      expect(tooltip?.getAttribute("role")).toBe("tooltip");
      expect(tooltip?.textContent).toBe(
        "The target page is no longer in this document",
      );
      expect(tooltip?.style.position).toBe("absolute");
      if (staleLabel) fireEvent.mouseEnter(staleLabel);
      expect(tooltip?.style.position).toBe("fixed");
      if (staleLabel) fireEvent.mouseLeave(staleLabel);
      expect(tooltip?.style.position).toBe("absolute");
      if (staleLabel) fireEvent.focus(staleLabel);
      expect(tooltip?.style.position).toBe("fixed");
      expect(view.queryByRole("button", { name: /Methods/ })).toBeNull();
    });
  });
});
