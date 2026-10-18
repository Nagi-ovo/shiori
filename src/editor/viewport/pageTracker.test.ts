import { describe, expect, test } from "bun:test";
import { createPageTracker, type PageBox, type PageTrackerPorts } from "./pageTracker";

// What can go wrong deriving the active page and gating programmatic scrolls:
// - nothing mounted (first frame, a document swap): no page may be made active;
// - the most visible page loses to one that is merely first or merely
//   touching the viewport; a page partly above the viewport must count only
//   its visible part;
// - a tie (zoomed out, several whole pages in view) flips between pages
//   from frame to frame instead of settling on one;
// - the active page is rewritten every frame although it did not change;
// - a smooth programmatic scroll marks each page it passes as active, so
//   the page the reader asked for bounces back to an earlier one;
// - the gate assumes downward travel and releases at once on an upward jump;
// - the gate never releases, or releases before the destination is reached;
// - a jump to a page not mounted yet releases before it mounts;
// - an instant jump (no animation) holds a gate no scroll frame will clear;
// - the target can never be the most visible page (the last page with the
//   scroll clamped short of it, pages tied at a small zoom), so a gate
//   waiting for it to win holds forever and the active page stops
//   following the reader;
// - the reader scrolls against a jump in flight (the browser drops the
//   animation) and the gate keeps waiting for a destination never reached;
// - fractional scroll positions jitter by a subpixel and read as the reader
//   moving away mid-jump;
// - a jump to where the viewport already is emits no scroll at all.

type Harness = {
  ports: PageTrackerPorts;
  boxes: PageBox[];
  scrollTop: number;
  active: string | null;
  writes: string[];
  scrolls: Array<{ top: number; smooth: boolean }>;
};

function harness(viewportHeight = 1000, active: string | null = "p0"): Harness {
  const h: Harness = {
    boxes: [],
    scrollTop: 0,
    active,
    writes: [],
    scrolls: [],
    ports: {
      viewportHeight: () => viewportHeight,
      scrollTop: () => h.scrollTop,
      pageBoxes: () => h.boxes,
      activePageId: () => h.active,
      setActivePage: (id) => {
        h.active = id;
        h.writes.push(id);
      },
      scrollTo: (top, smooth) => h.scrolls.push({ top, smooth }),
    },
  };
  return h;
}

/** The viewport at `scrollTop` over `count` pages of `column`. */
function scrollTo(h: Harness, scrollTop: number, count = 10, height = 800, gap = 40) {
  h.scrollTop = scrollTop;
  h.boxes = column(count, scrollTop, height, gap);
}

/** Pages `height` tall with `gap` between them, the viewport scrolled to `scrollTop`. */
function column(count: number, scrollTop: number, height = 800, gap = 40): PageBox[] {
  return Array.from({ length: count }, (_, index) => {
    const top = index * (height + gap) - scrollTop;
    return { id: `p${index}`, top, bottom: top + height };
  });
}

describe("pageTracker: active page from overlaps", () => {
  test("nothing mounted makes no page active", () => {
    const h = harness(1000, null);
    createPageTracker(h.ports).measure();
    expect(h.writes).toEqual([]);
  });

  test("the most visible page becomes active, counting only its visible part", () => {
    const h = harness();
    // p0 shows 300 px (its top is above the viewport), p1 its full 800.
    h.boxes = column(3, 500);
    createPageTracker(h.ports).measure();
    expect(h.writes).toEqual(["p1"]);
  });

  test("a page touching the viewport edge does not win over the page filling it", () => {
    const h = harness(1000, "p1");
    // p0 shows its last 200 px at the top, p1 the remaining 800.
    h.boxes = column(3, 800, 1000, 0);
    createPageTracker(h.ports).measure();
    expect(h.active).toBe("p1");
  });

  test("whole pages tied in view settle on the first", () => {
    const h = harness(1000, "p2");
    h.boxes = column(4, 0, 300, 20);
    const tracker = createPageTracker(h.ports);
    tracker.measure();
    tracker.measure();
    expect(h.writes).toEqual(["p0"]);
  });

  test("the active page is written only when it changes", () => {
    const h = harness(1000, "p1");
    h.boxes = column(3, 500);
    const tracker = createPageTracker(h.ports);
    tracker.measure();
    tracker.measure();
    expect(h.writes).toEqual([]);
  });
});

