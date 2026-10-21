import "../../../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { InkOverlay, Overlay, PageModel, RectOverlay } from "../../../pdf/model/types";
import { OverlaySvg } from "./overlaySvg";

// A translucent ink stroke or box imported from another reader (its /CA)
// draws translucent on the page, not opaque over the text under it.

const page: PageModel = { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 };

afterEach(cleanup);

function draw(overlay: Overlay, selected = false) {
  return render(
    <svg>
      <OverlaySvg overlay={overlay} page={page} scale={1} selected={selected} liveReveals={[]} />
    </svg>,
  ).container;
}

/** The opacity a shape is painted with: its own and its groups' multiplied. */
function paintedOpacity(element: Element | null): number {
  let opacity = 1;
  for (let node = element; node && node.tagName !== "svg"; node = node.parentElement) {
    const value = node.getAttribute("opacity");
    if (value !== null) opacity *= Number(value);
  }
  return opacity;
}

const ink: InkOverlay = {
  type: "ink", id: "ink", pageId: "p1", color: "#f4d674", width: 8,
  paths: [[{ x: 20, y: 600 }, { x: 120, y: 620 }], [{ x: 20, y: 580 }, { x: 120, y: 600 }]],
};
const box: RectOverlay = {
  type: "rect", id: "box", pageId: "p1", rect: { x: 20, y: 500, w: 100, h: 50 },
  color: "#b13a2e", strokeWidth: 2, fill: "#ffff00",
};

describe("an imported mark's opacity on screen", () => {
  test("an ink stroke draws at its opacity, its selection box does not", () => {
    const container = draw({ ...ink, opacity: 0.4 }, true);
    const strokes = [...container.querySelectorAll("path")];
    expect(strokes.map(paintedOpacity)).toEqual([0.4, 0.4]);
    expect(paintedOpacity(container.querySelector('rect[stroke-dasharray="4 3"]'))).toBe(1);
  });

  test("a box draws its stroke and fill at its opacity", () => {
    const container = draw({ ...box, opacity: 0.3 });
    expect(paintedOpacity(container.querySelector('rect[fill="#ffff00"]'))).toBe(0.3);
  });

  test("marks made in Shiori stay opaque", () => {
    expect(paintedOpacity(draw(ink).querySelector("path"))).toBe(1);
    expect(paintedOpacity(draw(box).querySelector('rect[fill="#ffff00"]'))).toBe(1);
  });
});
