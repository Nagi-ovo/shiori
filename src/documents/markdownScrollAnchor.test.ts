import "../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import { previewSourceLine, scrollPreviewToSourceLine } from "./markdownScrollAnchor";

// happy-dom has no layout, so each element reports the box it would have
// in a scroller whose content starts at y = 0 on screen.
function preview(blocks: Array<{ line: number; top: number; height: number }>) {
  const scroller = document.createElement("div");
  const body = document.createElement("div");
  scroller.append(body);
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
  for (const { line, top, height } of blocks) {
    const el = document.createElement("p");
    el.setAttribute("data-source-line", String(line));
    el.getBoundingClientRect = () =>
      ({ top: top - scroller.scrollTop, bottom: top + height - scroller.scrollTop, height }) as DOMRect;
    body.append(el);
  }
  return { scroller, body };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Markdown reading position by source line", () => {
  const layout = [
    { line: 1, top: 0, height: 40 }, // a heading on line 1
    { line: 3, top: 60, height: 200 }, // a code block on lines 3–12
    { line: 13, top: 280, height: 30 },
  ];

  test("reads the line at the top of the preview, through a tall block", () => {
    const { scroller, body } = preview(layout);
    scroller.scrollTop = 160; // halfway down the code block

    expect(previewSourceLine(scroller, body)).toBe(8);
  });

  test("scrolls the preview to a line, into the block that holds it", () => {
    const { scroller, body } = preview(layout);

    expect(scrollPreviewToSourceLine(scroller, body, 8)).toBe(true);
    expect(scroller.scrollTop).toBe(160);
    expect(previewSourceLine(scroller, body)).toBe(8);
  });

  test("a line past the last block lands on it", () => {
    const { scroller, body } = preview(layout);

    scrollPreviewToSourceLine(scroller, body, 40);
    expect(scroller.scrollTop).toBe(280 + 30);
  });

  test("waits for a rendered preview", () => {
    const { scroller, body } = preview([]);

    expect(previewSourceLine(scroller, body)).toBeNull();
    expect(scrollPreviewToSourceLine(scroller, body, 5)).toBe(false);
  });
});
