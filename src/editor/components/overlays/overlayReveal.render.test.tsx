import "../../../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type {
  CalloutOverlay,
  HighlightOverlay,
  PageModel,
  RectOverlay,
} from "../../../pdf/model/types";
import {
  prepareLiveOverlayRevealBatch,
  startLiveOverlayRevealBatch,
  type ActiveLiveOverlayReveal,
} from "../../../live/overlayReveal";
import { LiveRevealText } from "./LiveRevealText";
import { OverlaySvg } from "./overlaySvg";

const page: PageModel = {
  id: "page-a",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
  blank: false,
};

afterEach(cleanup);

describe("Live overlay reveal rendering", () => {
  test("mounts highlight and rectangle paint already hidden in their keyframes", () => {
    const highlight: HighlightOverlay = {
      type: "highlight",
      id: "highlight-a",
      pageId: page.id,
      rects: [{ x: 20, y: 700, w: 100, h: 14 }],
      color: "#f4d674",
      opacity: 0.45,
    };
    const rect: RectOverlay = {
      type: "rect",
      id: "rect-a",
      pageId: page.id,
      rect: { x: 20, y: 600, w: 100, h: 50 },
      color: "#b13a2e",
      strokeWidth: 2,
      fill: "#f4d674",
    };
    const prepared = prepareLiveOverlayRevealBatch("operation-a", [highlight, rect])!;
    const batch = startLiveOverlayRevealBatch(prepared, Date.now() + 100);
    const view = render(
      <svg>
        <OverlaySvg
          overlay={highlight}
          page={page}
          scale={1}
          selected
          liveReveals={[batch]}
        />
        <OverlaySvg
          overlay={rect}
          page={page}
          scale={1}
          selected
          liveReveals={[batch]}
        />
      </svg>,
    );
    expect(view.container.querySelectorAll('[data-live-reveal="highlight"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-live-reveal="rect"]')).toHaveLength(1);
    // Selection chrome stays absent during the sequence.
    expect(view.container.querySelectorAll('[stroke-dasharray="4 3"]')).toHaveLength(0);
  });

  test("typing keeps the complete Unicode text in the DOM from first paint", () => {
    const prepared = prepareLiveOverlayRevealBatch("operation-text", [
      {
        type: "text",
        id: "text-a",
        pageId: page.id,
        rect: { x: 20, y: 500, w: 160, h: 50 },
        text: "批注 A\u0301 👩‍💻",
        fontSize: 14,
        color: "#1a1815",
        bold: false,
        align: "left",
        fontFamily: "sans",
      },
    ])!;
    const batch = startLiveOverlayRevealBatch(prepared, 1_000);
    const item = prepared.itemsById.get("text-a")!;
    const reveal: ActiveLiveOverlayReveal = {
      batch,
      item,
      mountedAtMs: 1_000,
    };
    const view = render(
      <LiveRevealText text={"批注 A\u0301 👩‍💻"} reveal={reveal} />,
    );
    const root = view.container.querySelector("[data-live-reveal-text]");
    expect(root?.getAttribute("aria-label")).toBe("批注 A\u0301 👩‍💻");
    expect(root?.textContent).toBe("批注 A\u0301 👩‍💻");
    expect(root?.querySelectorAll("span").length).toBeGreaterThan(4);
  });

  test("complex-script text floats in as one shaping-safe node", () => {
    const text = "العربية हिन्दी ภาษาไทย";
    const overlay = {
      type: "text" as const,
      id: "text-complex",
      pageId: page.id,
      rect: { x: 20, y: 700, w: 200, h: 40 },
      text,
      fontSize: 12,
      color: "#222222",
      bold: false,
      align: "right" as const,
      fontFamily: "sans" as const,
    };
    const prepared = prepareLiveOverlayRevealBatch("complex-script", [overlay])!;
    const batch = startLiveOverlayRevealBatch(prepared, 1_000);
    const reveal: ActiveLiveOverlayReveal = {
      batch,
      item: prepared.itemsById.get(overlay.id)!,
      mountedAtMs: 1_000,
    };

    const view = render(<LiveRevealText text={text} reveal={reveal} />);
    const root = view.container.querySelector("[data-live-reveal-text]");
    expect(root?.getAttribute("data-live-reveal-mode")).toBe("whole");
    expect(root?.getAttribute("dir")).toBe("auto");
    expect(root?.textContent).toBe(text);
    expect(root?.querySelectorAll("span")).toHaveLength(0);
  });

  test("draws a callout target and leader as a handwriting trajectory", () => {
    const callout: CalloutOverlay = {
      type: "callout",
      id: "callout-a",
      pageId: page.id,
      targetRects: [{ x: 20, y: 700, w: 100, h: 14 }],
      rect: { x: 170, y: 670, w: 144, h: 54 },
      text: "批注 لماذا",
      fontSize: 12,
      color: "#b13a2e",
      bold: false,
      align: "left",
      fontFamily: "sans",
    };
    const prepared = prepareLiveOverlayRevealBatch("operation-callout", [callout])!;
    const batch = startLiveOverlayRevealBatch(prepared, Date.now() + 100);
    const view = render(
      <svg>
        <OverlaySvg
          overlay={callout}
          page={page}
          scale={1}
          selected
          liveReveals={[batch]}
        />
      </svg>,
    );
    const root = view.container.querySelector('[data-live-reveal="callout"]');
    expect(root).toBeTruthy();
  });
});
