// Full-page scroll hijacking — fullPage.js-style. Each child becomes a
// "page" sized to the viewport (minus the 60px sticky nav). Wheel,
// keyboard, and touch input are intercepted; a single gesture advances
// exactly one page. The transform between pages is a framer-motion
// spring so it feels weighted, never abrupt.
//
// This deliberately overrides native scrolling — it's an aesthetic
// trade-off made on purpose. We mitigate the usual
// fullPage downsides:
//   - Phones / touch devices fall back to native scroll (input is
//     already a momentum gesture there; layered hijack feels jittery).
//   - Reduced-motion users fall back to native scroll.
//   - Anchor links (`#download` etc.) are intercepted and translated
//     into a goTo(pageIndex) jump so internal nav still works.
//   - Inputs / textareas escape the keyboard hijack (you can still
//     type without space-barring to the next page).
//   - Right-side dot indicators give the user a visible page model and
//     a way to jump directly.

import {
  Children,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useLang } from "../i18n/context";

type Props = {
  children: ReactNode;
};

// Spring tuned for a "weighted glide" — premium without overshoot.
const SPRING = {
  type: "spring" as const,
  stiffness: 110,
  damping: 26,
  mass: 0.85,
};

// Throttle wheel + touch so a single scroll gesture advances one page,
// not five. Trackpads especially fire dozens of wheel events per
// gesture — without this lock the page would skip.
const GESTURE_LOCK_MS = 800;

// Touch swipe threshold in px before counting as a page change.
const TOUCH_THRESHOLD = 60;

// Nav height (sticky) the page area sits below.
const NAV_OFFSET = 60;

