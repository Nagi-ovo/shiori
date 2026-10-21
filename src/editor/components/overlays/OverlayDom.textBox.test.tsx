import "../../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../../i18n";
import type { PageModel, TextOverlay } from "../../../pdf/model/types";
import { useEditorStore } from "../../store/store";
import { OverlayDom } from "./OverlayDom";

const initialStore = useEditorStore.getState();
const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 };
const box: TextOverlay = {
  type: "text", id: "t", pageId: "p1", rect: { x: 40, y: 500, w: 200, h: 40 }, text: "Boxed",
  fontSize: 12, color: "#0000ff", bold: false, align: "left", fontFamily: "sans",
};

function draw(overlay: TextOverlay, { editing = false, scale = 1 } = {}) {
  return render(
    <OverlayDom
      overlay={overlay}
      page={page}
      scale={scale}
      selected={false}
      editing={editing}
      interactivePointerEvents="auto"
      onStartEdit={() => undefined}
      onCommitEdit={() => undefined}
      onPointerDown={() => undefined}
      onHandlePointerDown={() => undefined}
      onRotateHandlePointerDown={() => undefined}
      onMaybeSuppressEditDragBlur={() => false}
      now={0}
    />,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  useEditorStore.setState(initialStore, true);
});

describe("a text box imported with a fill, frame and opacity", () => {
  test("draws them the way the exported file does", () => {
    const view = draw({ ...box, fill: "#ffff99", borderWidth: 2, opacity: 0.6 }, { scale: 2 });
    const card = view.getByRole("group");
    expect(card.style.backgroundColor).toBe("rgba(255, 255, 153, 0.6)");
    // The frame is the text colour unless the box names its own, and scales with the page.
    expect(card.style.border).toBe("4px solid rgba(0, 0, 255, 0.6)");
    expect(view.getByText("Boxed").closest<HTMLElement>("[dir=auto]")!.style.color).toBe("rgba(0, 0, 255, 0.6)");
  });

  test("an opaque fill draws opaque, with its own frame colour", () => {
    const card = draw({ ...box, fill: "#ffff99", borderWidth: 1, borderColor: "#ff0000" }).getByRole("group");
    expect(card.style.backgroundColor).toBe("#ffff99");
    expect(card.style.border).toBe("1px solid #ff0000");
  });

  test("a box made in Shiori keeps its dashed guide and clear background", () => {
    const view = draw(box);
    const card = view.getByRole("group");
    expect(card.style.border).toBe("1px dashed rgba(26, 24, 21, 0.18)");
    expect(card.style.backgroundColor).toBe("transparent");
  });
});
