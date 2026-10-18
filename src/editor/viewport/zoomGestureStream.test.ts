import { describe, expect, test } from "bun:test";
import { fakeClock } from "../../test/fakeClock";
import {
  createZoomGestureStream,
  ZOOM_GESTURE_TIMING,
  type ZoomGestureOptions,
  type ZoomGesturePorts,
} from "./zoomGestureStream";

// What can go wrong between raw zoom input and preview / commit:
// - Chromium sends a trackpad pinch as ctrl+wheel only: each delta must
//   preview from the latest visual scale and the stream commit once, after
//   it falls quiet (250 ms);
// - macOS WebKit wraps those wheels in a gesturestart … gestureend bracket:
//   the wheels still drive, the bracket's end commits after a short settle
//   (140 ms) and inside the bracket the quiet period is only a fail-safe
//   (900 ms);
// - WebKit may also send scaled gesturechanges: once one drives, wheel
//   deltas describe the same fingers and must not stack on top;
// - iOS sends gesturechange scales relative to the bracket's start, and the
//   fingers may drift beyond the view while the bracket is open;
// - the bracket never closes (focus leaves mid-pinch): the 900 ms fail-safe
//   must commit;
// - the momentum tail after gestureend must fold into one commit, not two;
// - a touch pinch (Android) commits as the fingers lift; should its end be
//   lost, a watchdog must commit (3 s on the PDF canvas);
// - a stranded finger: the touch tracker reports no pinch, nothing happens;
// - double tap: two real taps (short, still) close in time and space; a
//   slow tap, a moved tap, a far second tap, a tap on a control, a tap
//   while a preview or tap zoom runs must not zoom;
// - ctrl+wheel or a gesture outside the view belongs to someone else;
// - unmount mid-gesture: timers stop and the preview is cancelled, nothing
//   commits afterwards.

type Log = string[];