export function PageScroller({ children }: Props) {
  const pages = Children.toArray(children);
  const total = pages.length;
  const [page, setPage] = useState(0);
  const lock = useRef(false);
  const reduce = useReducedMotion();
  const [desktopFinePointer, setDesktopFinePointer] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(min-width: 981px) and (pointer: fine)").matches,
  );
  const enabled = !reduce && desktopFinePointer;

  // Only enable hijacking on desktop with a fine pointer. Use a media
  // query so the hook re-evaluates if the user resizes / connects a
  // touchpad.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 981px) and (pointer: fine)");
    const sync = () => setDesktopFinePointer(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const goTo = useCallback(
    (next: number) => {
      if (lock.current) return;
      const target = Math.max(0, Math.min(total - 1, next));
      if (target === page) return;
      lock.current = true;
      setPage(target);
      window.setTimeout(() => {
        lock.current = false;
      }, GESTURE_LOCK_MS);
    },
    [page, total],
  );

  // Wheel + keyboard + touch hijack.
  useEffect(() => {
    if (!enabled) return;

    const onWheel = (e: WheelEvent) => {
      // Adaptive scroll handoff: if the cursor sits inside a scrollable
      // ancestor that isn't yet at its boundary (top going up, bottom
      // going down), let native scroll handle it. Only at the boundary
      // do we steal the wheel and advance the page.
      if (!shouldHijackWheel(e.target as Node, e.deltaY)) return;
      e.preventDefault();
      if (Math.abs(e.deltaY) < 4) return;
      goTo(page + (e.deltaY > 0 ? 1 : -1));
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable
      ) {
        return;
      }
      // Space activates a focused button. preventDefault-ing it here meant a
      // keyboard user tabbing to the theme toggle or the language menu pressed
      // Space and got a page scroll instead of the control — with no hint that
      // Enter was the only key that worked.
      if (
        t.closest?.(
          'button, a, select, summary, [role="button"], [role="menuitem"], [tabindex]:not([tabindex="-1"])',
        )
      ) {
        return;
      }
      switch (e.key) {
        case "ArrowDown":
        case "PageDown":
        case " ":
          e.preventDefault();
          goTo(page + 1);
          break;
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          goTo(page - 1);
          break;
        case "Home":
          e.preventDefault();
          goTo(0);
          break;
        case "End":
          e.preventDefault();
          goTo(total - 1);
          break;
      }
    };

    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const dy = touchStartY - e.changedTouches[0].clientY;
      if (Math.abs(dy) < TOUCH_THRESHOLD) return;
      goTo(page + (dy > 0 ? 1 : -1));
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [enabled, page, total, goTo]);

  // Land on the section named by the URL hash. `page` starts at 0 and was
  // never seeded from the hash, so arriving at /#download — from a doc page's
  // nav or footer link, or from the /download/<platform> redirect when no
  // installer matched — dropped the visitor on the hero with no explanation.
  // The click interceptor below only covers links pressed while this component
  // is already mounted.
  useEffect(() => {
    if (!enabled) return;
    const id = window.location.hash.slice(1);
    // `#/changelog` and friends are routes, not section anchors.
    if (!id || id.startsWith("/")) return;
    // Deferred to the next frame: the target section only exists once the
    // children have mounted, and reading layout then setting state in the same
    // effect body would cascade a second render before paint.
    const frame = requestAnimationFrame(() => {
      const targetEl = document.getElementById(id);
      const wrap = targetEl?.closest<HTMLElement>("[data-page-index]");
      if (!wrap) return;
      const idx = Number(wrap.dataset.pageIndex);
      if (!Number.isFinite(idx)) return;
      // Bypass goTo: it is gesture-locked and animates, and this is the
      // initial position rather than a navigation.
      setPage(idx);
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled]);

  // Translate same-page anchor link clicks into goTo jumps. Look up
  // which page contains the `#id` target via a data-page-index lookup.
  useEffect(() => {
    if (!enabled) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest("a");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("#") || href.length < 2) return;
      const id = href.slice(1);
      const targetEl = document.getElementById(id);
      if (!targetEl) return;
      const wrap = targetEl.closest<HTMLElement>("[data-page-index]");
      if (!wrap) return;
      const idx = Number(wrap.dataset.pageIndex);
      if (Number.isFinite(idx)) {
        e.preventDefault();
        goTo(idx);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [enabled, goTo]);

  // When hijacking is disabled (mobile / reduced motion), render pages
  // as a normal vertical stack so native scroll works as expected.
  if (!enabled) {
    return <>{pages}</>;
  }

  const pageHeight = `calc(100dvh - ${NAV_OFFSET}px)`;

  return (
    <div
      style={{
        position: "relative",
        height: pageHeight,
        overflow: "hidden",
      }}
    >
      <motion.div
        animate={{ y: `-${page * 100}%` }}
        transition={SPRING}
        style={{
          height: "100%",
          willChange: "transform",
        }}
      >
        {pages.map((child, i) => (
          <div
            key={i}
            data-page-index={i}
            inert={i !== page ? true : undefined}
            style={{
              height: pageHeight,
              overflow: "hidden",
            }}
          >
            {child}
          </div>
        ))}
      </motion.div>
      <PageDots total={total} current={page} onSelect={goTo} />
    </div>
  );
}

// Right-edge dot indicators. Click a dot to jump; the active dot grows.
function PageDots({
  total,
  current,
  onSelect,
}: {
  total: number;
  current: number;
  onSelect: (n: number) => void;
}) {
  const { t } = useLang();
  return (
    <nav
      aria-label={t.a11yPageNav}
      style={{
        position: "fixed",
        right: 22,
        top: "50%",
        transform: "translateY(-50%)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        zIndex: 40,
      }}
    >
      {Array.from({ length: total }, (_, i) => (
        <button
          key={i}
          type="button"
          aria-label={t.a11yPage.replace("{n}", String(i + 1))}
          aria-current={i === current ? "page" : undefined}
          onClick={() => onSelect(i)}
          className="page-dot"
          data-active={i === current ? "true" : undefined}
        />
      ))}
    </nav>
  );
}

// Decide whether the PageScroller should intercept a wheel event or
// hand it off to the browser's native scroll. Returns true (hijack)
// when there's no scrollable ancestor between the target and body, OR
// when there is one but it's already at the boundary in the direction
// the user wheeled. That way: tall sections still get internal scroll,
// but the user can keep wheeling past the edge to advance pages.
function shouldHijackWheel(node: Node | null, deltaY: number): boolean {
  let el: HTMLElement | null = (node as HTMLElement) || null;
  while (el && el !== document.body) {
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight
    ) {
      // At the edges we steal the wheel; mid-scroll we let native run.
      if (deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
        return true;
      }
      if (deltaY < 0 && el.scrollTop <= 0) {
        return true;
      }
      return false;
    }
    el = el.parentElement;
  }
  return true;
}
