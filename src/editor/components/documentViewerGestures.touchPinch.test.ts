import "../../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import { attachTouchPinch } from "./documentViewerGestures";

type Finger = { id: number; x: number; y: number; target?: EventTarget };

function touch(finger: Finger, fallbackTarget: EventTarget) {
  return new window.Touch({
    identifier: finger.id,
    target: finger.target ?? fallbackTarget,
    clientX: finger.x,
    clientY: finger.y,
  });
}

function fire(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  fingers: Finger[],
  options: { cancelable?: boolean } = {},
) {
  const event = new window.TouchEvent(type, {
    bubbles: true,
    cancelable: options.cancelable ?? true,
    touches: fingers.map((finger) => touch(finger, target)),
  });
  target.dispatchEvent(event);
  return event;
}

function harness() {
  const scroller = document.createElement("div");
  const page = document.createElement("div");
  scroller.append(page);
  document.body.append(scroller);
  const calls: string[] = [];
  const detach = attachTouchPinch(scroller, {
    accepts: (target) =>
      Boolean(target && scroller.contains(target as Node)),
    onPinchStart: (midpoint) => calls.push(`start ${midpoint.x},${midpoint.y}`),
    onPinchMove: (midpoint, ratio) =>
      calls.push(`move ${midpoint.x},${midpoint.y} ${ratio.toFixed(2)}`),
    onPinchEnd: () => calls.push("end"),
  });
  return { scroller, page, calls, detach };
}

describe("attachTouchPinch", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("previews a two-finger pinch about the midpoint and commits on release", () => {
    const { page, calls, detach } = harness();
    fire(page, "touchstart", [{ id: 1, x: 100, y: 300 }]);
    fire(page, "touchstart", [
      { id: 1, x: 100, y: 300 },
      { id: 2, x: 300, y: 300 },
    ]);
    const move = fire(page, "touchmove", [
      { id: 1, x: 50, y: 300 },
      { id: 2, x: 350, y: 300 },
    ]);
    fire(page, "touchend", [{ id: 2, x: 350, y: 300 }]);
    fire(page, "touchend", []);

    expect(calls).toEqual(["start 200,300", "move 200,300 1.50", "end"]);
    // The pinch owns the fingers: the browser must not also pan the page.
    expect(move.defaultPrevented).toBe(true);
    detach();
  });

  test("a finger the browser never released cannot pair with the next swipe", () => {
    // The Android WebView failure: pointerup for finger 1 was delivered to a
    // node the Word engine had already replaced, so a pointer tracker kept
    // it forever and every later one-finger swipe became a "pinch" against
    // it. Touch Events report only the fingers actually on the glass.
    const { page, calls, detach } = harness();
    fire(page, "touchstart", [{ id: 1, x: 200, y: 850 }]);
    // No touchend for finger 1 ever reaches the scroller.
    for (let y = 700; y >= 300; y -= 100) {
      fire(page, y === 700 ? "touchstart" : "touchmove", [
        { id: 2, x: 200, y },
      ]);
    }
    fire(page, "touchend", []);

    expect(calls).toEqual([]);
    detach();
  });

  test("ignores fingers that landed outside the document", () => {
    const { scroller, page, calls, detach } = harness();
    const toolbar = document.createElement("div");
    document.body.append(toolbar);
    fire(page, "touchstart", [
      { id: 1, x: 100, y: 300 },
      { id: 2, x: 300, y: 60, target: toolbar },
    ]);
    fire(page, "touchmove", [
      { id: 1, x: 50, y: 300 },
      { id: 2, x: 350, y: 60, target: toolbar },
    ]);
    expect(calls).toEqual([]);
    expect(scroller.contains(toolbar)).toBe(false);
    detach();
  });

  test("a third finger ends the pinch instead of jumping the ratio", () => {
    const { page, calls, detach } = harness();
    fire(page, "touchstart", [
      { id: 1, x: 100, y: 300 },
      { id: 2, x: 300, y: 300 },
    ]);
    fire(page, "touchstart", [
      { id: 1, x: 100, y: 300 },
      { id: 2, x: 300, y: 300 },
      { id: 3, x: 300, y: 600 },
    ]);
    fire(page, "touchmove", [
      { id: 1, x: 100, y: 300 },
      { id: 2, x: 400, y: 300 },
      { id: 3, x: 300, y: 600 },
    ]);
    expect(calls).toEqual(["start 200,300", "end"]);
    detach();
  });

  test("detaching stops tracking", () => {
    const { page, calls, detach } = harness();
    detach();
    fire(page, "touchstart", [
      { id: 1, x: 100, y: 300 },
      { id: 2, x: 300, y: 300 },
    ]);
    fire(page, "touchmove", [
      { id: 1, x: 50, y: 300 },
      { id: 2, x: 350, y: 300 },
    ]);
    expect(calls).toEqual([]);
  });
});
