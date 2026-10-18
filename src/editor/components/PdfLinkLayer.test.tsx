import "../../test/setupDom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { fakePdfDocument, withFakePdfEngine } from "../../test/fakePdfEngine";
import type { PageModel } from "../../pdf/model/types";
import { PdfLinkLayer } from "./PdfLinkLayer";

// Page 1 has a link to page 2, a link to a web page, and Next / Previous
// page links, as the engine reports them.
const doc = fakePdfDocument();
withFakePdfEngine({
  pageCount: () => 2,
  pageLinks: async () => [
    { rect: [72, 700, 200, 720], destination: { pageIndex: 1, view: "XYZ", args: [50, 600, null] }, url: null },
    { rect: [300, 100, 400, 150], destination: null, url: "https://example.com/" },
    { rect: [10, 10, 30, 30], destination: null, url: null, action: "NextPage" },
    { rect: [40, 10, 60, 30], destination: null, url: null, action: "PrevPage" },
  ],
});

const letter = (rotation: 0 | 90): PageModel => ({
  id: "p1",
  sourceIndex: 0,
  rotation,
  widthPt: 612,
  heightPt: 792,
});

function boxOf(section: HTMLElement) {
  const s = section.style;
  return [s.left, s.top, s.width, s.height].map((v) => Math.round(parseFloat(v)));
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("PdfLinkLayer", () => {
  test("places each link over its /Rect at the layer's scale", async () => {
    const view = render(
      <PdfLinkLayer doc={doc} page={letter(0)} scale={2} layerScale={2} onNavigate={() => {}} />,
    );
    await waitFor(() => expect(view.container.querySelectorAll("section")).toHaveLength(4));
    const [internal, web] = [...view.container.querySelectorAll<HTMLElement>("section")];
    // [72, 700, 200, 720] at 2×: left 144, top (792 − 720) × 2, 256 × 40.
    expect(boxOf(internal!)).toEqual([144, 144, 256, 40]);
    // [300, 100, 400, 150]: left 600, top (792 − 150) × 2.
    expect(boxOf(web!)).toEqual([600, 1284, 200, 100]);
  });

  test("a page whose box starts off the origin keeps its links on their text", async () => {
    const cropped = { ...letter(0), originXPt: 36, originYPt: 48, widthPt: 540, heightPt: 700 };
    const view = render(
      <PdfLinkLayer doc={doc} page={cropped} scale={1} layerScale={1} onNavigate={() => {}} />,
    );
    await waitFor(() => expect(view.container.querySelectorAll("section")).toHaveLength(4));
    const internal = view.container.querySelector<HTMLElement>("section")!;
    // x 72 − 36; top 700 − (720 − 48).
    expect(boxOf(internal)).toEqual([36, 28, 128, 20]);
  });

  test("a turned page turns its links with it", async () => {
    const view = render(
      <PdfLinkLayer doc={doc} page={letter(90)} scale={1} layerScale={1} onNavigate={() => {}} />,
    );
    await waitFor(() => expect(view.container.querySelectorAll("section")).toHaveLength(4));
    const internal = view.container.querySelector<HTMLElement>("section")!;
    // A quarter turn clockwise maps (x, y) to (y, x) on a 792 × 612 page:
    // x 72–200, y 700–720 becomes left 700, top 72, 20 × 128.
    expect(boxOf(internal)).toEqual([700, 72, 20, 128]);
  });

  test("a click on an internal link navigates to its destination", async () => {
    const onNavigate = mock(() => undefined);
    const view = render(
      <PdfLinkLayer doc={doc} page={letter(0)} scale={1} layerScale={1} onNavigate={onNavigate} />,
    );
    await waitFor(() => expect(view.container.querySelectorAll("a")).toHaveLength(4));
    const [internal, web] = [...view.container.querySelectorAll("a")];
    fireEvent.click(internal!);
    expect(onNavigate).toHaveBeenCalledWith({
      pageIndex: 1,
      destination: { pageIndex: 1, view: "XYZ", args: [50, 600, null] },
    });
    // The web link carries its URL for hover and keyboard users.
    expect(web!.getAttribute("href")).toBe("https://example.com/");
    expect(web!.getAttribute("title")).toBe("https://example.com/");
  });

  test("named actions go to the pages they name, relative to this one", async () => {
    const onNavigate = mock(() => undefined);
    const view = render(
      <PdfLinkLayer doc={doc} page={letter(0)} scale={1} layerScale={1} onNavigate={onNavigate} />,
    );
    await waitFor(() => expect(view.container.querySelectorAll("a")).toHaveLength(4));
    const [, , next, previous] = [...view.container.querySelectorAll("a")];
    fireEvent.click(next!);
    // From the first page, the previous page is still the first.
    fireEvent.click(previous!);
    expect(onNavigate.mock.calls).toEqual([
      [{ pageIndex: 1, destination: null }],
      [{ pageIndex: 0, destination: null }],
    ]);
  });
});

