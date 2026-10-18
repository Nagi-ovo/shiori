/**
 * Which page the reader is on, derived from what the viewport shows, and the
 * one entry point for scrolling the column to a page.
 *
 * The active page is observed state: each scroll frame, the page with the
 * largest visible overlap becomes active (the first of a tie). Writing the
 * active page never scrolls; a jump goes through `navigate`, which marks the
 * target active at once and, while a smooth scroll carries the viewport
 * there, keeps the pages it passes from taking over. That gate is released
 * by where the viewport is, never by how long it took: when the target is
 * the page most in view, or on the first frame the viewport moves away
 * from the requested top instead of closing in on it. A smooth scroll only
 * ever closes in, so moving away means the reader took over (the browser
 * drops the animation) or the jump is over and the reader scrolls on. The
 * second rule is what frees a target that can never be most in view: the
 * last page with the column clamped short of it, or one tied with the page
 * above at a small zoom.
 */

/** A mounted page's vertical extent, in px from the viewport's top edge. */
export type PageBox = { id: string; top: number; bottom: number };

export type PageTrackerPorts = {
  viewportHeight(): number;
  scrollTop(): number;
  /** Mounted pages in document order. */
  pageBoxes(): PageBox[];
  activePageId(): string | null;
  setActivePage(id: string): void;
  scrollTo(top: number, smooth: boolean): void;
};

export type PageNavigation = {
  pageId: string;
  /** The scrollTop that brings the page (or its destination) into place. */
  top: number;
  /** Animated; an instant scroll needs no gate. */
  smooth: boolean;
};

export type PageTracker = {
  /** One scroll frame: follow the reader, or hold for a jump in flight. */
  measure(): void;
  navigate(navigation: PageNavigation): void;
};

export function createPageTracker(ports: PageTrackerPorts): PageTracker {
  /** A smooth jump in flight: its page, its top and its closest approach. */
  let gate: { pageId: string; top: number; distance: number } | null = null;

  const mostVisible = (): string | null => {
    const height = ports.viewportHeight();
    let best: string | null = null;
    let bestOverlap = 0;
    for (const box of ports.pageBoxes()) {
      const overlap = Math.min(height, box.bottom) - Math.max(0, box.top);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = box.id;
      }
    }
    return best;
  };

  return {
    measure() {
      const best = mostVisible();
      if (best === null) return;
      if (gate !== null) {
        const distance = Math.abs(ports.scrollTop() - gate.top);
        if (best === gate.pageId) {
          gate = null;
          return;
        }
        // A pixel of slack: fractional scroll positions jitter.
        if (distance <= gate.distance + 1) {
          gate.distance = Math.min(gate.distance, distance);
          return;
        }
        // Moving away: the reader's scroll from here on.
        gate = null;
      }
      if (best !== ports.activePageId()) ports.setActivePage(best);
    },
    navigate({ pageId, top, smooth }) {
      if (pageId !== ports.activePageId()) ports.setActivePage(pageId);
      const distance = Math.abs(ports.scrollTop() - top);
      gate = smooth && distance > 1 ? { pageId, top, distance } : null;
      ports.scrollTo(top, smooth);
    },
  };
}