function harness(options: Partial<ZoomGestureOptions> = {}, start = { visual: 1, base: 1 }) {
  const clock = fakeClock();
  const log: Log = [];
  let visual = start.visual;
  let base = start.base;
  let busy = false;
  const opened: string[] = [];
  const ports: ZoomGesturePorts = {
    preview: (point, scale) => {
      visual = scale;
      log.push(`preview ${point.x},${point.y} ${round(scale)}`);
    },
    commit: () => {
      log.push(`commit ${round(visual)}`);
      base = visual;
    },
    cancel: () => log.push("cancel"),
    visualScale: () => visual,
    openGesture: (point) => {
      opened.push(point ? `${point.x},${point.y}` : "-");
      return base;
    },
    restingScale: () => base,
    isBusy: () => busy,
    doubleTap: (point) => log.push(`doubleTap ${point.x},${point.y}`),
    clock,
  };
  const stream = createZoomGestureStream(ports, options);
  return {
    stream,
    clock,
    log,
    opened,
    setBusy: (next: boolean) => {
      busy = next;
    },
    setBase: (next: number) => {
      base = next;
    },
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const at = { x: 100, y: 200 };
const outside = { x: 900, y: 900 };
const wheelIn = (deltaY: number) => ({ type: "wheel", factor: Math.exp(-deltaY * 0.005), point: at, inside: true }) as const;

describe("zoomGestureStream: ctrl+wheel (Chromium)", () => {
  test("each delta previews from the latest visual scale; one commit after the stream falls quiet", () => {
    const h = harness();
    expect(h.stream.handle(wheelIn(-20))).toBe(true);
    h.clock.advance(100);
    expect(h.stream.handle(wheelIn(-20))).toBe(true);
    h.clock.advance(ZOOM_GESTURE_TIMING.wheelSettleMs - 1);
    expect(h.log).toEqual(["preview 100,200 1.105", "preview 100,200 1.221"]);
    h.clock.advance(1);
    expect(h.log.at(-1)).toBe("commit 1.221");
    expect(h.log.filter((entry) => entry.startsWith("commit"))).toHaveLength(1);
  });

  test("a wheel outside the view is not consumed and does nothing", () => {
    const h = harness();
    expect(h.stream.handle({ type: "wheel", factor: 1.2, point: outside, inside: false })).toBe(false);
    h.clock.advance(5_000);
    expect(h.log).toEqual([]);
  });

  test("a factor that is not a positive number is consumed but ignored", () => {
    const h = harness();
    expect(h.stream.handle({ type: "wheel", factor: Number.NaN, point: at, inside: true })).toBe(true);
    expect(h.stream.handle({ type: "wheel", factor: 0, point: at, inside: true })).toBe(true);
    h.clock.advance(5_000);
    expect(h.log).toEqual([]);
  });
});

describe("zoomGestureStream: WebKit gesture bracket", () => {
  test("macOS: wheels inside the bracket drive, gestureend commits after a short settle", () => {
    const h = harness();
    expect(h.stream.handle({ type: "gestureStart", point: at, inside: true })).toBe(true);
    h.stream.handle(wheelIn(-20));
    // Inside the bracket the quiet period is only a fail-safe.
    h.clock.advance(ZOOM_GESTURE_TIMING.wheelSettleMs + 50);
    expect(h.log).toEqual(["preview 100,200 1.105"]);
    expect(h.stream.handle({ type: "gestureEnd", inside: true })).toBe(true);
    h.clock.advance(ZOOM_GESTURE_TIMING.gestureEndSettleMs - 1);
    expect(h.log).toHaveLength(1);
    h.clock.advance(1);
    expect(h.log.at(-1)).toBe("commit 1.105");
  });

  test("the momentum tail after gestureend folds into the same single commit", () => {
    const h = harness();
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    h.stream.handle(wheelIn(-20));
    h.stream.handle({ type: "gestureEnd", inside: true });
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(30);
      h.stream.handle(wheelIn(-4));
    }
    h.clock.advance(5_000);
    expect(h.log.filter((entry) => entry.startsWith("commit"))).toEqual(["commit 1.221"]);
  });

  test("once a scaled gesturechange drives, wheel deltas do not stack on it", () => {
    const h = harness();
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    expect(h.stream.handle({ type: "gestureChange", scale: 1.5, point: at, inside: true })).toBe(true);
    // Still consumed, so the page does not scroll, but not applied.
    expect(h.stream.handle(wheelIn(-40))).toBe(true);
    h.stream.handle({ type: "gestureEnd", inside: true });
    h.clock.advance(5_000);
    expect(h.log).toEqual(["preview 100,200 1.5", "commit 1.5"]);
  });

  test("gesturechange scales are relative to the scale when the bracket opened", () => {
    const h = harness({}, { visual: 2, base: 2 });
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    h.stream.handle({ type: "gestureChange", scale: 1.1, point: at, inside: true });
    h.stream.handle({ type: "gestureChange", scale: 1.2, point: at, inside: true });
    expect(h.log).toEqual(["preview 100,200 2.2", "preview 100,200 2.4"]);
  });

  test("the next bracket drives with wheels again", () => {
    const h = harness();
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    h.stream.handle({ type: "gestureChange", scale: 1.5, point: at, inside: true });
    h.stream.handle({ type: "gestureEnd", inside: true });
    h.clock.advance(5_000);
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    h.stream.handle(wheelIn(-20));
    expect(h.log.at(-1)).toBe("preview 100,200 1.658");
  });

  test("the bracket and the pinch open the view's gesture where they start", () => {
    const h = harness();
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    h.stream.handle({ type: "gestureChange", scale: 1.2, point: { x: 120, y: 220 }, inside: true });
    h.stream.handle({ type: "gestureEnd", inside: true });
    h.stream.handle({ type: "gestureStart", point: null, inside: true });
    h.stream.handle({ type: "pinchStart", midpoint: { x: 50, y: 60 } });
    h.stream.handle({ type: "pinchMove", midpoint: { x: 55, y: 60 }, ratio: 1.1 });
    expect(h.opened).toEqual(["100,200", "-", "50,60"]);
  });

  test("iOS: the fingers may drift beyond the view while the bracket is open", () => {
    const h = harness();
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    expect(h.stream.handle({ type: "gestureChange", scale: 1.3, point: outside, inside: false })).toBe(true);
    expect(h.stream.handle({ type: "gestureEnd", inside: false })).toBe(true);
    h.clock.advance(5_000);
    expect(h.log).toEqual(["preview 900,900 1.3", "commit 1.3"]);
  });

  test("a bracket that opens outside the view belongs to someone else", () => {
    const h = harness();
    expect(h.stream.handle({ type: "gestureStart", point: outside, inside: false })).toBe(false);
    expect(h.stream.handle({ type: "gestureChange", scale: 1.3, point: outside, inside: false })).toBe(false);
    expect(h.stream.handle({ type: "gestureEnd", inside: false })).toBe(false);
    h.clock.advance(5_000);
    expect(h.log).toEqual([]);
  });

  test("a gesturechange without a bracket still zooms over the view", () => {
    const h = harness();
    expect(h.stream.handle({ type: "gestureChange", scale: 1.25, point: at, inside: true })).toBe(true);
    h.clock.advance(ZOOM_GESTURE_TIMING.bracketFailSafeMs);
    expect(h.log).toEqual(["preview 100,200 1.25", "commit 1.25"]);
  });

  test("a bracket whose end never arrives commits after the fail-safe", () => {
    const h = harness();
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    h.stream.handle({ type: "gestureChange", scale: 1.5, point: at, inside: true });
    h.clock.advance(ZOOM_GESTURE_TIMING.bracketFailSafeMs - 1);
    expect(h.log).toEqual(["preview 100,200 1.5"]);
    h.clock.advance(1);
    expect(h.log).toEqual(["preview 100,200 1.5", "commit 1.5"]);
    h.stream.handle({ type: "wheel", factor: 2, point: at, inside: true });
    expect(h.log.at(-1)).toBe("preview 100,200 3");
    h.clock.advance(ZOOM_GESTURE_TIMING.bracketFailSafeMs);
    expect(h.log.at(-1)).toBe("commit 3");
  });

  test("a gesturechange without a usable scale is ignored", () => {
    const h = harness();
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    expect(h.stream.handle({ type: "gestureChange", scale: null, point: at, inside: true })).toBe(false);
    expect(h.stream.handle({ type: "gestureChange", scale: 0, point: at, inside: true })).toBe(false);
    // Wheels still drive: nothing proved the gesture's own scale drives.
    h.stream.handle(wheelIn(-20));
    expect(h.log).toEqual(["preview 100,200 1.105"]);
  });

  test("gesturestart stops a wheel settle that would commit under the new gesture", () => {
    const h = harness();
    h.stream.handle(wheelIn(-20));
    h.clock.advance(200);
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    h.clock.advance(ZOOM_GESTURE_TIMING.wheelSettleMs);
    expect(h.log).toEqual(["preview 100,200 1.105"]);
  });
});

describe("zoomGestureStream: touch pinch", () => {
  test("previews from the scale at pinch start and commits as the fingers lift", () => {
    const h = harness({}, { visual: 1, base: 1 });
    h.stream.handle({ type: "pinchStart", midpoint: at });
    h.stream.handle({ type: "pinchMove", midpoint: at, ratio: 1.5 });
    h.stream.handle({ type: "pinchMove", midpoint: { x: 110, y: 200 }, ratio: 2 });
    h.stream.handle({ type: "pinchEnd" });
    expect(h.log).toEqual(["preview 100,200 1.5", "preview 110,200 2", "commit 2"]);
    h.clock.advance(10_000);
    expect(h.log).toHaveLength(3);
  });

  test("with a watchdog, a pinch whose end is lost commits once the fingers go quiet", () => {
    const h = harness({ pinchWatchdogMs: ZOOM_GESTURE_TIMING.pinchWatchdogMs });
    h.stream.handle({ type: "pinchStart", midpoint: at });
    h.stream.handle({ type: "pinchMove", midpoint: at, ratio: 1.5 });
    h.clock.advance(2_000);
    h.stream.handle({ type: "pinchMove", midpoint: at, ratio: 1.6 });
    h.clock.advance(ZOOM_GESTURE_TIMING.pinchWatchdogMs - 1);
    expect(h.log.filter((entry) => entry.startsWith("commit"))).toEqual([]);
    h.clock.advance(1);
    expect(h.log.at(-1)).toBe("commit 1.6");
  });

  test("without a watchdog nothing commits until the fingers lift", () => {
    const h = harness({ pinchWatchdogMs: null });
    h.stream.handle({ type: "pinchStart", midpoint: at });
    h.stream.handle({ type: "pinchMove", midpoint: at, ratio: 1.5 });
    h.clock.advance(60_000);
    expect(h.log).toEqual(["preview 100,200 1.5"]);
  });

  test("a pinch start stops a wheel settle that would commit under it", () => {
    const h = harness({ pinchWatchdogMs: null });
    h.stream.handle(wheelIn(-20));
    h.stream.handle({ type: "pinchStart", midpoint: at });
    h.clock.advance(5_000);
    expect(h.log).toEqual(["preview 100,200 1.105"]);
  });

  test("the pinch base is read when the pinch starts, not per move", () => {
    const h = harness();
    h.stream.handle({ type: "pinchStart", midpoint: at });
    h.setBase(3);
    h.stream.handle({ type: "pinchMove", midpoint: at, ratio: 2 });
    expect(h.log).toEqual(["preview 100,200 2"]);
  });

  test("a pinch end or move without a pinch is not consumed and lands nothing", () => {
    const h = harness();
    expect(h.stream.handle({ type: "pinchMove", midpoint: at, ratio: 2 })).toBe(false);
    expect(h.stream.handle({ type: "pinchEnd" })).toBe(false);
    expect(h.log).toEqual([]);
  });
});

describe("zoomGestureStream: double tap", () => {
  const tap = (h: ReturnType<typeof harness>, start: number, point = at, options: { heldMs?: number; moved?: number; eligible?: boolean } = {}) => {
    h.stream.handle({ type: "touchStart", touches: 1, point, at: start });
    h.stream.handle({
      type: "touchEnd",
      remaining: 0,
      changed: 1,
      point: { x: point.x + (options.moved ?? 0), y: point.y },
      at: start + (options.heldMs ?? 40),
      eligible: options.eligible ?? true,
    });
  };

  test("two quick still taps close together zoom at the second tap", () => {
    const h = harness({ doubleTap: true });
    tap(h, 1_000);
    tap(h, 1_200, { x: 110, y: 205 });
    expect(h.log).toEqual(["doubleTap 110,205"]);
  });

  test("taps further apart in time are two single taps", () => {
    const h = harness({ doubleTap: true });
    tap(h, 1_000);
    tap(h, 1_800);
    expect(h.log).toEqual([]);
  });

  test("a second tap beyond the slop is a new first tap", () => {
    const h = harness({ doubleTap: true });
    tap(h, 1_000);
    tap(h, 1_150, { x: 200, y: 200 });
    tap(h, 1_300, { x: 205, y: 200 });
    expect(h.log).toEqual(["doubleTap 205,200"]);
  });

  test("a held touch is not a tap", () => {
    const h = harness({ doubleTap: true });
    tap(h, 1_000, at, { heldMs: 400 });
    tap(h, 1_450);
    expect(h.log).toEqual([]);
  });

  test("a moved touch is not a tap and breaks the pair", () => {
    const h = harness({ doubleTap: true });
    tap(h, 1_000);
    tap(h, 1_080, at, { moved: 20 });
    // Close enough to the first tap, had the moved touch not broken the pair.
    tap(h, 1_200);
    expect(h.log).toEqual([]);
  });

  test("a tap on a control or outside the view breaks the pair", () => {
    const h = harness({ doubleTap: true });
    tap(h, 1_000);
    tap(h, 1_080, at, { eligible: false });
    tap(h, 1_200);
    expect(h.log).toEqual([]);
  });

  test("a second finger is not a tap", () => {
    const h = harness({ doubleTap: true });
    tap(h, 1_000);
    h.stream.handle({ type: "touchStart", touches: 2, point: at, at: 1_100 });
    h.stream.handle({ type: "touchEnd", remaining: 1, changed: 1, point: at, at: 1_140, eligible: true });
    h.stream.handle({ type: "touchEnd", remaining: 0, changed: 1, point: at, at: 1_160, eligible: true });
    expect(h.log).toEqual([]);
  });

  test("a double tap while a preview or a tap zoom runs is ignored", () => {
    const h = harness({ doubleTap: true });
    h.setBusy(true);
    tap(h, 1_000);
    tap(h, 1_150);
    expect(h.log).toEqual([]);
  });

  test("without double tap, taps do nothing", () => {
    const h = harness();
    tap(h, 1_000);
    tap(h, 1_150);
    expect(h.log).toEqual([]);
  });
});

describe("zoomGestureStream: teardown", () => {
  test("dispose mid-gesture cancels the preview and nothing commits afterwards", () => {
    const h = harness();
    h.stream.handle({ type: "gestureStart", point: at, inside: true });
    h.stream.handle({ type: "gestureChange", scale: 1.5, point: at, inside: true });
    h.stream.dispose();
    h.clock.advance(60_000);
    expect(h.log).toEqual(["preview 100,200 1.5", "cancel"]);
    expect(h.clock.pending()).toBe(0);
  });

  test("events after dispose are not consumed", () => {
    const h = harness();
    h.stream.dispose();
    expect(h.stream.handle(wheelIn(-20))).toBe(false);
    expect(h.log).toEqual(["cancel"]);
  });
});