describe("pageTracker: programmatic scrolls", () => {
  test("the target is active at once; pages passed on the way never are", () => {
    const h = harness(1000, "p0");
    scrollTo(h, 0);
    const tracker = createPageTracker(h.ports);
    tracker.navigate({ pageId: "p6", top: 6 * 840, smooth: true });
    expect(h.scrolls).toEqual([{ top: 6 * 840, smooth: true }]);
    expect(h.writes).toEqual(["p6"]);
    for (const scrollTop of [840, 2 * 840, 4 * 840]) {
      scrollTo(h, scrollTop);
      tracker.measure();
    }
    expect(h.writes).toEqual(["p6"]);
    scrollTo(h, 6 * 840);
    tracker.measure();
    // Arrival releases the gate; the next frame tracks the reader again.
    scrollTo(h, 7 * 840);
    tracker.measure();
    expect(h.writes).toEqual(["p6", "p7"]);
  });

  test("an upward jump holds until the target is reached", () => {
    const h = harness(1000, "p8");
    scrollTo(h, 8 * 840);
    const tracker = createPageTracker(h.ports);
    tracker.navigate({ pageId: "p2", top: 2 * 840, smooth: true });
    scrollTo(h, 6 * 840);
    tracker.measure();
    scrollTo(h, 4 * 840);
    tracker.measure();
    expect(h.writes).toEqual(["p2"]);
    scrollTo(h, 2 * 840);
    tracker.measure();
    scrollTo(h, 840);
    tracker.measure();
    expect(h.writes).toEqual(["p2", "p1"]);
  });

  test("a target not mounted yet holds the gate until it is", () => {
    const h = harness(1000, "p0");
    scrollTo(h, 0, 3);
    const tracker = createPageTracker(h.ports);
    tracker.navigate({ pageId: "p9", top: 9 * 840, smooth: true });
    h.boxes = h.boxes.slice(1);
    tracker.measure();
    expect(h.writes).toEqual(["p9"]);
  });

  test("an instant jump holds no gate", () => {
    const h = harness(1000, "p0");
    const tracker = createPageTracker(h.ports);
    tracker.navigate({ pageId: "p4", top: 4 * 840, smooth: false });
    expect(h.scrolls).toEqual([{ top: 4 * 840, smooth: false }]);
    scrollTo(h, 3 * 840);
    tracker.measure();
    expect(h.writes).toEqual(["p4", "p3"]);
  });

  test("a last page that never wins lets go once the reader scrolls away", () => {
    // Zoomed out: pages 300 tall, so at the clamped end of the column the
    // last three are whole in the 1000 px viewport and p5 wins the tie.
    const h = harness(1000, "p0");
    scrollTo(h, 0, 8, 300, 20);
    const maxScrollTop = 8 * 320 - 20 - 1000;
    const tracker = createPageTracker(h.ports);
    tracker.navigate({ pageId: "p7", top: 7 * 320, smooth: true });
    scrollTo(h, 800, 8, 300, 20);
    tracker.measure();
    scrollTo(h, maxScrollTop, 8, 300, 20);
    tracker.measure();
    // Arrived: the page asked for stays active although p5 shows as much.
    expect(h.active).toBe("p7");
    // The reader scrolls back up; the active page follows.
    scrollTo(h, 3 * 320, 8, 300, 20);
    tracker.measure();
    expect(h.active).toBe("p3");
  });

  test("scrolling against a jump in flight hands the page back to the reader", () => {
    const h = harness(1000, "p0");
    scrollTo(h, 0);
    const tracker = createPageTracker(h.ports);
    tracker.navigate({ pageId: "p6", top: 6 * 840, smooth: true });
    scrollTo(h, 3 * 840);
    tracker.measure();
    expect(h.active).toBe("p6");
    // The reader wheels back up; the animation is gone.
    scrollTo(h, 2 * 840);
    tracker.measure();
    expect(h.active).toBe("p2");
  });

  test("half-pixel jitter in a jump in flight does not count as moving away", () => {
    const h = harness(1000, "p0");
    scrollTo(h, 0);
    const tracker = createPageTracker(h.ports);
    tracker.navigate({ pageId: "p6", top: 6 * 840, smooth: true });
    scrollTo(h, 4 * 840);
    tracker.measure();
    scrollTo(h, 4 * 840 - 0.5);
    tracker.measure();
    expect(h.active).toBe("p6");
  });

  test("a jump to where the viewport already is holds no gate", () => {
    const h = harness(1000, "p0");
    scrollTo(h, 2 * 840);
    const tracker = createPageTracker(h.ports);
    tracker.navigate({ pageId: "p2", top: 2 * 840, smooth: true });
    scrollTo(h, 2 * 840 + 900);
    tracker.measure();
    expect(h.active).toBe("p3");
  });
});
