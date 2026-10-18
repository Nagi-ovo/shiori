import "../../test/setupDom";
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useEffect, useRef } from "react";
import { useScrollableZoomGestures } from "./documentViewerGestures";
import { getLiveZoomIndicator, setLiveZoomIndicator } from "./liveZoomIndicator";

// The text views (Markdown, plain text, HTML) zoom through
// useScrollableZoomGestures. These tests drive it the way the platforms do:
// - Chromium: ctrl+wheel only;
// - macOS WebKit: a gesturestart … gestureend bracket around ctrl+wheel
//   deltas, and a gesturechange that may or may not carry a scale;
// - iOS Safari: the bracket with gesturechange scales, the fingers free to
//   drift beyond the text view mid-pinch;
// - Android: a two-finger touch pinch.

// The hook tells its own events apart with `instanceof Node`, a global
// every browser has and the test DOM does not install.
const hadNode = "Node" in globalThis;
beforeAll(() => {
  if (!hadNode) Object.defineProperty(globalThis, "Node", { configurable: true, value: window.Node });
});
afterAll(() => {
  if (!hadNode) delete (globalThis as { Node?: unknown }).Node;
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function TextView({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const gestures = useScrollableZoomGestures(scrollerRef, 1, onZoomChange);
  useEffect(() => () => gestures.endGesture(), [gestures]);
  return (
    <div ref={scrollerRef} data-testid="scroller">
      <div data-testid="content">text</div>
    </div>
  );
}

function mount() {
  const changes: number[] = [];
  const view = render(<TextView onZoomChange={(zoom) => changes.push(zoom)} />);
  const scroller = view.getByTestId("scroller");
  Object.defineProperty(scroller, "getBoundingClientRect", {
    configurable: true,
    value: () => new window.DOMRect(0, 0, 800, 600),
  });
  const outside = document.createElement("div");
  document.body.append(outside);
  return { view, changes, content: view.getByTestId("content"), outside };
}

function gesture(target: EventTarget, type: string, at: { x: number; y: number }, scale?: number) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: at.x },
    clientY: { value: at.y },
    ...(scale === undefined ? {} : { scale: { value: scale } }),
  });
  target.dispatchEvent(event);
}

function ctrlWheel(target: EventTarget, deltaY: number) {
  const event = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
  // The test DOM drops these from the init dictionary.
  Object.defineProperties(event, {
    ctrlKey: { value: true },
    clientX: { value: 400 },
    clientY: { value: 300 },
  });
  target.dispatchEvent(event);
}

const settle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  });

describe("text view zoom gestures", () => {
  test("identity cleanup after teardown leaves the next view’s zoom indicator alone", async () => {
    const { view } = mount();
    view.unmount();
    setLiveZoomIndicator(2);
    await settle(200);
    expect(getLiveZoomIndicator()).toBe(2);
    setLiveZoomIndicator(null);
  });

  test("ignores ctrl+wheel deltas once the gesture's own scale drives the pinch", async () => {
    const { changes, content } = mount();
    const at = { x: 400, y: 300 };
    gesture(content, "gesturestart", at);
    gesture(content, "gesturechange", at, 1.5);
    // WKWebView also reports the same pinch as ctrl+wheel; applying both
    // stacked the factors and zoomed twice as far as the fingers did.
    ctrlWheel(content, -40);
    ctrlWheel(content, -40);
    gesture(content, "gestureend", at);
    await settle(400);
    expect(changes).toEqual([1.5]);
  });

  test("keeps following a pinch whose fingers drift beyond the text view", async () => {
    const { changes, content, outside } = mount();
    gesture(content, "gesturestart", { x: 400, y: 300 });
    gesture(outside, "gesturechange", { x: 900, y: 300 }, 1.3);
    gesture(outside, "gestureend", { x: 900, y: 300 });
    await settle(400);
    expect(changes).toEqual([1.3]);
  });

  test("a touch pinch commits as the fingers lift", () => {
    const { changes, content } = mount();
    const finger = (id: number, x: number) =>
      new window.Touch({ identifier: id, target: content, clientX: x, clientY: 300 });
    const fire = (type: string, fingers: Array<[number, number]>) =>
      act(() => {
        content.dispatchEvent(
          new window.TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: fingers.map(([id, x]) => finger(id, x)),
          }),
        );
      });
    fire("touchstart", [[1, 300]]);
    fire("touchstart", [
      [1, 300],
      [2, 500],
    ]);
    fire("touchmove", [
      [1, 250],
      [2, 550],
    ]);
    fire("touchend", [[1, 250]]);
    // No settle: a touch pinch has no momentum tail to fold in.
    expect(changes).toEqual([1.5]);
  });
});
